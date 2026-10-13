ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'seeded';
CREATE TABLE browser_calls(session_id TEXT PRIMARY KEY REFERENCES sessions(id),owner_id TEXT NOT NULL REFERENCES users(id),provider_call_id TEXT,status TEXT NOT NULL,model TEXT NOT NULL,voice TEXT NOT NULL,last_seen INTEGER NOT NULL);
CREATE TABLE demo_ticket_results(draft_id TEXT PRIMARY KEY REFERENCES ticket_drafts(id),ticket_id TEXT NOT NULL,ticket_number TEXT NOT NULL);
