DELETE FROM meetings WHERE fingerprint LIKE 'sample:%' AND json_extract(data,'$.source')='sample';
