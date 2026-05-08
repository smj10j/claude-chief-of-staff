// Shared data access module for task database.
// Used by bin/db/task-cli.js — single source of truth for SQLite ops.
// Consumer never writes SQL directly.

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

let ROOT = path.resolve(__dirname, '..', '..');
let DB_PATH = path.join(ROOT, 'data', 'cos.db');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let db = null;

// --- Configuration (for testing) ---

function configure(opts = {}) {
  close();
  if (opts.dbPath) DB_PATH = opts.dbPath;
  if (opts.root) ROOT = opts.root;
}

// --- Connection management ---

function getDb() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

// --- Migration runner ---

function ensureSchemaTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      description TEXT
    )
  `);
}

function getAppliedVersions(database) {
  const rows = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  return new Set(rows.map(r => r.version));
}

function runMigrations(database) {
  ensureSchemaTable(database);
  const applied = getAppliedVersions(database);

  // Find and run pending SQL migrations
  if (!fs.existsSync(MIGRATIONS_DIR)) return;
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = parseInt(file.split('-')[0], 10);
    if (isNaN(version) || applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    database.exec(sql);
    database.prepare(
      'INSERT INTO schema_migrations (version, description) VALUES (?, ?)'
    ).run(version, file);
    console.log(`  [migration] Applied ${file}`);
  }
}

// --- Initialization (called on startup) ---

function initialize() {
  const database = getDb();
  runMigrations(database);
  return database;
}

// --- Helpers ---

function localDateStr(d) {
  if (!d) d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function localTimeStr(d) {
  if (!d) d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function validateDateRange(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    throw new Error(`Invalid date: "${dateStr}". Month must be 1-12, day must be 1-31.`);
  }
}

function validateTimeRange(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error(`Invalid time: "${timeStr}". Hours must be 0-23, minutes must be 0-59.`);
  }
}

function toDueStr(val) {
  if (!val) return null;
  // Date objects -> date-only string (no current caller passes Date objects with
  // meaningful time components; if that changes, extend to include localTimeStr)
  if (val instanceof Date) return localDateStr(val);
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    validateDateRange(s);
    return s;
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) {
    validateDateRange(s.slice(0, 10));
    validateTimeRange(s.slice(11));
    return s;
  }
  throw new Error(`Invalid due format: "${s}". Expected YYYY-MM-DD or YYYY-MM-DD HH:MM (e.g., 2026-04-01 or 2026-04-01 14:00)`);
}

function isOverdue(task) {
  if (!task.due) return false;
  const now = new Date();
  const today = localDateStr(now);
  if (task.due.length === 10) {
    return task.due < today;
  }
  return task.due < `${today} ${localTimeStr(now)}`;
}

// --- ID generation ---

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function generateId(title) {
  const database = getDb();
  const base = slugify(title);
  if (!base) return 'task-' + Date.now();

  const existing = database.prepare('SELECT id FROM tasks WHERE id = ?').get(base);
  if (!existing) return base;

  let suffix = 2;
  while (true) {
    const candidate = `${base}-${suffix}`;
    const exists = database.prepare('SELECT id FROM tasks WHERE id = ?').get(candidate);
    if (!exists) return candidate;
    suffix++;
  }
}

// --- Task queries ---

function listActive() {
  const database = getDb();
  const tasks = database.prepare(`
    SELECT * FROM tasks WHERE is_archived = 0 ORDER BY
      CASE WHEN due IS NULL THEN 1 ELSE 0 END,
      due ASC
  `).all();
  return tasks.map(t => attachTagsAndLinks(database, t));
}

function listArchived() {
  const database = getDb();
  const tasks = database.prepare(
    'SELECT * FROM tasks WHERE is_archived = 1 ORDER BY archived_at DESC'
  ).all();
  return tasks.map(t => attachTagsAndLinks(database, t));
}

function listRecurring() {
  const database = getDb();
  return database.prepare(
    'SELECT * FROM recurring_tasks WHERE is_archived = 0 ORDER BY title'
  ).all().map(t => ({
    ...t,
    tags: t.tags ? JSON.parse(t.tags) : [],
  }));
}

function getTask(id) {
  const database = getDb();
  const task = database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return null;
  return attachTagsAndLinks(database, task);
}

function attachTagsAndLinks(database, task) {
  const tags = database.prepare('SELECT tag FROM task_tags WHERE task_id = ?').all(task.id);
  const links = database.prepare('SELECT url FROM task_links WHERE task_id = ?').all(task.id);
  return {
    ...task,
    tags: tags.map(t => t.tag),
    links: links.map(l => l.url),
  };
}

// GET /api/tasks compatible shape
function loadAll() {
  return {
    active: listActive(),
    archived: listArchived(),
    recurring: listRecurring(),
  };
}

// --- Task mutations ---

function createTask({ title, priority, due, project, tags, notes, links }) {
  const database = getDb();
  const id = generateId(title);
  const now = new Date().toISOString();

  database.prepare(`
    INSERT INTO tasks (id, title, status, priority, due, project, notes, created_at, updated_at, is_archived)
    VALUES (?, ?, 'todo', ?, ?, ?, ?, ?, ?, 0)
  `).run(id, title, priority || 'medium', toDueStr(due), project || null, notes || null, now, now);

  if (tags && tags.length) {
    const stmt = database.prepare('INSERT INTO task_tags (task_id, tag) VALUES (?, ?)');
    for (const tag of tags) stmt.run(id, tag);
  }
  if (links && links.length) {
    const stmt = database.prepare('INSERT INTO task_links (task_id, url) VALUES (?, ?)');
    for (const url of links) stmt.run(id, url);
  }

  return getTask(id);
}

function updateTask(id, fields) {
  const database = getDb();
  const task = database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) throw new Error(`Task not found: ${id}`);
  if (task.is_archived) throw new Error(`Cannot update archived task: ${id}. Use unarchive first.`);

  // Reject lifecycle field changes (archive/completion fields)
  const forbidden = ['is_archived', 'completed_at', 'archived_at'];
  for (const key of forbidden) {
    if (key in fields) throw new Error(`Cannot set ${key} via update. Use action endpoints (done/archive/unarchive).`);
  }

  // Status: allow todo <-> in-progress transitions, block done (must use markDone)
  if ('status' in fields) {
    const allowed_statuses = ['todo', 'in-progress'];
    if (!allowed_statuses.includes(fields.status)) {
      throw new Error(`Cannot set status to '${fields.status}' via update. Use action endpoints (done/archive/unarchive).`);
    }
  }

  const allowed = ['title', 'status', 'priority', 'due', 'project', 'notes'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (key in fields) {
      let val = fields[key] === undefined ? null : fields[key];
      if (key === 'due') val = toDueStr(val);
      sets.push(`${key} = ?`);
      values.push(val);
    }
  }

  if (sets.length > 0) {
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    database.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  // Update tags if provided
  if ('tags' in fields) {
    database.prepare('DELETE FROM task_tags WHERE task_id = ?').run(id);
    if (fields.tags && fields.tags.length) {
      const stmt = database.prepare('INSERT INTO task_tags (task_id, tag) VALUES (?, ?)');
      for (const tag of fields.tags) stmt.run(id, tag);
    }
  }

  // Update links if provided
  if ('links' in fields) {
    database.prepare('DELETE FROM task_links WHERE task_id = ?').run(id);
    if (fields.links && fields.links.length) {
      const stmt = database.prepare('INSERT INTO task_links (task_id, url) VALUES (?, ?)');
      for (const url of fields.links) stmt.run(id, url);
    }
  }

  return getTask(id);
}

function markDone(id) {
  const database = getDb();
  const task = database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) throw new Error(`Task not found: ${id}`);

  const now = new Date().toISOString();
  const today = localDateStr();

  database.prepare(`
    UPDATE tasks SET status = 'done', completed_at = ?, is_archived = 1, archived_at = ?, updated_at = ?
    WHERE id = ?
  `).run(today, now, now, id);

  return getTask(id);
}

function archiveTask(id) {
  const database = getDb();
  const task = database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) throw new Error(`Task not found: ${id}`);
  if (task.is_archived) throw new Error(`Task already archived: ${id}`);

  const now = new Date().toISOString();

  database.prepare(`
    UPDATE tasks SET is_archived = 1, archived_at = ?, updated_at = ? WHERE id = ?
  `).run(now, now, id);

  return getTask(id);
}

function unarchiveTask(id) {
  const database = getDb();
  const task = database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) throw new Error(`Task not found: ${id}`);
  if (!task.is_archived) throw new Error(`Task is not archived: ${id}`);

  const now = new Date().toISOString();

  if (task.status === 'done') {
    // Reset to todo, clear completion
    database.prepare(`
      UPDATE tasks SET status = 'todo', is_archived = 0, archived_at = NULL, completed_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, id);
  } else {
    database.prepare(`
      UPDATE tasks SET is_archived = 0, archived_at = NULL, updated_at = ? WHERE id = ?
    `).run(now, id);
  }

  return getTask(id);
}

function deleteTask(id) {
  const database = getDb();
  const task = database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) throw new Error(`Task not found: ${id}`);

  // CASCADE deletes task_tags and task_links
  database.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return task;
}

// --- Recurring task mutations ---

function updateRecurringTask(id, fields) {
  const database = getDb();
  const task = database.prepare('SELECT * FROM recurring_tasks WHERE id = ?').get(id);
  if (!task) throw new Error(`Recurring task not found: ${id}`);

  const allowed = ['title', 'cadence', 'priority', 'project', 'notes', 'tags', 'is_archived'];
  const sets = [];
  const values = [];

  for (const key of allowed) {
    if (key in fields) {
      if (key === 'tags') {
        sets.push('tags = ?');
        values.push(fields.tags ? JSON.stringify(fields.tags) : null);
      } else if (key === 'is_archived' && fields.is_archived) {
        sets.push('is_archived = 1');
        sets.push('archived_at = ?');
        values.push(new Date().toISOString());
      } else if (key === 'is_archived' && !fields.is_archived) {
        sets.push('is_archived = 0');
        sets.push('archived_at = NULL');
      } else {
        sets.push(`${key} = ?`);
        values.push(fields[key]);
      }
    }
  }

  if (sets.length > 0) {
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    database.prepare(`UPDATE recurring_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  const updated = database.prepare('SELECT * FROM recurring_tasks WHERE id = ?').get(id);
  return { ...updated, tags: updated.tags ? JSON.parse(updated.tags) : [] };
}

module.exports = {
  configure,
  initialize,
  close,
  getDb,
  loadAll,
  listActive,
  listArchived,
  listRecurring,
  getTask,
  createTask,
  updateTask,
  markDone,
  archiveTask,
  unarchiveTask,
  deleteTask,
  updateRecurringTask,
  generateId,
  slugify,
  localDateStr,
  localTimeStr,
  isOverdue,
  toDueStr,
  get DB_PATH() { return DB_PATH; },
};
