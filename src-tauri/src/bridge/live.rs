use super::*;
use rusqlite::OptionalExtension;
use serde_json::json;
use std::time::Instant;
use tauri::State;

const HEARTBEAT: Duration = Duration::from_secs(10);
const LIFETIME: Duration = Duration::from_secs(8 * 3600);
const RUN_TIMEOUT: Duration = Duration::from_secs(120);
const PAIR_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Default)]
pub struct Live(Mutex<Option<Arc<Mutex<Option<Session>>>>>);

struct Session {
    origin: String,
    world: String,
    key: String,
    identity: Option<(String, String)>,
    deadline: Instant,
    heartbeat: Option<Instant>,
    operation: Option<Operation>,
    pairing_issue: Option<&'static str>,
}

struct Operation {
    script_id: String,
    queued_at: Instant,
    write_authorized: bool,
    deadline: Instant,
    request: Snapshot,
}

impl Session {
    fn expire(&mut self, library: &Library, now: Instant) {
        let offline = self
            .heartbeat
            .is_none_or(|last| now.saturating_duration_since(last) >= HEARTBEAT);
        if let Some(op) = self.operation.as_mut() {
            if now >= op.deadline
                || (op.request.status == "waiting" && (offline || now >= self.deadline))
            {
                let status = match op.request.status {
                    "waiting" => "expired",
                    "claimed" => "unknown",
                    _ => return,
                };
                if persist_report(library, &op.request, status, None).is_ok() {
                    op.request.status = status;
                } else {
                    op.request.persistence_error =
                        Some("SQLite не сохранила состояние операции".into());
                }
            }
        }
    }

    fn status(&self, now: Instant) -> &'static str {
        if now >= self.deadline {
            "expired"
        } else if self.identity.is_none() {
            "pairing"
        } else if self
            .heartbeat
            .is_some_and(|last| now.saturating_duration_since(last) < HEARTBEAT)
        {
            "connected"
        } else {
            "offline"
        }
    }

    fn handle(
        &mut self,
        message: &Value,
        library: &Library,
        now: Instant,
    ) -> (StatusCode, Option<Value>) {
        if now >= self.deadline {
            return (StatusCode::FORBIDDEN, None);
        }
        if message["worldId"] != self.world {
            if self.identity.is_none() && message["action"] == "pair" {
                self.pairing_issue = Some("worldMismatch");
                return (
                    StatusCode::FORBIDDEN,
                    Some(json!({"reason":"worldMismatch"})),
                );
            }
            return (StatusCode::FORBIDDEN, None);
        }
        let identity = message["serverId"].as_str().filter(|id| valid_id(id)).zip(
            message["userId"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 128),
        );
        let Some((server, user)) = identity else {
            return (StatusCode::BAD_REQUEST, None);
        };
        if let Some((known_server, known_user)) = &self.identity {
            if (known_server.as_str(), known_user.as_str()) != (server, user) {
                return (StatusCode::FORBIDDEN, None);
            }
        } else if message["action"] == "pair" {
            if message["identityKind"] != "world-v1" {
                self.pairing_issue = Some("bridgeVersion");
                return (
                    StatusCode::FORBIDDEN,
                    Some(json!({"reason":"bridgeVersion"})),
                );
            }
            let Ok(db) = library.0.lock() else {
                return (StatusCode::INTERNAL_SERVER_ERROR, None);
            };
            let pinned = db.execute(
                "INSERT INTO bridge_world_identity(origin,world_id,identity)
                 SELECT ?1,?2,?3
                 WHERE EXISTS(SELECT 1 FROM bridge_world_identity WHERE origin=?1 AND world_id=?2)
                    OR NOT EXISTS(SELECT 1 FROM bridge_identity WHERE origin=?1 AND server_id IS NOT ?4)
                 ON CONFLICT(origin,world_id) DO UPDATE SET identity=excluded.identity WHERE identity=excluded.identity",
                rusqlite::params![self.origin, self.world, server, message["legacyProfileId"].as_str()],
            );
            match pinned {
                Ok(1) => {}
                Ok(_) => {
                    self.pairing_issue = Some("profileMismatch");
                    return (
                        StatusCode::FORBIDDEN,
                        Some(json!({"reason":"profileMismatch"})),
                    );
                }
                Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, None),
            }
            let Ok(active_token) = random_token() else {
                return (StatusCode::INTERNAL_SERVER_ERROR, None);
            };
            self.pairing_issue = None;
            self.key = format!("Bearer {active_token}");
            self.identity = Some((server.to_owned(), user.to_owned()));
            self.deadline = now + LIFETIME;
            self.heartbeat = Some(now);
            return (StatusCode::OK, Some(json!({"token":active_token})));
        } else {
            return (StatusCode::FORBIDDEN, None);
        }
        self.expire(library, now);
        self.heartbeat = Some(now);
        match message["action"].as_str() {
            Some("revoke") => {
                self.deadline = now;
                if let Some(op) = self.operation.as_mut() {
                    op.deadline = now;
                }
                self.expire(library, now);
                (StatusCode::NO_CONTENT, None)
            }
            Some("heartbeat") => (StatusCode::NO_CONTENT, None),
            Some("poll") => {
                if let Some(op) = self
                    .operation
                    .as_mut()
                    .filter(|op| op.request.status == "waiting")
                {
                    if persist_report(library, &op.request, "awaitingReport", None).is_err() {
                        return (StatusCode::INTERNAL_SERVER_ERROR, None);
                    }
                    op.request.status = "claimed";
                    (StatusCode::OK, op.request.request.clone())
                } else {
                    (StatusCode::NO_CONTENT, None)
                }
            }
            Some("authorize_write") => {
                let Some(op) = self.operation.as_mut().filter(|op| {
                    op.request.status == "claimed"
                        && op.request.operation == "write"
                        && !op.write_authorized
                        && now < op.deadline
                        && message["runId"].as_str() == op.request.run_id.as_deref()
                }) else {
                    return (StatusCode::CONFLICT, None);
                };
                op.write_authorized = true;
                (StatusCode::NO_CONTENT, None)
            }
            Some("report") => {
                let report = &message["result"];
                let Some(op) = self.operation.as_mut().filter(|op| {
                    op.request.status == "claimed"
                        && report["runId"].as_str() == op.request.run_id.as_deref()
                        && report["worldId"] == self.world
                }) else {
                    return (StatusCode::CONFLICT, None);
                };
                let allowed = match report["status"].as_str() {
                    Some("error" | "cancelled") => true,
                    Some("returned") => op.request.operation == "run",
                    Some("written") => {
                        op.request.operation == "write"
                            && op.write_authorized
                            && report["id"]
                                .as_str()
                                .is_some_and(|id| !id.is_empty() && id.len() <= 256)
                    }
                    _ => false,
                };
                if !allowed {
                    return (StatusCode::BAD_REQUEST, None);
                }
                let mut report = report.clone();
                let terminal = if op.request.operation == "write"
                    && op.write_authorized
                    && report["status"] == "error"
                {
                    report["status"] = json!("unknown");
                    "unknown"
                } else {
                    "reported"
                };
                if persist_report(library, &op.request, terminal, Some(&report)).is_err() {
                    return (StatusCode::INTERNAL_SERVER_ERROR, None);
                }
                op.request.status = terminal;
                op.request.result = Some(report);
                (StatusCode::NO_CONTENT, None)
            }
            _ => (StatusCode::BAD_REQUEST, None),
        }
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn random_token() -> Result<String> {
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|error| error.to_string())?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

async fn route(
    req: Request<Incoming>,
    shared: Arc<Mutex<Option<Session>>>,
    library: Library,
) -> std::result::Result<Response<Full<Bytes>>, Infallible> {
    let origin = req
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let token = req.headers().get("authorization").cloned();
    let allowed = req
        .uri()
        .path_and_query()
        .is_some_and(|path| path.as_str() == "/fate-scripts/session/v1")
        && shared
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|session| session.origin == origin))
            .unwrap_or(false);
    let mut status = StatusCode::FORBIDDEN;
    let mut result = None;
    if allowed && req.method() == hyper::Method::OPTIONS {
        status = StatusCode::NO_CONTENT;
    } else if allowed && req.method() == hyper::Method::POST {
        if let Ok(Ok(body)) = tokio::time::timeout(
            Duration::from_secs(5),
            http_body_util::Limited::new(req.into_body(), 128 * 1024).collect(),
        )
        .await
        {
            status = StatusCode::BAD_REQUEST;
            if let Ok(message) = serde_json::from_slice(&body.to_bytes()) {
                status = StatusCode::FORBIDDEN;
                if let Ok(mut slot) = shared.lock() {
                    if let Some(session) = slot.as_mut().filter(|session| {
                        session.origin == origin
                            && token.as_ref().is_some_and(|token| {
                                equal(token.as_bytes(), session.key.as_bytes())
                            })
                    }) {
                        (status, result) = session.handle(&message, &library, Instant::now());
                    }
                }
            }
        } else {
            status = StatusCode::PAYLOAD_TOO_LARGE;
        }
    }
    let mut res = Response::builder()
        .status(status)
        .header("Cache-Control", "no-store")
        .header("Content-Type", "application/json");
    if allowed {
        res = res
            .header("Access-Control-Allow-Origin", origin)
            .header("Vary", "Origin")
            .header("Access-Control-Allow-Methods", "POST")
            .header(
                "Access-Control-Allow-Headers",
                "Authorization, Content-Type",
            );
    }
    let body = result.map(|value| value.to_string()).unwrap_or_default();
    Ok(res
        .body(Full::new(Bytes::from(body)))
        .expect("valid response"))
}

#[tauri::command]
pub async fn live_pair(
    state: State<'_, Live>,
    library: State<'_, Library>,
    origin: String,
    world: String,
) -> Result<String> {
    let url = tauri::Url::parse(&origin).map_err(|_| "Некорректный Origin")?;
    if url.origin().ascii_serialization() != origin
        || !matches!(url.scheme(), "http" | "https")
        || !matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
        || world.trim().is_empty()
        || world.len() > 128
    {
        return Err("Требуется loopback Origin и ID мира".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = random_token()?;
    // Each listener owns only its session. Replacing the desktop handle revokes the old listener.
    let handle = Arc::new(Mutex::new(Some(Session {
        origin,
        world,
        key: format!("Bearer {token}"),
        identity: None,
        deadline: Instant::now() + PAIR_TIMEOUT,
        heartbeat: None,
        operation: None,
        pairing_issue: None,
    })));
    let mut current = state.0.lock().map_err(|e| e.to_string())?;
    if current.is_some() {
        return Err("Сначала отзовите прежнее сопряжение".into());
    }
    *current = Some(handle.clone());
    let library = library.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        let mut ticks = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                _=ticks.tick()=>{
                    let keep=handle.lock().ok().and_then(|mut slot| slot.as_mut().map(|session|{
                        let now=Instant::now();
                        if now >= session.deadline {
                            if let Some(op) = session.operation.as_mut() { op.deadline=now; }
                        }
                        session.expire(&library,now);
                        now < session.deadline
                    })).unwrap_or(false);
                    if !keep {break;}
                },
                Some(_)=connections.join_next(),if !connections.is_empty()=>{},
                connection=listener.accept(),if connections.len()<8=>{
                    let Ok((stream,_))=connection else {break;};
                    let (shared, db)=(handle.clone(),library.clone());
                    connections.spawn(async move{
                        let service=service_fn(move |req|route(req,shared.clone(),db.clone()));
                        let _=tokio::time::timeout(Duration::from_secs(10),hyper::server::conn::http1::Builder::new().keep_alive(false).serve_connection(TokioIo::new(stream),service)).await;
                    });
                }
            }
        }
    });
    Ok(format!("{port}:{token}"))
}

#[tauri::command]
pub fn live_status(state: State<Live>) -> Result<Value> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let Some(handle) = guard.as_ref() else {
        return Ok(json!({"status":"idle"}));
    };
    let slot = handle.lock().map_err(|e| e.to_string())?;
    let Some(s) = slot.as_ref() else {
        return Ok(json!({"status":"idle"}));
    };
    Ok(json!({
        "status":s.status(Instant::now()),"origin":s.origin,"worldId":s.world,
        "pairingIssue":s.pairing_issue,
        "serverId":s.identity.as_ref().map(|entry| &entry.0),
        "operation":s.operation.as_ref().map(|op|json!({"scriptId":op.script_id,"snapshot":op.request})),
    }))
}

#[tauri::command]
pub fn live_revoke(state: State<Live>, library: State<Library>) -> Result<()> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(handle) = guard.as_ref() {
        let mut slot = handle.lock().map_err(|e| e.to_string())?;
        if let Some(op) = slot.as_ref().and_then(|s| s.operation.as_ref()) {
            match op.request.status {
                "claimed" => persist_report(&library, &op.request, "unknown", None)?,
                "waiting" => persist_report(&library, &op.request, "expired", None)?,
                _ => {}
            }
        }
        *slot = None;
    }
    *guard = None;
    Ok(())
}

#[tauri::command]
pub fn live_forget_identity(
    state: State<Live>,
    library: State<Library>,
    origin: String,
) -> Result<()> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("Сначала отзовите сопряжение".into());
    }
    let mut db = library.0.lock().map_err(|e| e.to_string())?;
    let transaction = db.transaction().map_err(super::super::db_error)?;
    transaction
        .execute(
            "DELETE FROM bridge_world_identity WHERE origin=?1",
            [&origin],
        )
        .map_err(super::super::db_error)?;
    transaction
        .execute("DELETE FROM bridge_identity WHERE origin=?1", [&origin])
        .map_err(super::super::db_error)?;
    transaction.commit().map_err(super::super::db_error)
}

#[tauri::command]
pub fn live_enqueue(
    state: State<Live>,
    library: State<Library>,
    script_id: String,
    run_id: String,
    write: Option<Value>,
) -> Result<()> {
    if !valid_id(&run_id) {
        return Err("Некорректный ID операции".into());
    }
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let handle = guard.as_ref().ok_or("Bridge не сопряжён")?;
    let mut slot = handle.lock().map_err(|e| e.to_string())?;
    let session = slot.as_mut().ok_or("Bridge отключён")?;
    let now = Instant::now();
    session.expire(&library, now);
    if session.status(now) != "connected" {
        return Err("Нет активного подключения GM".into());
    }
    if session
        .operation
        .as_ref()
        .is_some_and(|op| matches!(op.request.status, "waiting" | "claimed"))
    {
        return Err("Bridge выполняет другую операцию".into());
    }
    if session.operation.as_ref().is_some_and(|op| {
        op.script_id == script_id
            && now.saturating_duration_since(op.queued_at) < Duration::from_millis(1500)
    }) {
        return Err("Слишком частый повтор запуска".into());
    }
    let db = library.0.lock().map_err(|e| e.to_string())?;
    let raw: String = db
        .query_row(
            "SELECT payload FROM scripts WHERE id=?1",
            [&script_id],
            |row| row.get(0),
        )
        .map_err(super::super::db_error)?;
    let already_used: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM run_reports WHERE run_id=?1)",
            [&run_id],
            |row| row.get(0),
        )
        .map_err(super::super::db_error)?;
    if already_used {
        return Err("Операция с этим ID уже зарегистрирована".into());
    }
    let script: super::super::Script = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if !script.world.is_empty() && script.world != format!("{}#{}", session.origin, session.world) {
        return Err("Скрипт принадлежит другому миру".into());
    }
    if script.code.len() > 2_000_000 {
        return Err("Макрос превышает лимит размера".into());
    }
    let mut p = json!({"protocol":4,"runId":run_id,"origin":session.origin,"worldId":session.world,
        "serverId":session.identity.as_ref().map(|value|&value.0),
        "scriptId":script_id,"name":script.name,"action":"test","code":script.code});
    let operation = if let Some(write) = write {
        let linked: Option<(String, String, String, Option<String>)> = db.query_row(
            "SELECT server_origin,world_id,macro_id,last_code FROM foundry_links WHERE script_id=?1",
            [&script_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))
        ).optional().map_err(super::super::db_error)?;
        let (id, expected) = if write["linked"] == true {
            match linked.as_ref() {
                Some((origin, world, id, Some(code))) if origin == &session.origin && world == &session.world =>
                    (id.as_str(), code.as_str()),
                Some((origin, world, _, None)) if origin == &session.origin && world == &session.world =>
                    return Err("Для этой прежней связи один раз укажите ID и текущий код Foundry в расширенной записи.".into()),
                Some(_) => return Err("Скрипт связан с макросом другого мира.".into()),
                None => ("", ""),
            }
        } else {
            (
                write["macroId"].as_str().ok_or("Некорректный ID макроса")?,
                write["expected"]
                    .as_str()
                    .ok_or("Для записи нужен исходный снимок")?,
            )
        };
        if let Some((origin, world, linked_id, _)) = &linked {
            if origin != &session.origin || world != &session.world || linked_id != id {
                return Err("Запись должна использовать связанный макрос.".into());
            }
        } else if id.is_empty() {
            let uncertain: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM run_reports WHERE json_extract(payload,'$.scriptId')=?1
                 AND json_extract(payload,'$.origin')=?2 AND json_extract(payload,'$.worldId')=?3
                 AND json_extract(payload,'$.operation')='write'
                 AND json_extract(payload,'$.status') IN ('unknown','awaitingReport','reported')
                 AND COALESCE(json_extract(payload,'$.result.status'), 'unknown') IN ('unknown','written'))",
                rusqlite::params![script_id,session.origin,session.world], |row| row.get(0)
            ).map_err(super::super::db_error)?;
            if uncertain {
                return Err("Предыдущая запись могла создать макрос. Проверьте мир Foundry и укажите существующий макрос в расширенной записи.".into());
            }
        }
        if !id.is_empty() {
            let is_other: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM foundry_links WHERE server_origin=?1 AND world_id=?2 AND macro_id=?3 AND script_id<>?4)",
                rusqlite::params![session.origin,session.world,id,script_id], |row| row.get(0)
            ).map_err(super::super::db_error)?;
            if is_other {
                return Err("Макрос уже связан с другим скриптом библиотеки.".into());
            }
        }
        if id.len() > 128 || expected.len() > 2_000_000 {
            return Err("Пакет записи превышает лимит".into());
        }
        p["protocol"] = json!(3);
        p["action"] = json!(if id.is_empty() { "create" } else { "update" });
        p["macroId"] = json!(id);
        p["expected"] = json!(expected);
        "write"
    } else {
        "run"
    };
    session.operation = Some(Operation {
        script_id,
        queued_at: now,
        write_authorized: false,
        deadline: now + RUN_TIMEOUT,
        request: Snapshot {
            run_id: Some(run_id),
            operation: operation.into(),
            status: "waiting",
            inventory: None,
            request: Some(p),
            result: None,
            persistence_error: None,
        },
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_identity_single_claim_and_unknown_timeout() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../migration4.sql")).unwrap();
        db.execute_batch(include_str!("../migration6.sql")).unwrap();
        db.execute_batch(include_str!("../migration8.sql")).unwrap();
        let library = Library(Arc::new(Mutex::new(db)));
        let now = Instant::now();
        let server = "98765432-1234-4321-1234-876543218765";
        let run = "12345678-1234-4321-1234-876543218765";
        let mut session = Session {
            origin: "http://localhost:30000".into(),
            world: "test".into(),
            key: "bootstrap".into(),
            identity: None,
            deadline: now + PAIR_TIMEOUT,
            heartbeat: None,
            operation: None,
            pairing_issue: None,
        };
        let legacy = "8e88ccee-dfc6-4175-abc3-d3324e0a59bd";
        library
            .0
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO bridge_identity VALUES (?1,?2)",
                rusqlite::params![session.origin, legacy],
            )
            .unwrap();
        let packet = |action: &str, world: &str, user: &str| json!({"action":action,"worldId":world,"userId":user,"serverId":server,"identityKind":"world-v1"});
        assert_eq!(
            session.handle(&packet("pair", "other", "gm"), &library, now),
            (
                StatusCode::FORBIDDEN,
                Some(json!({"reason":"worldMismatch"}))
            )
        );
        let mut pair = packet("pair", "test", "gm");
        pair["identityKind"] = Value::Null;
        assert_eq!(
            session.handle(&pair, &library, now).0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(session.pairing_issue, Some("bridgeVersion"));
        pair["identityKind"] = json!("world-v1");
        assert_eq!(
            session.handle(&pair, &library, now).0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(session.pairing_issue, Some("profileMismatch"));
        pair["legacyProfileId"] = json!(legacy);
        assert_eq!(session.handle(&pair, &library, now).0, StatusCode::OK);
        assert_eq!(session.pairing_issue, None);
        assert_ne!(session.key, "bootstrap");
        let heartbeat_at = now + Duration::from_secs(3);
        assert_eq!(
            session.handle(&packet("heartbeat", "test", "gm"), &library, heartbeat_at),
            (StatusCode::NO_CONTENT, None)
        );
        assert_eq!(session.heartbeat, Some(heartbeat_at));
        assert_eq!(
            session
                .handle(&packet("poll", "test", "wrong"), &library, now)
                .0,
            StatusCode::FORBIDDEN
        );
        session.operation = Some(Operation {
            script_id: "s".into(),
            queued_at: now,
            write_authorized: false,
            deadline: now + RUN_TIMEOUT,
            request: Snapshot {
                run_id: Some(run.into()),
                operation: "run".into(),
                status: "waiting",
                inventory: None,
                request: Some(
                    json!({"runId":run,"worldId":"test","origin":"http://localhost:30000"}),
                ),
                result: None,
                persistence_error: None,
            },
        });
        assert_eq!(
            session
                .handle(&packet("poll", "test", "gm"), &library, now)
                .0,
            StatusCode::OK
        );
        assert_eq!(
            session
                .handle(&packet("poll", "test", "gm"), &library, now)
                .0,
            StatusCode::NO_CONTENT
        );
        let after = now + RUN_TIMEOUT;
        assert_eq!(session.status(after), "offline");
        let mut late = packet("report", "test", "gm");
        late["result"] = json!({"runId":run,"worldId":"test","status":"returned"});
        assert_eq!(
            session.handle(&late, &library, after).0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            session.operation.as_ref().unwrap().request.status,
            "unknown"
        );
        assert_eq!(
            session
                .handle(&packet("poll", "test", "gm"), &library, after)
                .0,
            StatusCode::NO_CONTENT
        );
        let write_id = "12345678-1234-4321-1234-876543218767";
        let op = session.operation.as_mut().unwrap();
        op.deadline = after + RUN_TIMEOUT;
        op.request.status = "waiting";
        op.request.operation = "write".into();
        op.request.run_id = Some(write_id.into());
        op.request.request =
            Some(json!({"runId":write_id,"worldId":"test","origin":"http://localhost:30000"}));
        assert_eq!(
            session
                .handle(&packet("poll", "test", "gm"), &library, after)
                .0,
            StatusCode::OK
        );
        let mut written = packet("report", "test", "gm");
        written["result"] =
            json!({"runId":write_id,"worldId":"test","status":"written","id":"macro"});
        assert_eq!(
            session.handle(&written, &library, after).0,
            StatusCode::BAD_REQUEST
        );
        let mut permit = packet("authorize_write", "test", "gm");
        permit["runId"] = json!(write_id);
        assert_eq!(
            session.handle(&permit, &library, after).0,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            session.handle(&permit, &library, after).0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            session.handle(&written, &library, after).0,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            session
                .handle(&packet("revoke", "test", "gm"), &library, after)
                .0,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            session
                .handle(&packet("poll", "test", "gm"), &library, after)
                .0,
            StatusCode::FORBIDDEN
        );
        session.identity = None;
        session.deadline = after + PAIR_TIMEOUT;
        let mut foreign = packet("pair", "test", "gm");
        foreign["serverId"] = json!("12345678-1234-4321-1234-876543218766");
        assert_eq!(
            session.handle(&foreign, &library, after),
            (
                StatusCode::FORBIDDEN,
                Some(json!({"reason":"profileMismatch"}))
            )
        );
        assert_eq!(
            session
                .handle(&packet("pair", "test", "gm"), &library, after)
                .0,
            StatusCode::OK,
            "browser migration should succeed with the pinned world identity",
        );
    }
}
