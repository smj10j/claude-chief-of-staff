const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const taskDb = require('../task-db.js');

// Each test suite gets a fresh temp database
let tmpDir;

function setupFreshDb() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  taskDb.configure({ dbPath, root: tmpDir });
  // Copy migrations so initialize() can find them
  const migrationsDir = path.join(tmpDir, 'data', 'migrations');
  // Initialize runs migrations from the real migrations dir, so we just init
  taskDb.initialize();
}

function cleanup() {
  taskDb.close();
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --- ID Generation ---

describe('slugify', () => {
  it('converts title to lowercase slug', () => {
    assert.equal(taskDb.slugify('Explore Paperclip AI'), 'explore-paperclip-ai');
  });

  it('removes special characters', () => {
    assert.equal(taskDb.slugify('Fix bug #123 (urgent!)'), 'fix-bug-123-urgent');
  });

  it('collapses multiple dashes', () => {
    assert.equal(taskDb.slugify('foo---bar'), 'foo-bar');
  });

  it('trims leading/trailing dashes', () => {
    assert.equal(taskDb.slugify('--hello--'), 'hello');
  });

  it('truncates to 80 characters', () => {
    const long = 'a'.repeat(100);
    assert.ok(taskDb.slugify(long).length <= 80);
  });
});

// --- CRUD Operations ---

describe('createTask', () => {
  before(setupFreshDb);
  after(cleanup);

  it('creates a task with defaults', () => {
    const task = taskDb.createTask({ title: 'Test task' });
    assert.equal(task.title, 'Test task');
    assert.equal(task.status, 'todo');
    assert.equal(task.priority, 'medium');
    assert.equal(task.is_archived, 0);
    assert.ok(task.id);
    assert.ok(task.created_at);
  });

  it('creates a task with all fields', () => {
    const task = taskDb.createTask({
      title: 'Full task',
      priority: 'high',
      due: '2026-04-01',
      project: 'test-project',
      tags: ['work', 'admin'],
      notes: 'Some notes here',
      links: ['https://example.com'],
    });
    assert.equal(task.priority, 'high');
    assert.equal(task.due, '2026-04-01');
    assert.equal(task.project, 'test-project');
    assert.deepEqual(task.tags, ['admin', 'work']);
    assert.deepEqual(task.links, ['https://example.com']);
    assert.equal(task.notes, 'Some notes here');
  });

  it('generates unique IDs on collision', () => {
    const t1 = taskDb.createTask({ title: 'Duplicate title' });
    const t2 = taskDb.createTask({ title: 'Duplicate title' });
    assert.notEqual(t1.id, t2.id);
    assert.equal(t2.id, 'duplicate-title-2');
  });
});

describe('getTask', () => {
  before(setupFreshDb);
  after(cleanup);

  it('returns null for non-existent task', () => {
    assert.equal(taskDb.getTask('nonexistent'), null);
  });

  it('returns task with tags and links', () => {
    const created = taskDb.createTask({ title: 'Get me', tags: ['work'], links: ['https://test.com'] });
    const fetched = taskDb.getTask(created.id);
    assert.equal(fetched.title, 'Get me');
    assert.deepEqual(fetched.tags, ['work']);
    assert.deepEqual(fetched.links, ['https://test.com']);
  });
});

describe('updateTask', () => {
  before(setupFreshDb);
  after(cleanup);

  it('updates allowed fields', () => {
    const task = taskDb.createTask({ title: 'Original' });
    const updated = taskDb.updateTask(task.id, { title: 'Updated', priority: 'high', due: '2026-05-01' });
    assert.equal(updated.title, 'Updated');
    assert.equal(updated.priority, 'high');
    assert.equal(updated.due, '2026-05-01');
  });

  it('updates tags', () => {
    const task = taskDb.createTask({ title: 'Tag test', tags: ['old'] });
    const updated = taskDb.updateTask(task.id, { tags: ['new', 'tags'] });
    assert.deepEqual(updated.tags, ['new', 'tags']);
  });

  it('allows todo/in-progress status transitions via update', () => {
    const task = taskDb.createTask({ title: 'Status toggle' });
    const updated = taskDb.updateTask(task.id, { status: 'in-progress' });
    assert.equal(updated.status, 'in-progress');
    const back = taskDb.updateTask(task.id, { status: 'todo' });
    assert.equal(back.status, 'todo');
  });

  it('rejects done status via update', () => {
    const task = taskDb.createTask({ title: 'No done via update' });
    assert.throws(() => taskDb.updateTask(task.id, { status: 'done' }), /Cannot set status/);
  });

  it('rejects is_archived change via update', () => {
    const task = taskDb.createTask({ title: 'No archive change' });
    assert.throws(() => taskDb.updateTask(task.id, { is_archived: 1 }), /Cannot set is_archived/);
  });

  it('rejects update on archived task', () => {
    const task = taskDb.createTask({ title: 'Will archive' });
    taskDb.archiveTask(task.id);
    assert.throws(() => taskDb.updateTask(task.id, { title: 'Nope' }), /Cannot update archived task/);
  });

  it('throws for non-existent task', () => {
    assert.throws(() => taskDb.updateTask('ghost', { title: 'Nope' }), /Task not found/);
  });
});

// --- Lifecycle State Machine ---

describe('markDone', () => {
  before(setupFreshDb);
  after(cleanup);

  it('sets status to done and auto-archives', () => {
    const task = taskDb.createTask({ title: 'Complete me' });
    const done = taskDb.markDone(task.id);
    assert.equal(done.status, 'done');
    assert.equal(done.is_archived, 1);
    assert.ok(done.completed_at);
    assert.ok(done.archived_at);
  });

  it('works on already-archived (dropped) task', () => {
    const task = taskDb.createTask({ title: 'Dropped then done' });
    taskDb.archiveTask(task.id);
    const done = taskDb.markDone(task.id);
    assert.equal(done.status, 'done');
    assert.equal(done.is_archived, 1);
    assert.ok(done.completed_at);
  });

  it('throws for non-existent task', () => {
    assert.throws(() => taskDb.markDone('ghost'), /Task not found/);
  });
});

describe('archiveTask', () => {
  before(setupFreshDb);
  after(cleanup);

  it('archives without changing status', () => {
    const task = taskDb.createTask({ title: 'Drop me' });
    const archived = taskDb.archiveTask(task.id);
    assert.equal(archived.status, 'todo');
    assert.equal(archived.is_archived, 1);
    assert.ok(archived.archived_at);
    assert.equal(archived.completed_at, null);
  });

  it('throws if already archived', () => {
    const task = taskDb.createTask({ title: 'Already gone' });
    taskDb.archiveTask(task.id);
    assert.throws(() => taskDb.archiveTask(task.id), /already archived/);
  });
});

describe('unarchiveTask', () => {
  before(setupFreshDb);
  after(cleanup);

  it('unarchives a dropped task (stays todo)', () => {
    const task = taskDb.createTask({ title: 'Bring back' });
    taskDb.archiveTask(task.id);
    const unarchived = taskDb.unarchiveTask(task.id);
    assert.equal(unarchived.status, 'todo');
    assert.equal(unarchived.is_archived, 0);
    assert.equal(unarchived.archived_at, null);
  });

  it('unarchives a done task (resets to todo)', () => {
    const task = taskDb.createTask({ title: 'Undo completion' });
    taskDb.markDone(task.id);
    const unarchived = taskDb.unarchiveTask(task.id);
    assert.equal(unarchived.status, 'todo');
    assert.equal(unarchived.is_archived, 0);
    assert.equal(unarchived.completed_at, null);
    assert.equal(unarchived.archived_at, null);
  });

  it('throws if task is not archived', () => {
    const task = taskDb.createTask({ title: 'Still active' });
    assert.throws(() => taskDb.unarchiveTask(task.id), /not archived/);
  });
});

// --- Query Functions ---

describe('listActive', () => {
  before(setupFreshDb);
  after(cleanup);

  it('returns only non-archived tasks', () => {
    taskDb.createTask({ title: 'Active 1' });
    taskDb.createTask({ title: 'Active 2' });
    const archived = taskDb.createTask({ title: 'Archived' });
    taskDb.archiveTask(archived.id);

    const active = taskDb.listActive();
    assert.equal(active.length, 2);
    assert.ok(active.every(t => t.is_archived === 0));
  });

  it('sorts by due date (nulls last)', () => {
    // Fresh db for sorting test
    taskDb.close();
    setupFreshDb();

    taskDb.createTask({ title: 'No date' });
    taskDb.createTask({ title: 'Later', due: '2026-12-01' });
    taskDb.createTask({ title: 'Sooner', due: '2026-01-01' });

    const active = taskDb.listActive();
    assert.equal(active[0].title, 'Sooner');
    assert.equal(active[1].title, 'Later');
    assert.equal(active[2].title, 'No date');
  });
});

describe('listArchived', () => {
  before(setupFreshDb);
  after(cleanup);

  it('returns only archived tasks', () => {
    taskDb.createTask({ title: 'Active' });
    const t = taskDb.createTask({ title: 'Done' });
    taskDb.markDone(t.id);

    const archived = taskDb.listArchived();
    assert.equal(archived.length, 1);
    assert.equal(archived[0].is_archived, 1);
  });
});

describe('loadAll', () => {
  before(setupFreshDb);
  after(cleanup);

  it('returns active, archived, and recurring arrays', () => {
    taskDb.createTask({ title: 'Active task' });
    const t = taskDb.createTask({ title: 'Done task' });
    taskDb.markDone(t.id);

    const all = taskDb.loadAll();
    assert.ok(Array.isArray(all.active));
    assert.ok(Array.isArray(all.archived));
    assert.ok(Array.isArray(all.recurring));
    assert.equal(all.active.length, 1);
    assert.equal(all.archived.length, 1);
  });
});

// --- Delete Task ---

describe('deleteTask', () => {
  before(setupFreshDb);
  after(cleanup);

  it('deletes an existing task', () => {
    const task = taskDb.createTask({ title: 'To delete', tags: ['work'] });
    const deleted = taskDb.deleteTask(task.id);
    assert.equal(deleted.id, task.id);

    // Should not be findable
    const found = taskDb.getTask(task.id);
    assert.equal(found, null);
  });

  it('cascades delete to tags and links', () => {
    const task = taskDb.createTask({ title: 'Cascade delete', tags: ['work', 'admin'] });
    const db = taskDb.getDb();

    // Verify tags exist
    const tagsBefore = db.prepare('SELECT * FROM task_tags WHERE task_id = ?').all(task.id);
    assert.equal(tagsBefore.length, 2);

    taskDb.deleteTask(task.id);

    // Tags should be gone
    const tagsAfter = db.prepare('SELECT * FROM task_tags WHERE task_id = ?').all(task.id);
    assert.equal(tagsAfter.length, 0);
  });

  it('throws for non-existent task', () => {
    assert.throws(() => taskDb.deleteTask('nonexistent'), /not found/);
  });
});

// --- Recurring Tasks ---

describe('recurring tasks', () => {
  before(setupFreshDb);
  after(cleanup);

  it('lists recurring tasks after manual insert', () => {
    const db = taskDb.getDb();
    db.prepare(`
      INSERT INTO recurring_tasks (id, title, cadence, priority, tags)
      VALUES ('daily-review', 'Daily review', 'daily', 'medium', '["work"]')
    `).run();

    const recurring = taskDb.listRecurring();
    assert.equal(recurring.length, 1);
    assert.equal(recurring[0].id, 'daily-review');
    assert.deepEqual(recurring[0].tags, ['work']);
  });

  it('updates recurring task fields', () => {
    const updated = taskDb.updateRecurringTask('daily-review', { title: 'Updated review', priority: 'high' });
    assert.equal(updated.title, 'Updated review');
    assert.equal(updated.priority, 'high');
  });

  it('archives recurring task', () => {
    const updated = taskDb.updateRecurringTask('daily-review', { is_archived: true });
    assert.equal(updated.is_archived, 1);
    assert.ok(updated.archived_at);

    // Should not appear in listRecurring
    const recurring = taskDb.listRecurring();
    assert.equal(recurring.length, 0);
  });
});

// --- DB Constraint enforcement ---

describe('database constraints', () => {
  before(setupFreshDb);
  after(cleanup);

  it('rejects invalid status', () => {
    const db = taskDb.getDb();
    assert.throws(() => {
      db.prepare("INSERT INTO tasks (id, title, status) VALUES ('bad', 'Bad', 'invalid')").run();
    });
  });

  it('rejects invalid priority', () => {
    const db = taskDb.getDb();
    assert.throws(() => {
      db.prepare("INSERT INTO tasks (id, title, priority) VALUES ('bad2', 'Bad', 'critical')").run();
    });
  });

  it('enforces done_must_be_archived constraint', () => {
    const db = taskDb.getDb();
    assert.throws(() => {
      db.prepare("INSERT INTO tasks (id, title, status, is_archived) VALUES ('bad3', 'Bad', 'done', 0)").run();
    });
  });

  it('allows done + archived', () => {
    const db = taskDb.getDb();
    db.prepare("INSERT INTO tasks (id, title, status, is_archived) VALUES ('ok1', 'OK', 'done', 1)").run();
    const row = db.prepare("SELECT * FROM tasks WHERE id = 'ok1'").get();
    assert.equal(row.status, 'done');
    assert.equal(row.is_archived, 1);
  });

  it('enforces foreign key on task_tags', () => {
    const db = taskDb.getDb();
    assert.throws(() => {
      db.prepare("INSERT INTO task_tags (task_id, tag) VALUES ('nonexistent', 'work')").run();
    });
  });

  it('cascades delete from tasks to task_tags', () => {
    const db = taskDb.getDb();
    db.prepare("INSERT INTO tasks (id, title) VALUES ('cascade-test', 'Cascade')").run();
    db.prepare("INSERT INTO task_tags (task_id, tag) VALUES ('cascade-test', 'work')").run();
    db.prepare("DELETE FROM tasks WHERE id = 'cascade-test'").run();
    const tags = db.prepare("SELECT * FROM task_tags WHERE task_id = 'cascade-test'").all();
    assert.equal(tags.length, 0);
  });
});

// --- toDueStr validation ---

describe('toDueStr', () => {
  it('accepts null/undefined', () => {
    assert.equal(taskDb.toDueStr(null), null);
    assert.equal(taskDb.toDueStr(undefined), null);
    assert.equal(taskDb.toDueStr(''), null);
  });

  it('accepts valid date-only format', () => {
    assert.equal(taskDb.toDueStr('2026-04-01'), '2026-04-01');
  });

  it('accepts valid date+time format', () => {
    assert.equal(taskDb.toDueStr('2026-04-01 14:00'), '2026-04-01 14:00');
    assert.equal(taskDb.toDueStr('2026-04-01 09:30'), '2026-04-01 09:30');
    assert.equal(taskDb.toDueStr('2026-04-01 00:00'), '2026-04-01 00:00');
    assert.equal(taskDb.toDueStr('2026-04-01 23:59'), '2026-04-01 23:59');
  });

  it('converts Date objects to date-only', () => {
    const d = new Date(2026, 3, 1); // April 1
    assert.equal(taskDb.toDueStr(d), '2026-04-01');
  });

  it('trims whitespace', () => {
    assert.equal(taskDb.toDueStr('  2026-04-01 '), '2026-04-01');
    assert.equal(taskDb.toDueStr('  2026-04-01 14:00  '), '2026-04-01 14:00');
  });

  it('rejects invalid strings', () => {
    assert.throws(() => taskDb.toDueStr('not-a-date'), /Invalid due format/);
    assert.throws(() => taskDb.toDueStr('today'), /Invalid due format/);
    assert.throws(() => taskDb.toDueStr('2026/04/01'), /Invalid due format/);
    assert.throws(() => taskDb.toDueStr('2026-04-01T14:00'), /Invalid due format/);
  });

  it('rejects out-of-range months', () => {
    assert.throws(() => taskDb.toDueStr('2026-13-01'), /Invalid date/);
    assert.throws(() => taskDb.toDueStr('2026-00-01'), /Invalid date/);
  });

  it('rejects out-of-range days', () => {
    assert.throws(() => taskDb.toDueStr('2026-04-32'), /Invalid date/);
    assert.throws(() => taskDb.toDueStr('2026-04-00'), /Invalid date/);
  });

  it('rejects out-of-range hours', () => {
    assert.throws(() => taskDb.toDueStr('2026-04-01 24:00'), /Invalid time/);
    assert.throws(() => taskDb.toDueStr('2026-04-01 25:00'), /Invalid time/);
  });

  it('rejects out-of-range minutes', () => {
    assert.throws(() => taskDb.toDueStr('2026-04-01 14:60'), /Invalid time/);
  });
});

// --- isOverdue ---

describe('isOverdue', () => {
  it('returns false for null due', () => {
    assert.equal(taskDb.isOverdue({ due: null }), false);
  });

  it('returns false for future date-only', () => {
    assert.equal(taskDb.isOverdue({ due: '2099-12-31' }), false);
  });

  it('returns true for past date-only', () => {
    assert.equal(taskDb.isOverdue({ due: '2020-01-01' }), true);
  });

  it('returns false for future date+time', () => {
    assert.equal(taskDb.isOverdue({ due: '2099-12-31 23:59' }), false);
  });

  it('returns true for past date+time', () => {
    assert.equal(taskDb.isOverdue({ due: '2020-01-01 09:00' }), true);
  });
});

// --- localDateStr / localTimeStr ---

describe('localDateStr', () => {
  it('returns YYYY-MM-DD from a Date object', () => {
    const d = new Date(2026, 2, 15); // March 15
    assert.equal(taskDb.localDateStr(d), '2026-03-15');
  });

  it('pads single-digit months and days', () => {
    const d = new Date(2026, 0, 5); // Jan 5
    assert.equal(taskDb.localDateStr(d), '2026-01-05');
  });
});

describe('localTimeStr', () => {
  it('returns HH:MM from a Date object', () => {
    const d = new Date(2026, 0, 1, 14, 30);
    assert.equal(taskDb.localTimeStr(d), '14:30');
  });

  it('pads single-digit hours and minutes', () => {
    const d = new Date(2026, 0, 1, 9, 5);
    assert.equal(taskDb.localTimeStr(d), '09:05');
  });
});

// --- Time-based task CRUD ---

describe('time-based due dates', () => {
  before(setupFreshDb);
  after(cleanup);

  it('creates a task with date+time due', () => {
    const task = taskDb.createTask({ title: 'Timed task', due: '2026-04-01 14:00' });
    assert.equal(task.due, '2026-04-01 14:00');
  });

  it('updates a task to add time', () => {
    const task = taskDb.createTask({ title: 'Add time later' });
    const updated = taskDb.updateTask(task.id, { due: '2026-04-01 09:30' });
    assert.equal(updated.due, '2026-04-01 09:30');
  });

  it('updates a task to remove time (date-only)', () => {
    const task = taskDb.createTask({ title: 'Remove time', due: '2026-04-01 14:00' });
    const updated = taskDb.updateTask(task.id, { due: '2026-04-01' });
    assert.equal(updated.due, '2026-04-01');
  });

  it('rejects invalid due via createTask', () => {
    assert.throws(() => taskDb.createTask({ title: 'Bad date', due: 'not-valid' }), /Invalid due format/);
  });

  it('rejects invalid due via updateTask', () => {
    const task = taskDb.createTask({ title: 'Bad update target' });
    assert.throws(() => taskDb.updateTask(task.id, { due: 'garbage' }), /Invalid due format/);
  });

  it('sorts mixed date-only and date+time correctly', () => {
    taskDb.close();
    setupFreshDb();

    taskDb.createTask({ title: 'Date only', due: '2026-04-01' });
    taskDb.createTask({ title: 'Morning', due: '2026-04-01 09:00' });
    taskDb.createTask({ title: 'Afternoon', due: '2026-04-01 14:00' });
    taskDb.createTask({ title: 'Next day', due: '2026-04-02' });

    const active = taskDb.listActive();
    assert.equal(active[0].title, 'Date only');     // 2026-04-01
    assert.equal(active[1].title, 'Morning');        // 2026-04-01 09:00
    assert.equal(active[2].title, 'Afternoon');      // 2026-04-01 14:00
    assert.equal(active[3].title, 'Next day');       // 2026-04-02
  });
});
