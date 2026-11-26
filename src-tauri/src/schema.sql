CREATE TABLE scripts (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    modified TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE versions (
    script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    number INTEGER NOT NULL CHECK (number > 0),
    code TEXT NOT NULL,
    source TEXT NOT NULL,
    created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (script_id, number)
) STRICT;

PRAGMA user_version = 1;
