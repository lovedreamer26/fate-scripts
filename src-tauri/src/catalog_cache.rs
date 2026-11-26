use super::{Library, Result, db_error};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

#[derive(Serialize, Deserialize)]
pub struct Repository {
    repo: String,
    entries: Vec<Value>,
}

fn store(db: &Connection, source: &Repository, replace: bool) -> Result<()> {
    let Some((owner, name)) = source.repo.split_once('/') else {
        return Err("Некорректный адрес репозитория".into());
    };
    let valid = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    };
    if owner.len() > 39
        || name.len() > 100
        || !valid(owner)
        || !valid(name)
        || source.entries.iter().any(|item| {
            !item["repo"]
                .as_str()
                .is_some_and(|repo| repo.eq_ignore_ascii_case(&source.repo))
        })
    {
        return Err("Некорректный кеш репозитория".into());
    }
    let entries = serde_json::to_string(&source.entries).map_err(|error| error.to_string())?;
    if entries.len() > 16 * 1024 * 1024 {
        return Err("Размер кеша репозитория превышает 16 МиБ".into());
    }
    let sql = if replace {
        "INSERT INTO catalog_cache VALUES (?1,?2) ON CONFLICT(repo) DO UPDATE SET entries=excluded.entries"
    } else {
        "INSERT OR IGNORE INTO catalog_cache VALUES (?1,?2)"
    };
    db.execute(sql, params![source.repo, entries])
        .map_err(db_error)?;
    Ok(())
}

#[tauri::command]
pub fn load_catalog(library: State<Library>) -> Result<Vec<Repository>> {
    let db = library.0.lock().map_err(|e| e.to_string())?;
    let mut query = db
        .prepare("SELECT repo, entries FROM catalog_cache ORDER BY repo")
        .map_err(db_error)?;
    let rows = query
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?;
    rows.map(|row| {
        let (repo, raw) = row.map_err(db_error)?;
        let entries = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        Ok(Repository { repo, entries })
    })
    .collect()
}

#[tauri::command]
pub fn save_catalog_source(library: State<Library>, source: Repository) -> Result<()> {
    let db = library.0.lock().map_err(|e| e.to_string())?;
    store(&db, &source, true)
}

#[tauri::command]
pub fn import_catalog_sources(library: State<Library>, sources: Vec<Repository>) -> Result<()> {
    let mut db = library.0.lock().map_err(|e| e.to_string())?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db_error)?;
    for source in &sources {
        store(&tx, source, false)?;
    }
    tx.commit().map_err(db_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_repository_survives_refresh_and_legacy_import_cannot_overwrite_it() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("migration7.sql")).unwrap();
        let original = Repository {
            repo: "owner/repo".into(),
            entries: vec![serde_json::json!({"repo":"owner/repo","code":"x"})],
        };
        store(&db, &original, true).unwrap();
        let empty = Repository {
            repo: "OWNER/repo".into(),
            entries: Vec::new(),
        };
        store(&db, &empty, true).unwrap();
        store(&db, &original, false).unwrap();
        assert_eq!(
            db.query_row("SELECT repo,entries FROM catalog_cache", [], |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?
            )))
            .unwrap(),
            ("owner/repo".into(), "[]".into())
        );
    }
}
