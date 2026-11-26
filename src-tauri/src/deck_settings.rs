use super::{Library, Result, db_error};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

#[derive(Serialize, Deserialize)]
pub struct DeckSettings {
    revision: i64,
    payload: Value,
}

fn read(db: &Connection) -> Result<Option<DeckSettings>> {
    let saved = db
        .query_row(
            "SELECT revision, payload FROM deck_settings WHERE singleton=1",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    saved
        .map(|(revision, payload)| {
            let payload = serde_json::from_str(&payload).map_err(|error| error.to_string())?;
            Ok(DeckSettings { revision, payload })
        })
        .transpose()
}

fn write(db: &Connection, revision: i64, payload: Value) -> Result<DeckSettings> {
    let json = payload.to_string();
    if json.len() > 16 * 1024 * 1024 || !payload.is_object() {
        return Err("Некорректная конфигурация панели или превышен лимит 16 МиБ".into());
    }
    let changed = if revision == 0 {
        db.execute("INSERT OR IGNORE INTO deck_settings VALUES (1,1,?1)", [&json])
    } else {
        db.execute(
            "UPDATE deck_settings SET revision=revision+1,payload=?1 WHERE singleton=1 AND revision=?2",
            params![json, revision],
        )
    }.map_err(db_error)?;
    if changed != 1 {
        return Err(
            "Панель изменилась в другом окне. Проверьте текущие настройки и повторите изменение."
                .into(),
        );
    }
    Ok(DeckSettings {
        revision: revision + 1,
        payload,
    })
}

#[tauri::command]
pub fn load_deck(library: State<Library>) -> Result<Option<DeckSettings>> {
    let db = library.0.lock().map_err(|error| error.to_string())?;
    read(&db)
}

#[tauri::command]
pub fn save_deck(library: State<Library>, revision: i64, payload: Value) -> Result<DeckSettings> {
    let db = library.0.lock().map_err(|error| error.to_string())?;
    write(&db, revision, payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_windows_cannot_overwrite_newer_panel_or_images() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("migration5.sql")).unwrap();
        assert!(read(&db).unwrap().is_none());
        let first = serde_json::json!({"tabs":[],"size":110});
        let second = serde_json::json!({"tabs":[{"buttons":[{"image":"data:image/png;base64,AAAA"}]}],"size":125});
        let saved = write(&db, 0, first.clone()).unwrap();
        assert!(write(&db, 0, first.clone()).is_err());
        assert_eq!(
            write(&db, saved.revision, second.clone()).unwrap().revision,
            2
        );
        assert!(write(&db, saved.revision, first).is_err());
        assert_eq!(read(&db).unwrap().unwrap().payload, second);
    }
}
