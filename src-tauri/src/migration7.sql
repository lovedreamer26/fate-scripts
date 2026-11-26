CREATE TABLE catalog_cache (
    repo TEXT PRIMARY KEY COLLATE NOCASE,
    entries TEXT NOT NULL CHECK (json_valid(entries) AND json_type(entries) = 'array')
) STRICT;
PRAGMA user_version = 7;
