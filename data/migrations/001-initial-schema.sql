-- Initial task database schema
-- Applied automatically on first startup or migration

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  description TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'medium',
  due DATE,
  project TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_archived BOOLEAN NOT NULL DEFAULT 0,
  completed_at DATE,
  archived_at DATETIME,
  CONSTRAINT valid_status CHECK (status IN ('todo', 'in-progress', 'done')),
  CONSTRAINT valid_priority CHECK (priority IN ('high', 'medium', 'low')),
  CONSTRAINT done_must_be_archived CHECK (NOT (status = 'done' AND is_archived = 0))
);

CREATE TABLE IF NOT EXISTS recurring_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  cadence TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  project TEXT,
  notes TEXT,
  tags TEXT,
  is_archived BOOLEAN NOT NULL DEFAULT 0,
  archived_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT valid_priority CHECK (priority IN ('high', 'medium', 'low')),
  CONSTRAINT valid_cadence CHECK (cadence IN ('daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'quarterly'))
);

CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);

CREATE TABLE IF NOT EXISTS task_links (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  PRIMARY KEY (task_id, url)
);

CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag);
CREATE INDEX IF NOT EXISTS idx_tasks_active_status_due ON tasks(is_archived, status, due);
CREATE INDEX IF NOT EXISTS idx_tasks_active_status_priority ON tasks(is_archived, status, priority);
CREATE INDEX IF NOT EXISTS idx_tasks_active_project_status ON tasks(is_archived, project, status);
CREATE INDEX IF NOT EXISTS idx_recurring_active ON recurring_tasks(is_archived);
