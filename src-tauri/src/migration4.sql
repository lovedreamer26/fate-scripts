CREATE TABLE run_reports (run_id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)), created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))) STRICT;
PRAGMA user_version = 4;
