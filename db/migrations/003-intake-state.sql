CREATE TABLE intake_state(session_id TEXT PRIMARY KEY REFERENCES sessions(id),content_json TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE assistant_items(item_id TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(id),response_id TEXT,turn_id TEXT NOT NULL,PRIMARY KEY(item_id,session_id));
CREATE TRIGGER turns_update AFTER UPDATE OF text_redacted ON conversation_turns BEGIN UPDATE turns_fts SET text_redacted=new.text_redacted WHERE rowid=new.rowid; END;
