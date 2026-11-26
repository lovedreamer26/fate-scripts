CREATE TABLE deck_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision > 0),
    payload TEXT NOT NULL CHECK (json_valid(payload))
) STRICT;
PRAGMA user_version = 5;
