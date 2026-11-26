CREATE TABLE folders (
    world TEXT NOT NULL,
    path TEXT NOT NULL CHECK(length(path) > 0),
    PRIMARY KEY(world, path)
) STRICT;
-- Preserve existing paths, including all ancestor folders.
WITH RECURSIVE parts(world, path, rest) AS (
    SELECT COALESCE(json_extract(payload,'$.world'), ''), '', json_extract(payload,'$.folder') || '/'
    FROM scripts WHERE length(json_extract(payload,'$.folder')) > 0
    UNION ALL
    SELECT world, CASE WHEN path = '' THEN trim(substr(rest,1,instr(rest,'/')-1))
        WHEN trim(substr(rest,1,instr(rest,'/')-1)) = '' THEN path
        ELSE path || '/' || trim(substr(rest,1,instr(rest,'/')-1)) END,
        substr(rest,instr(rest,'/')+1)
    FROM parts WHERE rest <> ''
)
INSERT OR IGNORE INTO folders(world,path) SELECT world,path FROM parts WHERE path <> '';
PRAGMA user_version = 2;
