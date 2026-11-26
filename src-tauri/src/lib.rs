mod bridge;
mod catalog_cache;
mod deck_settings;
mod library_backup;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

#[derive(Clone)]
struct Library(Arc<Mutex<Connection>>);
type Result<T> = std::result::Result<T, String>;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Script {
    id: String,
    name: String,
    description: String,
    code: String,
    tags: String,
    category: String,
    folder: String,
    world: String,
    notes: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provenance: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dependencies: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    foundry_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    image: Option<String>,
}

#[derive(Serialize)]
struct Version {
    number: i64,
    code: String,
    source: String,
    date: String,
}

fn db_error(error: rusqlite::Error) -> String {
    error.to_string()
}

const DATABASE_VERSION: i64 = 9;

fn migrate(
    connection: &mut Connection,
    path: &Path,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")?;
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let version: i64 = transaction.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version > DATABASE_VERSION {
        return Err(format!("Версия базы {version} новее поддерживаемой версии {DATABASE_VERSION}.").into());
    }
    if (1..DATABASE_VERSION).contains(&version) {
        let source = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        source.busy_timeout(std::time::Duration::from_secs(5))?;
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).map_err(|error| std::io::Error::other(error.to_string()))?;
        let suffix = u64::from_le_bytes(nonce);
        let backup = path.with_file_name(format!(
            "library-before-v{version}-to-v{DATABASE_VERSION}-{suffix:016x}.sqlite3"
        ));
        source.execute(
            "VACUUM INTO ?1",
            [backup.to_str().ok_or("Недопустимый путь резервной копии")?],
        )?;
        let copy =
            Connection::open_with_flags(&backup, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let integrity: String = copy.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            return Err("Резервная копия не прошла проверку SQLite".into());
        }
    }
    if version == 0 {
        transaction.execute_batch(include_str!("schema.sql"))?;
    }
    if version < 2 {
        transaction.execute_batch(include_str!("migration2.sql"))?;
    }
    if version < 3 {
        transaction.execute_batch(include_str!("migration3.sql"))?;
    }
    if version < 4 {
        transaction.execute_batch(include_str!("migration4.sql"))?;
    }
    if version < 5 {
        transaction.execute_batch(include_str!("migration5.sql"))?;
    }
    if version < 6 {
        transaction.execute_batch(include_str!("migration6.sql"))?;
    }
    if version < 7 {
        transaction.execute_batch(include_str!("migration7.sql"))?;
    }
    if version < 8 {
        transaction.execute_batch(include_str!("migration8.sql"))?;
    }
    if version < 9 {
        transaction.execute_batch(include_str!("migration9.sql"))?;
    }
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    #[test]
    fn restoring_original_preserves_every_version_and_exact_text() {
        let mut db = Connection::open_in_memory().unwrap();
        migrate(&mut db, Path::new("unused.sqlite3")).unwrap();
        let original = "\u{feff}// пример\r\nreturn 42;\r\n";
        let create = |code: &str| serde_json::from_value::<Script>(serde_json::json!({
            "id":"restore","name":"Fixture","description":"","code":code,
            "tags":"","category":"","folder":"","world":"","notes":""
        })).unwrap();
        save_library_script(&mut db, create(original), "Редактор", None).unwrap();
        save_library_script(&mut db, create("return 43;"), "Редактор", Some(original.into())).unwrap();
        save_library_script(&mut db, create("return 44;"), "Редактор", Some("return 43;".into())).unwrap();
        assert!(save_library_script(&mut db, create(original), "Восстановление", Some("return 43;".into())).is_err());
        save_library_script(&mut db, create(original), "Восстановление", Some("return 44;".into())).unwrap();
        let mut stmt = db.prepare("SELECT code,source FROM versions WHERE script_id='restore' ORDER BY number").unwrap();
        let versions: Vec<(String,String)> = stmt.query_map([], |row| Ok((row.get(0)?,row.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert_eq!(versions.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(), [original,"return 43;","return 44;",original]);
        assert_eq!(versions[3].1,"Восстановление");
    }

    #[test]
    fn moving_scripts_preserves_history_and_rolls_back_on_missing_id() {
        let mut db = Connection::open_in_memory().unwrap();
        migrate(&mut db, Path::new("unused.sqlite3")).unwrap();
        let script = serde_json::json!({
            "id":"script-a","name":"Fixture","description":"","code":"return 42;",
            "tags":"","category":"","folder":"","world":"","notes":""
        });
        db.execute("INSERT INTO scripts(id,payload) VALUES ('script-a',?1)", [script.to_string()]).unwrap();
        db.execute("INSERT INTO versions(script_id,number,code,source) VALUES ('script-a',1,'return 42;','fixture')", []).unwrap();
        let target = || Folder {world:"test".to_owned(),path:"One/Two".to_owned()};
        assert!(organize_library(&mut db, vec!["script-a".into(),"missing".into()], Some(target()), None).is_err());
        assert_eq!(db.query_row("SELECT count(*) FROM folders", [], |r| r.get::<_,i64>(0)).unwrap(), 0);
        organize_library(&mut db, vec!["script-a".into()], Some(target()), Some("QA".into())).unwrap();
        let (world, folder, category, code): (String,String,String,String) = db.query_row(
            "SELECT json_extract(payload,'$.world'),json_extract(payload,'$.folder'),json_extract(payload,'$.category'),code FROM scripts JOIN versions ON script_id=id",
            [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))
        ).unwrap();
        assert_eq!((world.as_str(),folder.as_str(),category.as_str(),code.as_str()), ("test","One/Two","QA","return 42;"));
    }

    #[test]
    fn creates_readable_v1_backup_and_preserves_macro_bytes() {
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).unwrap();
        let directory =
            std::env::temp_dir().join(format!("fate-migration-{:016x}", u64::from_le_bytes(nonce)));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("library.sqlite3");
        let code = "'🎲'\r\n\t// \\path\n";
        {
            let mut db = Connection::open(&path).unwrap();
            db.execute_batch(include_str!("schema.sql")).unwrap();
            db.execute(
                "INSERT INTO scripts(id,payload) VALUES ('test',?1)",
                [serde_json::json!({"code":code}).to_string()],
            )
            .unwrap();
            db.execute(
                "INSERT INTO versions(script_id,number,code,source) VALUES ('test',1,?1,'fixture')",
                [code],
            )
            .unwrap();
            migrate(&mut db, &path).unwrap();
            let revision: i64 = db
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .unwrap();
            assert_eq!(revision, DATABASE_VERSION);
            let backup = std::fs::read_dir(&directory)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| {
                    path.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("library-before-v1")
                })
                .unwrap();
            let restored =
                Connection::open_with_flags(backup, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .unwrap();
            let revision: i64 = restored
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .unwrap();
            assert_eq!(revision, 1);
            for connection in [&db, &restored] {
                let actual: String = connection
                    .query_row(
                        "SELECT code FROM versions WHERE script_id='test'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(actual, code);
            }
            db.execute_batch("PRAGMA user_version=99").unwrap();
            assert!(migrate(&mut db, &path).is_err());
            assert_eq!(
                db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                99
            );
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[derive(Deserialize, Serialize)]
struct Folder {
    world: String,
    path: String,
}

fn ensure_folders(db: &Connection, world: &str, path: &str) -> Result<String> {
    let mut prefix = String::new();
    for part in path.split('/').map(str::trim).filter(|p| !p.is_empty()) {
        if part == "." || part == ".." {
            return Err("Недопустимый путь папки.".into());
        }
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(part);
        db.execute(
            "INSERT OR IGNORE INTO folders(world,path) VALUES (?1,?2)",
            params![world, prefix],
        )
        .map_err(db_error)?;
    }
    Ok(prefix)
}

#[tauri::command]
fn list_folders(library: State<Library>) -> Result<Vec<Folder>> {
    let db = library.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare("SELECT world,path FROM folders ORDER BY world,path")
        .map_err(db_error)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Folder {
                world: r.get(0)?,
                path: r.get(1)?,
            })
        })
        .map_err(db_error)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_error)
}

#[tauri::command]
fn create_folder(library: State<Library>, world: String, path: String) -> Result<()> {
    let mut db = library.0.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(db_error)?;
    if ensure_folders(&tx, &world, &path)?.is_empty() {
        return Err("Введите имя папки.".into());
    }
    tx.commit().map_err(db_error)
}

#[tauri::command]
fn change_folder(
    library: State<Library>,
    world: String,
    path: String,
    target: Option<String>,
) -> Result<()> {
    let mut db = library.0.lock().map_err(|e| e.to_string())?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let paths: Vec<String> = {
        let mut stmt = tx.prepare("SELECT path FROM folders WHERE world=?1 AND (path=?2 OR substr(path,1,length(?2)+1)=?2||'/')").map_err(db_error)?;
        let rows = stmt
            .query_map(params![world, path], |r| r.get(0))
            .map_err(db_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_error)?
    };
    if path.is_empty() || !paths.contains(&path) {
        return Err("Папка не найдена.".into());
    }
    if let Some(target) = target {
        if target == path {
            return Ok(());
        }
        if target.starts_with(&(path.clone() + "/"))
            || target.is_empty()
            || target
                .split('/')
                .any(|p| p.is_empty() || p.trim() != p || p == "." || p == "..")
        {
            return Err("Недопустимый путь назначения.".into());
        }
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM folders WHERE world=?1 AND (path=?2 OR substr(path,1,length(?2)+1)=?2||'/'))", params![world,target], |r| r.get(0)).map_err(db_error)?;
        if exists {
            return Err("Папка назначения уже существует.".into());
        }
        for old in &paths {
            ensure_folders(&tx, &world, &(target.clone() + &old[path.len()..]))?;
        }
        tx.execute(
            include_str!("folder_move.sql"),
            params![world, path, target],
        )
        .map_err(db_error)?;
    } else {
        let occupied: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM scripts WHERE json_extract(payload,'$.world')=?1 AND (json_extract(payload,'$.folder')=?2 OR substr(json_extract(payload,'$.folder'),1,length(?2)+1)=?2||'/'))", params![world,path], |r| r.get(0)).map_err(db_error)?;
        if occupied {
            return Err(
                "Удаление запрещено: дерево содержит скрипты. Сначала переместите их.".into(),
            );
        }
    }
    for old in paths {
        tx.execute(
            "DELETE FROM folders WHERE world=?1 AND path=?2",
            params![world, old],
        )
        .map_err(db_error)?;
    }
    tx.commit().map_err(db_error)
}

#[tauri::command]
fn list_scripts(library: State<Library>) -> Result<Vec<Script>> {
    let db = library.0.lock().map_err(|error| error.to_string())?;
    let mut query = db
        .prepare("SELECT payload FROM scripts ORDER BY modified DESC, id")
        .map_err(db_error)?;
    let rows = query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_error)?;
    rows.map(|row| serde_json::from_str(&row.map_err(db_error)?).map_err(|error| error.to_string()))
        .collect()
}

#[tauri::command]
fn script_details(library: State<Library>, id: String) -> Result<Option<serde_json::Value>> {
    let db = library.0.lock().map_err(|error| error.to_string())?;
    db.query_row(
        "SELECT s.created,s.modified,l.server_origin,l.world_id,l.macro_id
         FROM scripts s LEFT JOIN foundry_links l ON l.script_id=s.id WHERE s.id=?1",
        [&id],
        |row| Ok(serde_json::json!({
            "created":row.get::<_,String>(0)?,
            "modified":row.get::<_,String>(1)?,
            "origin":row.get::<_,Option<String>>(2)?,
            "worldId":row.get::<_,Option<String>>(3)?,
            "macroId":row.get::<_,Option<String>>(4)?,
        })),
    ).optional().map_err(db_error)
}

#[tauri::command]
fn save_script(
    library: State<Library>,
    script: Script,
    source: String,
    expected_code: Option<String>,
) -> Result<()> {
    let mut db = library.0.lock().map_err(|error| error.to_string())?;
    save_library_script(&mut db, script, &source, expected_code)
}

fn save_library_script(
    db: &mut Connection,
    mut script: Script,
    source: &str,
    expected_code: Option<String>,
) -> Result<()> {
    if let Some(image) = &script.image {
        let supported = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,"]
            .iter().any(|prefix| image.strip_prefix(prefix).is_some_and(|data| {
                !data.is_empty() && data.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
            }));
        if image.len() > 342_000 || !supported {
            return Err("Допустимо изображение PNG, JPEG или WebP до 256 КБ.".into());
        }
    }
    if script.name.trim().is_empty() || script.id.is_empty() {
        return Err("Укажите название и идентификатор скрипта.".into());
    }
    let transaction = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let previous: Option<String> = transaction
        .query_row(
            "SELECT code FROM versions WHERE script_id = ?1 ORDER BY number DESC LIMIT 1",
            [&script.id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    if previous != expected_code {
        return Err("Запись изменилась. Откройте актуальную версию перед сохранением.".into());
    }
    script.folder = ensure_folders(&transaction, &script.world, &script.folder)?;
    let payload = serde_json::to_string(&script).map_err(|error| error.to_string())?;
    transaction.execute(
        "INSERT INTO scripts (id, payload) VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, modified = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        params![script.id, payload],
    ).map_err(db_error)?;
    if previous.as_deref() != Some(script.code.as_str())
        || source == "Восстановление"
        || source == "ChatGPT"
    {
        transaction
            .execute(
                "INSERT INTO versions (script_id, number, code, source)
             SELECT ?1, COALESCE(MAX(number), 0) + 1, ?2, ?3 FROM versions WHERE script_id = ?1",
                params![script.id, script.code, source],
            )
            .map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)
}

#[tauri::command]
fn list_versions(library: State<Library>, id: String) -> Result<Vec<Version>> {
    let db = library.0.lock().map_err(|error| error.to_string())?;
    let mut query = db.prepare("SELECT number, code, source, created FROM versions WHERE script_id = ?1 ORDER BY number DESC").map_err(db_error)?;
    let rows = query
        .query_map([id], |row| {
            Ok(Version {
                number: row.get(0)?,
                code: row.get(1)?,
                source: row.get(2)?,
                date: row.get(3)?,
            })
        })
        .map_err(db_error)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_error)
}

#[tauri::command]
fn organize_scripts(
    library: State<Library>,
    ids: Vec<String>,
    destination: Option<Folder>,
    category: Option<String>,
) -> Result<()> {
    let mut db = library.0.lock().map_err(|error| error.to_string())?;
    organize_library(&mut db, ids, destination, category)
}

fn organize_library(db: &mut Connection, ids: Vec<String>, destination: Option<Folder>, category: Option<String>) -> Result<()> {
    if ids.is_empty() || (destination.is_none() && category.is_none()) {
        return Ok(());
    }
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(db_error)?;
    let path = destination.as_ref().map(|target| ensure_folders(&tx, &target.world, &target.path)).transpose()?;
    for id in ids {
        let payload: String = tx.query_row("SELECT payload FROM scripts WHERE id=?1", [&id], |row| row.get(0)).map_err(db_error)?;
        let mut script: Script = serde_json::from_str(&payload).map_err(|error| error.to_string())?;
        if let Some((target, path)) = destination.as_ref().zip(path.as_ref()) {
            if script.world != target.world {
                tx.execute("DELETE FROM foundry_links WHERE script_id=?1", [&id]).map_err(db_error)?;
            }
            script.world.clone_from(&target.world);
            script.folder.clone_from(path);
        }
        if let Some(category) = category.as_ref() {
            script.category = category.trim().to_owned();
        }
        let updated = serde_json::to_string(&script).map_err(|error| error.to_string())?;
        tx.execute(
            "UPDATE scripts SET payload=?2,modified=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
            params![id, updated],
        ).map_err(db_error)?;
    }
    tx.commit().map_err(db_error)
}

#[tauri::command]
fn delete_scripts(library: State<Library>, ids: Vec<String>) -> Result<()> {
    let mut db = library.0.lock().map_err(|error| error.to_string())?;
    let tx = db.transaction().map_err(db_error)?;
    for id in ids {
        tx.execute("DELETE FROM scripts WHERE id = ?1", [id])
            .map_err(db_error)?;
    }
    tx.commit().map_err(db_error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Inventory {
    protocol: u32,
    server_origin: String,
    world_id: String,
    macros: Vec<FoundryMacro>,
    #[serde(default)]
    folders: Vec<FoundryFolder>,
    version: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FoundryFolder {
    id: String,
    name: String,
    parent_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FoundryMacro {
    id: String,
    name: String,
    command: String,
    folder_id: Option<String>,
    #[serde(rename = "type")]
    kind: String,
}
#[derive(Serialize)]
struct ImportResult {
    imported: usize,
    skipped: usize,
}

#[tauri::command]
fn import_foundry_inventory(library: State<Library>, inventory: Inventory) -> Result<ImportResult> {
    let origin = &inventory.server_origin;
    let url = tauri::Url::parse(origin).map_err(|_| "Некорректный Origin")?;
    if inventory.protocol != 2
        || url.origin().ascii_serialization() != *origin
        || !matches!(url.scheme(), "http" | "https")
        || !matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
        || inventory.world_id.is_empty()
        || inventory.world_id.len() > 256
        || inventory.macros.len() > 50000
        || inventory.folders.len() > 50000
    {
        return Err("Некорректный снимок Foundry.".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut db = library.0.lock().map_err(|e| e.to_string())?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let mut result = ImportResult {
        imported: 0,
        skipped: 0,
    };
    let world = format!("{}#{}", origin, inventory.world_id);
    let folders: std::collections::HashMap<_, _> = inventory.folders.iter().map(|folder| (folder.id.as_str(), folder)).collect();
    if folders.len() != inventory.folders.len() {
        return Err("В снимке Foundry повторяется ID папки.".into());
    }
    for m in &inventory.macros {
        if m.id.is_empty() || m.id.len() > 256 || !seen.insert(&m.id) || m.name.trim().is_empty() {
            return Err("Некорректный или повторный ID макроса.".into());
        }
        if m.kind != "script" {
            result.skipped += 1;
            continue;
        }
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM foundry_links WHERE server_origin=?1 AND world_id=?2 AND macro_id=?3)", params![origin,inventory.world_id,m.id], |r| r.get(0)).map_err(db_error)?;
        if exists {
            result.skipped += 1;
            continue;
        }
        let id: String = tx
            .query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))
            .map_err(db_error)?;
        let mut names = Vec::new();
        let mut parent = m.folder_id.as_deref();
        while let Some(folder) = parent.and_then(|id| folders.get(id)) {
            if names.len() == 64 {
                return Err("Папки Foundry вложены слишком глубоко или содержат цикл.".into());
            }
            names.push(folder.name.replace('/', "／").replace('\\', "＼"));
            parent = folder.parent_id.as_deref();
        }
        names.reverse();
        let path = ensure_folders(&tx, &world, &names.join("/"))?;
        let script = Script {
            id: id.clone(),
            name: m.name.clone(),
            code: m.command.clone(),
            world: world.clone(),
            folder: path,
            description: String::new(),
            tags: String::new(),
            category: "Foundry".into(),
            notes: String::new(),
            provenance: None,
            dependencies: None,
            foundry_version: inventory.version.clone(),
            image: None,
        };
        let payload = serde_json::to_string(&script).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO scripts(id,payload) VALUES (?1,?2)",
            params![id, payload],
        )
        .map_err(db_error)?;
        tx.execute(
            "INSERT INTO versions(script_id,number,code,source) VALUES (?1,1,?2,'Foundry')",
            params![id, m.command],
        )
        .map_err(db_error)?;
        tx.execute(
            "INSERT INTO foundry_links(server_origin,world_id,macro_id,script_id,last_code) VALUES (?1,?2,?3,?4,?5)",
            params![origin, inventory.world_id, m.id, id, m.command],
        )
        .map_err(db_error)?;
        result.imported += 1;
    }
    tx.commit().map_err(db_error)?;
    Ok(result)
}

#[tauri::command]
fn list_run_reports(library: State<Library>) -> Result<Vec<serde_json::Value>> {
    let db = library.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare("SELECT json_set(payload,'$.createdAt',created) FROM run_reports WHERE json_extract(payload,'$.hidden') IS NOT 1 ORDER BY created DESC LIMIT 100")
        .map_err(db_error)?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(db_error)?;
    rows.map(|r| serde_json::from_str(&r.map_err(db_error)?).map_err(|e| e.to_string()))
        .collect()
}

#[tauri::command]
fn clear_run_reports(library: State<Library>) -> Result<usize> {
    let db = library.0.lock().map_err(|e| e.to_string())?;
    db.execute(
        "UPDATE run_reports SET payload=json_object(
             'runId',run_id,'status',json_extract(payload,'$.status'),'hidden',1,
             'operation',json_extract(payload,'$.operation'),'scriptId',json_extract(payload,'$.scriptId'),
             'origin',json_extract(payload,'$.origin'),'worldId',json_extract(payload,'$.worldId'),
             'result',json_object('status',json_extract(payload,'$.result.status'))
         ) WHERE json_extract(payload,'$.hidden') IS NOT 1
             AND json_extract(payload,'$.status') IN ('reported','unknown','expired','cancelled')",
        [],
    )
    .map_err(db_error)
}

fn data_directory(app: &tauri::AppHandle) -> tauri::Result<std::path::PathBuf> {
    let dir = app.path().app_local_data_dir()?;
    #[cfg(debug_assertions)]
    let dir = std::env::var_os("FATE_SCRIPTS_QA_DATA")
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or(dir);
    Ok(dir)
}

#[tauri::command]
async fn open_deck_window(app: tauri::AppHandle) -> Result<()> {
    if let Some(window) = app.get_webview_window("deck") {
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    let window =
        tauri::WebviewWindowBuilder::new(&app, "deck", tauri::WebviewUrl::App("index.html".into()))
            .title("Fate Scripts — Панель запуска")
            .inner_size(640.0, 540.0)
            .min_inner_size(320.0, 240.0)
            .build()
            .map_err(|e| e.to_string())?;
    let path = data_directory(&app)
        .map_err(|e| e.to_string())?
        .join("deck-window.json");
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(g) = serde_json::from_str::<[i32; 4]>(&raw) {
            if g[2] >= 320 && g[3] >= 240 && g[2] <= 10000 && g[3] <= 10000 {
                let _ = window.set_size(tauri::PhysicalSize::new(g[2] as u32, g[3] as u32));
                if let Ok(monitors) = window.available_monitors() {
                    if monitors.iter().any(|m| {
                        let p = m.position();
                        let z = m.size();
                        g[0] >= p.x
                            && g[1] >= p.y
                            && (g[0] as i64) < p.x as i64 + z.width as i64
                            && (g[1] as i64) < p.y as i64 + z.height as i64
                    }) {
                        let _ = window.set_position(tauri::PhysicalPosition::new(g[0], g[1]));
                    }
                }
            }
        }
    }
    let tracked = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            if let (Ok(p), Ok(z)) = (tracked.outer_position(), tracked.inner_size()) {
                if let Ok(raw) = serde_json::to_string(&[p.x, p.y, z.width as i32, z.height as i32])
                {
                    let _ = std::fs::write(&path, raw);
                }
            }
        }
    });
    Ok(())
}
#[tauri::command]
fn deck_always_on_top(window: tauri::WebviewWindow, enabled: bool) -> Result<()> {
    if window.label() != "deck" {
        return Err("Недопустимое окно".into());
    }
    window.set_always_on_top(enabled).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(bridge::Bridge::default())
        .manage(bridge::live::Live::default())
        .setup(|app| {
            let dir = data_directory(app.handle())?;
            std::fs::create_dir_all(&dir)?;
            let path = dir.join("library.sqlite3");
            let mut connection = Connection::open(&path)?;
            let restore_notice = library_backup::apply_pending(&mut connection, &dir).err();
            app.manage(library_backup::RestoreNotice(restore_notice));
            migrate(&mut connection, &path)?;
            app.manage(Library(Arc::new(Mutex::new(connection))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            deck_settings::load_deck,
            deck_settings::save_deck,
            catalog_cache::load_catalog,
            catalog_cache::save_catalog_source,
            catalog_cache::import_catalog_sources,
            library_backup::list_library_backups,
            library_backup::create_library_backup,
            library_backup::stage_library_restore,
            library_backup::cancel_library_restore,
            library_backup::library_restore_notice,
            open_deck_window,
            deck_always_on_top,
            bridge::bridge_start,
            bridge::bridge_status,
            bridge::bridge_module_inventory,
            bridge::bridge_cancel,
            bridge::live::live_pair,
            bridge::live::live_status,
            bridge::live::live_revoke,
            bridge::live::live_enqueue,
            bridge::live::live_forget_identity,
            import_foundry_inventory,
            list_run_reports,
            clear_run_reports,
            list_scripts,
            list_folders,
            create_folder,
            change_folder,
            save_script,
            script_details,
            list_versions,
            delete_scripts,
            organize_scripts
        ])
        .run(tauri::generate_context!())
        .expect("Fate Scripts failed to start");
}
