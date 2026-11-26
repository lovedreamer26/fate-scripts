CREATE TABLE bridge_identity (
    origin TEXT PRIMARY KEY,
    server_id TEXT NOT NULL
) STRICT;
PRAGMA user_version = 6;
