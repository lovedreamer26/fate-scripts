//! One-shot loopback transport; GM confirms writes and execution.
pub mod live;
use super::{Library, Result};
use http_body_util::{BodyExt, Full};
use hyper::{
    Request, Response, StatusCode,
    body::{Bytes, Incoming},
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use serde_json::Value;
use std::{
    convert::Infallible,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::net::TcpListener;

#[derive(Default)]
pub struct Bridge(Mutex<Option<Session>>, ModuleInventory);
type ModuleInventory = Arc<Mutex<Option<Value>>>;
struct Session {
    owner: String,
    shared: Arc<Mutex<Snapshot>>,
    task: tauri::async_runtime::JoinHandle<()>,
}
#[derive(Clone, Serialize)]
struct Snapshot {
    #[serde(rename = "runId")]
    run_id: Option<String>,
    operation: String,
    status: &'static str,
    inventory: Option<Value>,
    #[serde(skip_serializing)]
    request: Option<Value>,
    result: Option<Value>,
    persistence_error: Option<String>,
}
#[derive(Serialize)]
pub struct Pairing {
    code: String,
    #[serde(rename = "runId")]
    run_id: String,
}
const LIMIT: usize = 16 * 1024 * 1024;
fn equal(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
fn valid(d: &Value, origin: &str, world: &str) -> bool {
    if d["protocol"] != 2
        || d["serverOrigin"].as_str() != Some(origin)
        || d["worldId"].as_str() != Some(world)
    {
        return false;
    }
    let Some(macros) = d["macros"].as_array() else {
        return false;
    };
    let mut ids = std::collections::HashSet::new();
    macros.len() <= 50000
        && macros.iter().all(|m| {
            m["id"]
                .as_str()
                .is_some_and(|id| !id.is_empty() && id.len() <= 256 && ids.insert(id))
                && m["name"].as_str().is_some_and(|s| !s.trim().is_empty())
                && m["type"].is_string()
                && m["command"].is_string()
        })
}
fn persist_report(
    library: &Library,
    snapshot: &Snapshot,
    status: &str,
    result: Option<&Value>,
) -> Result<()> {
    let Some(request) = snapshot.request.as_ref() else {
        return Ok(());
    };
    let run_id = snapshot
        .run_id
        .as_deref()
        .ok_or("Отсутствует ID операции")?;
    let mut db = library.0.lock().map_err(|e| e.to_string())?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(super::db_error)?;
    let mut link_error = None;
    if let Some((macro_id, script_id)) = result
        .filter(|r| snapshot.operation == "write" && r["status"] == "written")
        .and_then(|r| r["id"].as_str().zip(request["scriptId"].as_str()))
    {
        let params = rusqlite::params![
            request["origin"].as_str(),
            request["worldId"].as_str(),
            macro_id,
            script_id
        ];
        let changed = tx.execute("INSERT OR IGNORE INTO foundry_links(server_origin,world_id,macro_id,script_id) SELECT ?1,?2,?3,?4 WHERE EXISTS (SELECT 1 FROM scripts WHERE id=?4)", params).map_err(super::db_error)?;
        if changed == 0 && !tx.query_row("SELECT EXISTS(SELECT 1 FROM foundry_links WHERE server_origin=?1 AND world_id=?2 AND macro_id=?3 AND script_id=?4)", params, |row| row.get::<_, bool>(0)).map_err(super::db_error)? {
            link_error = Some("Скрипт удалён или макрос уже связан с другим скриптом");
        }
        if link_error.is_none() {
            tx.execute(
                "UPDATE foundry_links SET last_code=?5 WHERE server_origin=?1 AND world_id=?2 AND macro_id=?3 AND script_id=?4",
                rusqlite::params![request["origin"].as_str(), request["worldId"].as_str(), macro_id, script_id, request["code"].as_str()],
            ).map_err(super::db_error)?;
        }
    }
    let payload = serde_json::json!({
        "runId": run_id, "operation": snapshot.operation, "origin": request["origin"],
        "worldId": request["worldId"], "name": request["name"], "status": status,
        "serverId":request["serverId"],"scriptId":request["scriptId"],
        "result": result, "linkError": link_error
    });
    let sql = if matches!(status, "reported" | "unknown") {
        "UPDATE run_reports SET payload=?2 WHERE run_id=?1 AND json_extract(payload,'$.status')='awaitingReport'"
    } else {
        "INSERT INTO run_reports(run_id,payload) VALUES (?1,?2)"
    };
    let changed = tx
        .execute(sql, rusqlite::params![run_id, payload.to_string()])
        .map_err(super::db_error)?;
    if changed != 1 {
        return Err("Операция Bridge уже завершена или не зарегистрирована".into());
    }
    tx.commit().map_err(super::db_error)
}
async fn receive(
    req: Request<Incoming>,
    origin: String,
    world: String,
    key: String,
    shared: Arc<Mutex<Snapshot>>,
    library: Library,
    modules: ModuleInventory,
) -> std::result::Result<Response<Full<Bytes>>, Infallible> {
    let allowed = req.uri().path_and_query().is_some_and(|p| {
        matches!(
            p.as_str(),
            "/fate-scripts/inventory/v2" | "/fate-scripts/run/v1"
        )
    }) && req.headers().get("origin").and_then(|v| v.to_str().ok())
        == Some(origin.as_str());
    let is_run = req.uri().path() == "/fate-scripts/run/v1";
    let mut output = Bytes::new();
    let mut status = StatusCode::FORBIDDEN;
    if allowed {
        if req.method() == hyper::Method::OPTIONS {
            status = StatusCode::NO_CONTENT;
        } else if req.method() == hyper::Method::POST
            && req
                .headers()
                .get("authorization")
                .is_some_and(|v| equal(v.as_bytes(), key.as_bytes()))
        {
            let mut body = req.into_body();
            let read = async {
                let mut bytes = Vec::new();
                while let Some(frame) = body.frame().await {
                    let frame = frame.ok()?;
                    if let Some(data) = frame.data_ref() {
                        if bytes.len() + data.len() > LIMIT {
                            return None;
                        }
                        bytes.extend_from_slice(data);
                    }
                }
                serde_json::from_slice::<Value>(&bytes).ok()
            };
            status = StatusCode::BAD_REQUEST;
            if let Ok(Some(data)) = tokio::time::timeout(Duration::from_secs(10), read).await {
                if is_run {
                    if data["origin"].as_str() == Some(origin.as_str())
                        && data["worldId"].as_str() == Some(world.as_str())
                    {
                        if let Ok(mut s) = shared.lock() {
                            status = StatusCode::CONFLICT;
                            if data["action"] == "claim" && s.status == "waiting" {
                                if let Some(p) = s.request.as_ref() {
                                    if p["protocol"] == data["protocol"] {
                                        match persist_report(&library, &s, "awaitingReport", None) {
                                            Ok(()) => {
                                                output = Bytes::from(p.to_string());
                                                s.status = "claimed";
                                                status = StatusCode::OK;
                                            }
                                            Err(_) => {
                                                s.persistence_error = Some("SQLite не зарегистрировала запуск. Запрос не выдан.".into());
                                                status = StatusCode::INTERNAL_SERVER_ERROR;
                                            }
                                        }
                                    }
                                }
                            } else if data["action"] == "report" && s.status == "claimed" {
                                let r = &data["result"];
                                if s.request.as_ref().is_some_and(|p| p["runId"] == r["runId"])
                                    && r["worldId"].as_str() == Some(world.as_str())
                                    && (if s.operation == "write" {
                                        matches!(
                                            r["status"].as_str(),
                                            Some("written" | "error" | "cancelled")
                                        ) && (r["status"] != "written"
                                            || r["id"].as_str().is_some_and(|id| {
                                                !id.is_empty() && id.len() <= 256
                                            }))
                                    } else {
                                        matches!(
                                            r["status"].as_str(),
                                            Some("returned" | "error" | "cancelled")
                                        )
                                    })
                                {
                                    match persist_report(&library, &s, "reported", Some(r)) {
                                        Ok(()) => {
                                            s.result = Some(r.clone());
                                            s.status = "reported";
                                            status = StatusCode::NO_CONTENT;
                                        }
                                        Err(_) => {
                                            s.persistence_error =
                                                Some("SQLite не сохранила отчёт Bridge".into());
                                            status = StatusCode::INTERNAL_SERVER_ERROR;
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else if valid(&data, &origin, &world) {
                    if let Ok(mut state) = shared.lock() {
                        if state.status == "waiting" && state.request.is_none() {
                            if let Ok(mut snapshot) = modules.lock() {
                                *snapshot = Some(serde_json::json!({
                                    "serverOrigin": data["serverOrigin"],
                                    "worldId": data["worldId"],
                                    "capturedAt": data["capturedAt"],
                                    "modules": data["modules"],
                                }));
                            }
                            state.status = "received";
                            state.inventory = Some(data);
                            status = StatusCode::NO_CONTENT;
                        } else {
                            status = StatusCode::CONFLICT;
                        }
                    }
                }
            }
        }
    }
    let mut response = Response::builder()
        .status(status)
        .header("Cache-Control", "no-store");
    if allowed {
        response = response
            .header("Access-Control-Allow-Origin", origin)
            .header("Vary", "Origin")
            .header("Access-Control-Allow-Methods", "POST")
            .header(
                "Access-Control-Allow-Headers",
                "Authorization, Content-Type",
            );
    }
    Ok(response.body(Full::new(output)).expect("valid response"))
}
#[tauri::command]
pub async fn bridge_start(
    state: tauri::State<'_, Bridge>,
    library: tauri::State<'_, Library>,
    window: tauri::WebviewWindow,
    origin: String,
    world_id: String,
    request: Option<Value>,
) -> Result<Pairing> {
    let url = tauri::Url::parse(&origin).map_err(|_| "Некорректный Origin")?;
    if url.origin().ascii_serialization() != origin
        || !matches!(url.scheme(), "http" | "https")
        || !matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
        || world_id.is_empty()
        || world_id.len() > 256
    {
        return Err("Требуется локальный Origin и ID мира".into());
    }
    if let Some(p) = request.as_ref() {
        if (p["protocol"] != 4 && p["protocol"] != 3)
            || p["origin"] != origin
            || p["worldId"] != world_id
            || !p["runId"].is_string()
        {
            return Err("Некорректный запрос запуска".into());
        }
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    let token = random
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let key = format!("Bearer {token}");
    let operation = match request.as_ref() {
        Some(p) if p["protocol"] == 3 => "write",
        Some(_) => "run",
        None => "inventory",
    }
    .to_string();
    let mut inventory_id = [0u8; 16];
    getrandom::fill(&mut inventory_id).map_err(|e| e.to_string())?;
    let run_id = request
        .as_ref()
        .and_then(|p| p["runId"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            inventory_id
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect()
        });
    let shared = Arc::new(Mutex::new(Snapshot {
        run_id: Some(run_id.clone()),
        operation,
        status: "waiting",
        inventory: None,
        request,
        result: None,
        persistence_error: None,
    }));
    let worker = shared.clone();
    let modules = state.1.clone();
    let library = library.inner().clone();
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(old) = slot.as_ref() {
        let s = old.shared.lock().map_err(|e| e.to_string())?;
        if matches!(s.status, "waiting" | "claimed" | "received") {
            return Err("Сначала завершите текущую операцию Bridge".into());
        }
    }
    if let Some(old) = slot.take() {
        if let Ok(mut s) = old.shared.lock() {
            s.status = "cancelled";
        }
        old.task.abort();
    }
    let task = tauri::async_runtime::spawn(async move {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                _=tokio::time::sleep_until(deadline)=>break,
                Some(_)=connections.join_next(), if !connections.is_empty()=>{},
                result=listener.accept(), if connections.len()<8=>{
                    let Ok((stream,_))=result else {break;};
                    let (o,w,k,s,db)=(origin.clone(),world_id.clone(),key.clone(),worker.clone(),library.clone());
                    let modules = modules.clone();
                    connections.spawn(async move {
                        let service=service_fn(move |req|receive(req,o.clone(),w.clone(),k.clone(),s.clone(),db.clone(),modules.clone()));
                        let _=tokio::time::timeout(Duration::from_secs(15),hyper::server::conn::http1::Builder::new().keep_alive(false).serve_connection(TokioIo::new(stream),service)).await;
                    });
                }
            }
        }
        if let Ok(mut s) = worker.lock() {
            let terminal = match s.status {
                "waiting" => "expired",
                "claimed" => "unknown",
                _ => return,
            };
            s.status = terminal;
            if persist_report(&library, &s, terminal, None).is_err() {
                s.persistence_error = Some("SQLite не сохранила состояние Bridge".into());
            }
        }
    });
    *slot = Some(Session {
        owner: window.label().to_owned(),
        shared,
        task,
    });
    Ok(Pairing {
        code: format!("{port}:{token}"),
        run_id,
    })
}
#[tauri::command]
pub fn bridge_module_inventory(state: tauri::State<'_, Bridge>) -> Result<Option<Value>> {
    let snapshot = state.1.lock().map_err(|error| error.to_string())?;
    Ok(snapshot.clone())
}
#[tauri::command]
pub fn bridge_status(state: tauri::State<'_, Bridge>) -> Result<Value> {
    let slot = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(session) = slot.as_ref() {
        let s = session.shared.lock().map_err(|e| e.to_string())?;
        serde_json::to_value(&*s).map_err(|e| e.to_string())
    } else {
        Ok(serde_json::json!({"status":"idle","inventory":null}))
    }
}
#[tauri::command]
pub fn bridge_cancel(
    state: tauri::State<'_, Bridge>,
    window: tauri::WebviewWindow,
    operation: String,
    run_id: String,
) -> Result<()> {
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    let session = slot.as_ref().ok_or("Операция Bridge отсутствует")?;
    {
        let mut snapshot = session.shared.lock().map_err(|error| error.to_string())?;
        if session.owner != window.label()
            || snapshot.operation != operation
            || snapshot.run_id.as_deref() != Some(run_id.as_str())
            || snapshot.status == "claimed"
        {
            return Err("Другая операция или выполнение уже начато".into());
        }
        snapshot.status = "cancelled";
    }
    if let Some(session) = slot.take() {
        session.task.abort();
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn written_macro_keeps_link_and_exact_baseline() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        super::super::migrate(&mut db, std::path::Path::new("unused.sqlite3")).unwrap();
        db.execute("INSERT INTO scripts(id,payload) VALUES ('s','{}')", []).unwrap();
        let library = Library(Arc::new(Mutex::new(db)));
        let mut snapshot = Snapshot {
            run_id: None, operation: "write".into(), status: "claimed", inventory: None,
            request: None, result: None, persistence_error: None,
        };
        for (run, code) in [("create", "return 42;\r\n"), ("update", "// QA\nreturn 43;\r\n")] {
            snapshot.run_id = Some(run.into());
            snapshot.request = Some(serde_json::json!({"scriptId":"s","origin":"http://localhost:30000","worldId":"test","code":code}));
            persist_report(&library,&snapshot,"awaitingReport",None).unwrap();
            persist_report(&library,&snapshot,"reported",Some(&serde_json::json!({"status":"written","id":"m"}))).unwrap();
            let current: (String,String) = library.0.lock().unwrap()
                .query_row("SELECT macro_id,last_code FROM foundry_links WHERE script_id='s'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
            assert_eq!(current,("m".into(),code.into()));
        }
        assert_eq!(library.0.lock().unwrap().query_row("SELECT count(*) FROM foundry_links", [], |r| r.get::<_,i64>(0)).unwrap(),1);
    }

    #[test]
    fn validation() {
        let d = serde_json::json!({"protocol":2,"serverOrigin":"http://localhost:30000","worldId":"w","macros":[{"id":"m","name":"Тест","type":"script","command":"a\r\nb"}]});
        assert!(valid(&d, "http://localhost:30000", "w"));
        assert!(!valid(&d, "http://localhost:30000", "x"));
        assert!(!equal(b"abc", b"abd"));
    }

    #[test]
    fn claim_is_persisted_once_and_final_report_replaces_only_pending_state() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("migration4.sql")).unwrap();
        let library = Library(Arc::new(Mutex::new(db)));
        let snapshot = Snapshot {
            run_id: Some("test-run".into()),
            operation: "run".into(),
            status: "claimed",
            inventory: None,
            request: Some(
                serde_json::json!({"name":"Fixture","origin":"http://localhost:30000","worldId":"test"}),
            ),
            result: None,
            persistence_error: None,
        };
        let read_status = || {
            library.0.lock().unwrap().query_row(
            "SELECT json_extract(payload,'$.status') FROM run_reports WHERE run_id='test-run'",
            [], |row| row.get::<_, String>(0),
        ).unwrap()
        };
        assert!(persist_report(&library, &snapshot, "reported", None).is_err());
        persist_report(&library, &snapshot, "awaitingReport", None).unwrap();
        assert_eq!(read_status(), "awaitingReport");
        assert!(persist_report(&library, &snapshot, "awaitingReport", None).is_err());
        persist_report(&library, &snapshot, "unknown", None).unwrap();
        assert!(persist_report(&library, &snapshot, "reported", None).is_err());
        assert_eq!(read_status(), "unknown");
    }
}
