#!/usr/bin/env node
// Task CLI - thin wrapper over bin/db/task-db.js
// Primary consumer: Claude Code (default output is compact/token-efficient)
// Usage: bash bin/db/task-cli.sh <command> [args] [--format compact|json|table]

const taskDb = require('./task-db.js');
const path = require('path');

const COMMANDS = {
  list: 'List tasks (active by default)',
  get: 'Get a single task by ID',
  add: 'Create a new task',
  update: 'Update task fields',
  done: 'Mark a task as done',
  archive: 'Archive (drop) a task',
  unarchive: 'Unarchive a task',
  recurring: 'List recurring tasks',
};

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  if (!COMMANDS[command]) {
    console.error(`Unknown command: ${command}`);
    console.error('Run with --help for usage.');
    process.exit(1);
  }

  try {
    taskDb.initialize();
  } catch (err) {
    console.error('Database initialization failed:', err.message);
    process.exit(1);
  }

  try {
    const flags = parseFlags(args.slice(1));
    const format = flags.format || 'compact';

    switch (command) {
      case 'list': cmdList(flags, format); break;
      case 'get': cmdGet(flags, format); break;
      case 'add': cmdAdd(flags, format); break;
      case 'update': cmdUpdate(flags, format); break;
      case 'done': cmdDone(flags, format); break;
      case 'archive': cmdArchive(flags, format); break;
      case 'unarchive': cmdUnarchive(flags, format); break;
      case 'recurring': cmdRecurring(flags, format); break;
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    taskDb.close();
  }
}

// --- Commands ---

function cmdList(flags, format) {
  let tasks;
  if (flags.archived) {
    tasks = taskDb.listArchived();
    if (flags.since) {
      tasks = tasks.filter(t => t.archived_at >= flags.since);
    }
  } else {
    tasks = taskDb.listActive();
  }

  if (flags.tag) {
    tasks = tasks.filter(t => t.tags && t.tags.includes(flags.tag));
  }
  if (flags.project) {
    tasks = tasks.filter(t => t.project === flags.project);
  }
  if (flags['due-by']) {
    const cutoff = flags['due-by'] === 'today'
      ? new Date().toISOString().slice(0, 10)
      : flags['due-by'];
    tasks = tasks.filter(t => t.due && t.due <= cutoff);
  }

  outputTasks(tasks, format);
}

function cmdGet(flags, format) {
  const id = flags._positional[0];
  if (!id) { console.error('Usage: get <task-id>'); process.exit(1); }
  const task = taskDb.getTask(id);
  if (!task) { console.error(`Task not found: ${id}`); process.exit(1); }
  outputTasks([task], format);
}

function cmdAdd(flags, format) {
  const title = flags._positional.join(' ');
  if (!title) { console.error('Usage: add <title> [--due DATE] [--priority high|medium|low] [--tags tag1,tag2] [--project ID] [--notes TEXT]'); process.exit(1); }

  const task = taskDb.createTask({
    title,
    priority: flags.priority,
    due: flags.due,
    project: flags.project,
    tags: flags.tags ? flags.tags.split(',').map(t => t.trim()) : undefined,
    notes: flags.notes,
  });
  outputTasks([task], format);
}

function cmdUpdate(flags, format) {
  const id = flags._positional[0];
  if (!id) { console.error('Usage: update <task-id> [--title TEXT] [--due DATE] [--priority high|medium|low] [--tags tag1,tag2] [--project ID] [--notes TEXT]'); process.exit(1); }

  const fields = {};
  if (flags.title) fields.title = flags.title;
  if (flags.priority) fields.priority = flags.priority;
  if ('due' in flags) fields.due = flags.due || null;
  if (flags.project !== undefined) fields.project = flags.project || null;
  if (flags.notes !== undefined) fields.notes = flags.notes || null;
  if (flags.tags) fields.tags = flags.tags.split(',').map(t => t.trim());

  const task = taskDb.updateTask(id, fields);
  outputTasks([task], format);
}

function cmdDone(flags, format) {
  const id = flags._positional[0];
  if (!id) { console.error('Usage: done <task-id>'); process.exit(1); }
  const task = taskDb.markDone(id);
  outputTasks([task], format);
}

function cmdArchive(flags, format) {
  const id = flags._positional[0];
  if (!id) { console.error('Usage: archive <task-id>'); process.exit(1); }
  const task = taskDb.archiveTask(id);
  outputTasks([task], format);
}

function cmdUnarchive(flags, format) {
  const id = flags._positional[0];
  if (!id) { console.error('Usage: unarchive <task-id>'); process.exit(1); }
  const task = taskDb.unarchiveTask(id);
  outputTasks([task], format);
}

function cmdRecurring(flags, format) {
  const tasks = taskDb.listRecurring();
  if (format === 'json') {
    console.log(JSON.stringify(tasks, null, 2));
  } else if (format === 'table') {
    console.log('ID'.padEnd(35) + 'CADENCE'.padEnd(12) + 'PRIORITY'.padEnd(10) + 'TITLE');
    console.log('-'.repeat(80));
    for (const t of tasks) {
      console.log(
        t.id.padEnd(35) +
        t.cadence.padEnd(12) +
        t.priority.padEnd(10) +
        t.title
      );
    }
  } else {
    // compact
    console.log('id\tcadence\tpriority\ttitle');
    for (const t of tasks) {
      console.log(`${t.id}\t${t.cadence}\t${t.priority}\t${t.title}`);
    }
  }
}

// --- Output ---

function outputTasks(tasks, format) {
  if (format === 'json') {
    console.log(JSON.stringify(tasks, null, 2));
  } else if (format === 'table') {
    console.log('ID'.padEnd(40) + 'STATUS'.padEnd(14) + 'PRI'.padEnd(8) + 'DUE'.padEnd(12) + 'PROJECT'.padEnd(25) + 'TITLE');
    console.log('-'.repeat(120));
    for (const t of tasks) {
      console.log(
        (t.id || '').padEnd(40) +
        (t.status || '').padEnd(14) +
        (t.priority || '').padEnd(8) +
        (t.due || '').padEnd(12) +
        (t.project || '').padEnd(25) +
        (t.title || '')
      );
    }
  } else {
    // compact (default) - tab-separated, header row, all columns present
    console.log('id\tstatus\tpriority\tdue\tproject\ttitle');
    for (const t of tasks) {
      console.log(`${t.id}\t${t.status}\t${t.priority}\t${t.due || ''}\t${t.project || ''}\t${t.title}`);
    }
  }
}

// --- Flag parsing ---

function parseFlags(args) {
  const flags = { _positional: [] };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else {
      flags._positional.push(arg);
      i++;
    }
  }
  return flags;
}

// --- Help ---

function printHelp() {
  console.log(`
Task CLI - manage tasks from the command line

Usage: bash bin/db/task-cli.sh <command> [args] [--format compact|json|table]

Commands:
  list                       List active tasks (default)
    --archived               List archived tasks instead
    --since YYYY-MM-DD       Filter archived tasks by date
    --tag TAG                Filter by tag (e.g., --tag work, --tag team:payments)
    --project ID             Filter by project
    --due-by DATE|today      Filter tasks due by date

  get <id>                   Get a single task by ID

  add <title>                Create a new task
    --due YYYY-MM-DD         Due date
    --priority high|medium|low
    --tags tag1,tag2         Comma-separated tags
    --project ID             Project ID
    --notes TEXT             Task notes

  update <id>                Update a task's fields
    --title TEXT             --due DATE  --priority LEVEL
    --tags tag1,tag2         --project ID  --notes TEXT

  done <id>                  Mark task done (auto-archives)
  archive <id>               Archive without completing (drop)
  unarchive <id>             Return archived task to active list

  recurring                  List recurring tasks

Output formats (--format):
  compact (default)          Tab-separated, one task per line. Token-efficient.
  json                       Full task objects as JSON array.
  table                      Aligned columns for terminal display.

Compact output columns: id, status, priority, due, project, title
  `.trim());
}

main();
