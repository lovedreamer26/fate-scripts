UPDATE scripts SET payload=json_set(payload,'$.folder', ?3 || substr(json_extract(payload,'$.folder'),length(?2)+1))
WHERE json_extract(payload,'$.world')=?1 AND (json_extract(payload,'$.folder')=?2 OR substr(json_extract(payload,'$.folder'),1,length(?2)+1)=?2||'/');
