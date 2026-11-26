CREATE TABLE foundry_links (
 server_origin TEXT NOT NULL, world_id TEXT NOT NULL, macro_id TEXT NOT NULL,
 script_id TEXT NOT NULL UNIQUE REFERENCES scripts(id) ON DELETE CASCADE,
 PRIMARY KEY(server_origin,world_id,macro_id)
) STRICT;
PRAGMA user_version = 3;
