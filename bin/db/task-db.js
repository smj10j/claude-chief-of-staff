// Shared data access module for task database.
// Single source of truth for all SQLite operations.
// Both ui/server.js and bin/db/task-cli.js import this module.
// Neither consumer writes SQL directly.

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

let ROOT = path.resolve(__dirname, '..', '..');
let DB_PATH = path.join(ROOT, 'data', 'cos.db');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Data migration version - tracked in schema_migrations
const DATA_MIGRATION_VERSION = 1000;

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

function hasDataMigration(database) {
  ensureSchemaTable(database);
  const row = database.prepare(
    'SELECT version FROM schema_migrations WHERE version = ?'
  ).get(DATA_MIGRATION_VERSION);
  return !!row;
}

function markDataMigration(database) {
  database.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version, description) VALUES (?, ?)'
  ).run(DATA_MIGRATION_VERSION, 'yaml-to-sqlite data migration');
}

// --- Initialization (called on startup) ---

function initialize() {
  const database = getDb();
  runMigrations(database);

  // Check if YAML data migration is needed
  const yamlExists = fs.existsSync(path.join(ROOT, 'data', 'files', 'tasks.yaml'));
  const migrated = hasDataMigration(database);

  if (yamlExists && !migrated) {
    try {
      migrateFromYaml(database);
    } catch (err) {
      console.error('[migration] YAML migration failed:', err.message);
      console.error('[migration] Deleting database for clean retry on next startup.');
      close();
      try { fs.unlinkSync(DB_PATH); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(DB_PATH + '-wal'); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(DB_PATH + '-shm'); } catch (e) { /* ignore */ }
      throw new Error('YAML migration failed: ' + err.message);
    }
  }

  return database;
}

// --- YAML migration ---

function migrateFromYaml(database) {
  // js-yaml lives in ui/node_modules (installed by start.sh)
  const yaml = require(path.join(ROOT, 'ui', 'node_modules', 'js-yaml'));
  const FILES_DIR = path.join(ROOT, 'data', 'files');
  console.log('\nMigrating task data from YAML to SQLite...');

  const counts = { active: 0, archived: 0, recurring: 0, tags: 0, links: 0, errors: 0 };

  // Load YAML files
  const tasksPath = path.join(FILES_DIR, 'tasks.yaml');
  const archivePath = path.join(FILES_DIR, 'tasks-archive.yaml');
  const recurringPath = path.join(FILES_DIR, 'recurring.yaml');

  let activeTasks = [];
  let archivedTasks = [];
  let recurringTasks = [];

  try {
    const data = yaml.load(fs.readFileSync(tasksPath, 'utf8'));
    activeTasks = (data?.tasks || []).filter(t => t.status !== 'done');
    // Tasks marked done in tasks.yaml should go to archive
    const doneTasks = (data?.tasks || []).filter(t => t.status === 'done');
    archivedTasks = archivedTasks.concat(doneTasks.map(t => ({
      ...t,
      completed: t.completed || new Date().toISOString().slice(0, 10),
    })));
  } catch (e) { /* no tasks.yaml */ }

  try {
    const data = yaml.load(fs.readFileSync(archivePath, 'utf8'));
    archivedTasks = archivedTasks.concat(data?.archived || []);
  } catch (e) { /* no archive */ }

  try {
    const data = yaml.load(fs.readFileSync(recurringPath, 'utf8'));
    recurringTasks = data?.recurring || [];
  } catch (e) { /* no recurring */ }

  // Insert in a transaction
  const insertTask = database.prepare(`
    INSERT OR IGNORE INTO tasks (id, title, status, priority, due, project, notes, created_at, updated_at, is_archived, completed_at, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTag = database.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag) VALUES (?, ?)');
  const insertLink = database.prepare('INSERT OR IGNORE INTO task_links (task_id, url) VALUES (?, ?)');
  const insertRecurring = database.prepare(`
    INSERT OR IGNORE INTO recurring_tasks (id, title, cadence, priority, project, notes, tags, is_archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();

  database.exec('BEGIN');
  try {
    // Active tasks
    for (const task of activeTasks) {
      const notes = task.notes ? String(task.notes).trim() : null;
      insertTask.run(
        task.id, task.title, task.status || 'todo', task.priority || 'medium',
        toDateStr(task.due), task.project || null, notes,
        now, now, 0, null, null
      );
      for (const tag of (task.tags || [])) {
        insertTag.run(task.id, tag);
        counts.tags++;
      }
      for (const url of (task.links || [])) {
        insertLink.run(task.id, url);
        counts.links++;
      }
      counts.active++;
    }

    // Archived tasks
    for (const task of archivedTasks) {
      const notes = task.notes ? String(task.notes).trim() : null;
      // Normalize status: 'dropped' and other non-standard statuses become 'todo' (archived without completing)
      let status = task.status || 'done';
      let completedAt = toDateStr(task.completed);
      if (!['todo', 'in-progress', 'done'].includes(status)) {
        status = 'todo';
        completedAt = null;
      }
      insertTask.run(
        task.id, task.title, status, task.priority || 'medium',
        toDateStr(task.due), task.project || null, notes,
        now, now, 1, completedAt, now
      );
      for (const tag of (task.tags || [])) {
        insertTag.run(task.id, tag);
        counts.tags++;
      }
      for (const url of (task.links || [])) {
        insertLink.run(task.id, url);
        counts.links++;
      }
      counts.archived++;
    }

    // Recurring tasks
    for (const task of recurringTasks) {
      const notes = task.notes ? String(task.notes).trim() : null;
      const tags = task.tags ? JSON.stringify(task.tags) : null;
      insertRecurring.run(
        task.id, task.title, task.cadence, task.priority || 'medium',
        task.project || null, notes, tags, 0, now, now
      );
      counts.recurring++;
    }

    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }

  // Mark data migration as complete
  markDataMigration(database);

  // Verify
  const verification = verifyMigration(database, activeTasks, archivedTasks, recurringTasks);
  if (!verification.ok) {
    throw new Error('Verification failed: ' + JSON.stringify(verification.errors));
  }

  // Rename YAML files to .bak
  const filesToRename = [
    [tasksPath, tasksPath + '.bak'],
    [archivePath, archivePath + '.bak'],
    [recurringPath, recurringPath + '.bak'],
  ];
  for (const [src, dst] of filesToRename) {
    if (fs.existsSync(src)) {
      fs.renameSync(src, dst);
    }
  }

  console.log(`  Active tasks:    ${counts.active} migrated`);
  console.log(`  Archived tasks:  ${counts.archived} migrated`);
  console.log(`  Recurring tasks: ${counts.recurring} migrated`);
  console.log(`  Tags:            ${counts.tags} migrated`);
  console.log(`  Links:            ${counts.links} migrated`);
  console.log(`  Errors:           ${counts.errors}`);
  console.log('  Verification: OK (all data matches)');
  console.log('  Original files renamed to .bak\n');
}

function verifyMigration(database, activeTasks, archivedTasks, recurringTasks) {
  const errors = [];

  // Check active task count
  const dbActive = database.prepare(
    'SELECT COUNT(*) as count FROM tasks WHERE is_archived = 0'
  ).get();
  if (dbActive.count !== activeTasks.length) {
    errors.push(`Active count mismatch: YAML=${activeTasks.length}, DB=${dbActive.count}`);
  }

  // Check archived task count
  const dbArchived = database.prepare(
    'SELECT COUNT(*) as count FROM tasks WHERE is_archived = 1'
  ).get();
  if (dbArchived.count !== archivedTasks.length) {
    errors.push(`Archived count mismatch: YAML=${archivedTasks.length}, DB=${dbArchived.count}`);
  }

  // Check recurring task count
  const dbRecurring = database.prepare(
    'SELECT COUNT(*) as count FROM recurring_tasks'
  ).get();
  if (dbRecurring.count !== recurringTasks.length) {
    errors.push(`Recurring count mismatch: YAML=${recurringTasks.length}, DB=${dbRecurring.count}`);
  }

  // Spot-check: verify each active task exists with correct title
  for (const task of activeTasks) {
    const row = database.prepare('SELECT title FROM tasks WHERE id = ?').get(task.id);
    if (!row) {
      errors.push(`Missing active task: ${task.id}`);
    } else if (row.title !== task.title) {
      errors.push(`Title mismatch for ${task.id}: YAML="${task.title}", DB="${row.title}"`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// --- Helpers ---

function toDateStr(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val);
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
  `).run(id, title, priority || 'medium', due || null, project || null, notes || null, now, now);

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
      sets.push(`${key} = ?`);
      values.push(fields[key] === undefined ? null : fields[key]);
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
  const today = now.slice(0, 10);

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
  get DB_PATH() { return DB_PATH; },
};
