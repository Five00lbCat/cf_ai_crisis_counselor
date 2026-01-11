CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    scenario_type TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    feedback TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS user_progress (
    user_id TEXT PRIMARY KEY,
    total_sessions INTEGER DEFAULT 0,
    scenarios_completed TEXT,
    average_score REAL,
    last_session_at INTEGER
);