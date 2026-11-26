use super::{Library, Result, data_directory, db_error, migrate};
use rusqlite::{Connection, MAIN_DB, OpenFlags};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::State;

const PENDING: &str = "pending-library-restore.txt";

fn backup_name(name: &str) -> bool {
    (name.starts_with("library-backup-") || name.starts_with("library-before-"))
        && name.ends_with(".sqlite3")
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.'))
}

fn snapshot(db: &Connection, dir: &Path, label: &str) -> Result<PathBuf> {
    let mut nonce = [0u8; 8];
    getrandom::fill(&mut nonce).map_err(|error| error.to_string())?;
    let path = dir.join(format!(
        "library-{label}-{:016x}.sqlite3",
        u64::from_le_bytes(nonce)
    ));
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    if let Err(error) = db.backup(MAIN_DB, &path, None) {
        let _ = fs::remove_file(&path);
        return Err(db_error(error));
    }
    validate(&path)?;
    Ok(path)
}

fn validate(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() {
        return Err("Резервная копия должна быть обычным файлом".into());
    }
    let db =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(db_error)?;
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(db_error)?;
    let tables:i64=db.query_row("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('scripts','versions')",[],|row|row.get(0)).map_err(db_error)?;
    let integrity: String = db
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(db_error)?;
    if !(1..=crate::DATABASE_VERSION).contains(&version) || tables != 2 || integrity != "ok" {
        return Err("Копия Fate Scripts повреждена или имеет несовместимую версию".into());
    }
    Ok(())
}

pub fn apply_pending(db: &mut Connection, dir: &Path) -> Result<()> {
    let marker = dir.join(PENDING);
    let name = match fs::read_to_string(&marker) {
        Ok(name) => name,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if !backup_name(&name) {
        return Err("Некорректное имя в запросе восстановления".into());
    }
    let source = dir.join(name);
    validate(&source)?;
    let source_db =
        Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(db_error)?;
    let prepared = snapshot(&source_db, dir, "before-restore-prepared")?;
    let mut migrated = Connection::open(&prepared).map_err(db_error)?;
    migrate(&mut migrated, &prepared).map_err(|error| error.to_string())?;
    drop(migrated);
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(db_error)?;
    if version > crate::DATABASE_VERSION {
        return Err("Текущая база создана более новой версией Fate Scripts".into());
    }
    if version != 0 {
        snapshot(db, dir, "before-restore")?;
    }
    let applying = prepared.with_extension("restoring");
    fs::rename(marker, &applying).map_err(|error| error.to_string())?;
    db.restore(MAIN_DB, &prepared, None::<fn(rusqlite::backup::Progress)>)
        .map_err(db_error)?;
    let _ = fs::remove_file(applying);
    let _ = fs::remove_file(prepared);
    Ok(())
}

#[tauri::command]
pub fn list_library_backups(app: tauri::AppHandle) -> Result<Vec<String>> {
    let dir = data_directory(&app).map_err(|error| error.to_string())?;
    let mut names = Vec::new();
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_file()
        {
            continue;
        }
        if let Ok(name) = entry.file_name().into_string() {
            if backup_name(&name) && !name.starts_with("library-before-restore-prepared-") {
                names.push(name);
            }
        }
    }
    names.sort_unstable();
    Ok(names)
}

#[tauri::command]
pub fn create_library_backup(app: tauri::AppHandle, library: State<Library>) -> Result<String> {
    let dir = data_directory(&app).map_err(|error| error.to_string())?;
    let db = library.0.lock().map_err(|error| error.to_string())?;
    let path = snapshot(&db, &dir, "backup")?;
    Ok(path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Некорректное имя копии")?
        .to_owned())
}

#[tauri::command]
pub fn stage_library_restore(app: tauri::AppHandle, name: String) -> Result<()> {
    if !backup_name(&name) {
        return Err("Некорректное имя резервной копии".into());
    }
    let dir = data_directory(&app).map_err(|error| error.to_string())?;
    validate(&dir.join(&name))?;
    let marker = dir.join(PENDING);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker)
        .map_err(|error| error.to_string())?;
    if let Err(error) = file
        .write_all(name.as_bytes())
        .and_then(|()| file.sync_all())
    {
        drop(file);
        let _ = fs::remove_file(marker);
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_library_restore(app: tauri::AppHandle) -> Result<()> {
    let dir = data_directory(&app).map_err(|error| error.to_string())?;
    match fs::remove_file(dir.join(PENDING)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub struct RestoreNotice(pub Option<String>);

#[tauri::command]
pub fn library_restore_notice(notice: State<RestoreNotice>) -> Option<String> {
    notice.0.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_pending_snapshot_and_preserves_previous_library() {
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).unwrap();
        let dir =
            std::env::temp_dir().join(format!("fate-restore-{:016x}", u64::from_le_bytes(nonce)));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("library.sqlite3");
        {
            let mut db = Connection::open(&path).unwrap();
            migrate(&mut db, &path).unwrap();
            db.execute(
                "INSERT INTO scripts(id,payload) VALUES ('a','{\"code\":\"first\"}')",
                [],
            )
            .unwrap();
            db.execute("INSERT INTO deck_settings VALUES(1,1,'{\"images\":[\"data:image/png;base64,AAAA\"]}')",[]).unwrap();
            let copy = snapshot(&db, &dir, "backup").unwrap();
            db.execute("UPDATE scripts SET payload='{\"code\":\"second\"}'", [])
                .unwrap();
            db.execute("DELETE FROM deck_settings", []).unwrap();
            fs::write(
                dir.join(PENDING),
                copy.file_name().unwrap().as_encoded_bytes(),
            )
            .unwrap();
            apply_pending(&mut db, &dir).unwrap();
            let code = |db: &Connection| {
                db.query_row(
                    "SELECT json_extract(payload,'$.code') FROM scripts",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap()
            };
            assert_eq!(code(&db), "first");
            assert!(
                db.query_row("SELECT payload FROM deck_settings", [], |row| row
                    .get::<_, String>(0))
                    .unwrap()
                    .contains("AAAA")
            );
            let prior = fs::read_dir(&dir)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| {
                    path.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("library-before-restore-")
                })
                .unwrap();
            assert_eq!(code(&Connection::open(prior).unwrap()), "second");
            assert!(!dir.join(PENDING).exists());
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
