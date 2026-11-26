CREATE TABLE bridge_world_identity (
    origin TEXT NOT NULL,
    world_id TEXT NOT NULL,
    identity TEXT NOT NULL,
    PRIMARY KEY (origin, world_id)
) STRICT;
PRAGMA user_version = 8;
