const express = require('express');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const chokidar = require('chokidar');
const { spawn } = require('child_process');
const taskDb = require('../bin/db/task-db.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3737;

// Find an executable on PATH (including common locations)
function findExecutable(name) {
  const extraPaths = [
    path.join(process.env.HOME || '', '.local', 'bin'),
    '/usr/local/bin',
  ];
  const pathDirs = (process.env.PATH || '').split(':').concat(extraPaths);
  for (const dir of pathDirs) {
    const full = path.join(dir, name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch (e) { /* not found here */ }
  }
  return null;
}

// --- File tree helpers ---

function buildTree() {
  const tree = { people: {}, meetings: [], projects: [], areas: [], reference: [], docs: [] };

  // People (1:1s)
  const oneOnOnesDir = path.join(ROOT, 'data', 'files', 'areas', 'one-on-ones');
  const relationshipTypes = [
    { dir: 'direct-reports', label: 'Direct Reports' },
    { dir: 'manager', label: 'Manager' },
    { dir: 'peers', label: 'Peers' },
    { dir: 'skip-level', label: 'Skip-Level' },
    { dir: 'skip-level-reports', label: 'Skip-Level Reports' },
    { dir: 'xfn', label: 'XFN' },
  ];

  for (const rt of relationshipTypes) {
    const dirPath = path.join(oneOnOnesDir, rt.dir);
    if (!fs.existsSync(dirPath)) continue;
    const people = [];
    for (const name of fs.readdirSync(dirPath).sort()) {
      const personDir = path.join(dirPath, name);
      if (!fs.statSync(personDir).isDirectory()) continue;
      const sessionsDir = path.join(personDir, 'sessions');
      let sessions = [];
      if (fs.existsSync(sessionsDir)) {
        sessions = fs.readdirSync(sessionsDir)
          .filter(f => f.endsWith('.md'))
          .sort()
          .reverse();
      }
      people.push({
        name,
        label: formatName(name),
        path: path.relative(ROOT, personDir),
        readmePath: path.relative(ROOT, path.join(personDir, 'README.md')),
        sessions: sessions.map(s => ({
          name: s.replace('.md', ''),
          path: path.relative(ROOT, path.join(sessionsDir, s)),
        })),
      });
    }
    tree.people[rt.dir] = { label: rt.label, people };
  }

  // Meetings
  const meetingsDir = path.join(ROOT, 'data', 'files', 'areas', 'meetings');
  if (fs.existsSync(meetingsDir)) {
    for (const name of fs.readdirSync(meetingsDir).sort()) {
      const meetingDir = path.join(meetingsDir, name);
      if (!fs.statSync(meetingDir).isDirectory()) continue;
      const sessionsDir = path.join(meetingDir, 'sessions');
      let sessions = [];
      if (fs.existsSync(sessionsDir)) {
        sessions = fs.readdirSync(sessionsDir)
          .filter(f => f.endsWith('.md'))
          .sort()
          .reverse();
      }
      tree.meetings.push({
        name,
        label: formatName(name),
        path: path.relative(ROOT, meetingDir),
        readmePath: path.relative(ROOT, path.join(meetingDir, 'README.md')),
        sessions: sessions.map(s => ({
          name: s.replace('.md', ''),
          path: path.relative(ROOT, path.join(sessionsDir, s)),
        })),
      });
    }
  }

  // Projects
  const projectsDir = path.join(ROOT, 'data', 'files', 'projects');
  if (fs.existsSync(projectsDir)) {
    for (const name of fs.readdirSync(projectsDir).sort()) {
      if (name === 'INDEX.md') continue;
      const projDir = path.join(projectsDir, name);
      if (!fs.statSync(projDir).isDirectory()) continue;
      const files = fs.readdirSync(projDir).filter(f => f.endsWith('.md'));
      tree.projects.push({
        name,
        label: formatName(name),
        path: path.relative(ROOT, projDir),
        files: files.map(f => ({
          name: f.replace('.md', ''),
          path: path.relative(ROOT, path.join(projDir, f)),
        })),
      });
    }
  }

  // Areas (non-1:1, non-meeting)
  const areasDir = path.join(ROOT, 'data', 'files', 'areas');
  for (const name of ['career', 'comms', 'daily-briefings']) {
    const areaDir = path.join(areasDir, name);
    if (!fs.existsSync(areaDir)) continue;
    const files = [];
    collectMarkdownFiles(areaDir, files, ROOT);
    tree.areas.push({
      name,
      label: formatName(name),
      path: path.relative(ROOT, areaDir),
      files,
    });
  }

  // Reference files
  const refFiles = [
    { file: 'data/files/reading-list.md', name: 'reading-list' },
    { file: 'data/files/style-guide.md', name: 'style-guide' },
    { file: 'data/files/google-docs-style-guide.md', name: 'google-docs-style-guide' },
    { file: 'CLAUDE.md', name: 'CLAUDE' },
  ];
  for (const { file, name } of refFiles) {
    if (fs.existsSync(path.join(ROOT, file))) {
      tree.reference.push({ name, label: formatName(name), path: file });
    }
  }

  // CoS Development
  const docsDir = path.join(ROOT, 'cos-dev');
  if (fs.existsSync(docsDir)) {
    // Top-level docs
    const topFiles = fs.readdirSync(docsDir).filter(f => f.endsWith('.md')).sort();
    for (const f of topFiles) {
      tree.docs.push({
        name: f.replace('.md', ''),
        label: f.replace('.md', ''),
        path: path.relative(ROOT, path.join(docsDir, f)),
        type: 'file',
      });
    }
    // Subdirectories (e.g., PRDs)
    for (const name of fs.readdirSync(docsDir).sort()) {
      const subDir = path.join(docsDir, name);
      if (!fs.statSync(subDir).isDirectory()) continue;
      const files = fs.readdirSync(subDir).filter(f => f.endsWith('.md')).sort();
      tree.docs.push({
        name,
        label: name,
        path: path.relative(ROOT, subDir),
        type: 'dir',
        files: files.map(f => ({
          name: f.replace('.md', ''),
          label: f.replace('.md', ''),
          path: path.relative(ROOT, path.join(subDir, f)),
        })),
      });
    }
  }

  return tree;
}

function collectMarkdownFiles(dir, result, root) {
  for (const entry of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      collectMarkdownFiles(full, result, root);
    } else if (entry.endsWith('.md')) {
      result.push({ name: entry.replace('.md', ''), path: path.relative(root, full) });
    }
  }
}

function formatName(slug) {
  return slug
    .replace(/\.md$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bXfn\b/, 'XFN')
    .replace(/\bMypay\b/, 'MyPay')
    .replace(/\bDte\b/, 'DTE')
    .replace(/\bDder\b/, 'DDer')
    .replace(/\bCrp\b/, 'CRP')
    .replace(/\bApi\b/, 'API')
    .replace(/\bUi\b/, 'UI')
    .replace(/\bQ2q3\b/, 'Q2/Q3')
    .replace(/\bAi\b/, 'AI');
}

// --- Annotation storage ---
// Abstracted for future SQLite swap. Currently filesystem-backed.
// Annotations stored in ui/.annotations/ with one JSON file per document.

const ANNOTATIONS_DIR = path.join(__dirname, '.annotations');

function encodePath(docPath) {
  return docPath.replace(/\//g, '--') + '.json';
}

function decodePath(fileName) {
  return fileName.replace(/\.json$/, '').replace(/--/g, '/');
}

function getAnnotationsFile(docPath) {
  return path.join(ANNOTATIONS_DIR, encodePath(docPath));
}

function readAnnotations(docPath) {
  const file = getAnnotationsFile(docPath);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return [];
  }
}

function writeAnnotations(docPath, annotations) {
  fs.mkdirSync(ANNOTATIONS_DIR, { recursive: true });
  const file = getAnnotationsFile(docPath);
  if (annotations.length === 0) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return;
  }
  fs.writeFileSync(file, JSON.stringify(annotations, null, 2), 'utf8');
}

function listAnnotatedFiles() {
  if (!fs.existsSync(ANNOTATIONS_DIR)) return [];
  return fs.readdirSync(ANNOTATIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const docPath = decodePath(f);
      const annotations = readAnnotations(docPath);
      return { path: docPath, count: annotations.length, annotations };
    })
    .filter(f => f.count > 0);
}

// --- Task helpers (SQLite via shared module) ---
// YAML loading preserved as fallback during migration

function loadTasks() {
  try {
    return taskDb.loadAll();
  } catch (e) {
    console.error('[tasks] SQLite load failed, falling back to YAML:', e.message);
    return loadTasksFromYaml();
  }
}

function loadTasksFromYaml() {
  const tasksPath = path.join(ROOT, 'data', 'files', 'tasks.yaml');
  const archivePath = path.join(ROOT, 'data', 'files', 'tasks-archive.yaml');
  const recurringPath = path.join(ROOT, 'data', 'files', 'recurring.yaml');

  let active = [];
  let archived = [];
  let recurring = [];

  try {
    const tasksData = yaml.load(fs.readFileSync(tasksPath, 'utf8'));
    active = tasksData?.tasks || [];
  } catch (e) { /* empty */ }

  try {
    const archiveData = yaml.load(fs.readFileSync(archivePath, 'utf8'));
    archived = archiveData?.archived || [];
  } catch (e) { /* empty */ }

  try {
    const recurringData = yaml.load(fs.readFileSync(recurringPath, 'utf8'));
    recurring = recurringData?.recurring || [];
  } catch (e) { /* empty */ }

  return { active, archived, recurring };
}

// --- SSE for live reload ---

const sseClients = new Set();

function broadcastReload(filePath) {
  const rel = path.relative(ROOT, filePath);
  for (const res of sseClients) {
    res.write(`data: ${JSON.stringify({ type: 'reload', file: rel })}\n\n`);
  }
}

// --- Express app ---

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/static', express.static(path.join(__dirname, 'public')));

// SSE endpoint
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Navigation tree
app.get('/api/tree', (req, res) => {
  res.json(buildTree());
});

// Tasks data
app.get('/api/tasks', (req, res) => {
  res.json(loadTasks());
});

// Task CRUD
app.get('/api/task/:id', (req, res) => {
  try {
    const task = taskDb.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/task', (req, res) => {
  try {
    const task = taskDb.createTask(req.body);
    res.status(201).json(task);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/task/:id', (req, res) => {
  try {
    const task = taskDb.updateTask(req.params.id, req.body);
    res.json(task);
  } catch (e) {
    const status = e.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

app.delete('/api/task/:id', (req, res) => {
  try {
    const task = taskDb.deleteTask(req.params.id);
    res.json(task);
  } catch (e) {
    const status = e.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

app.post('/api/task/:id/done', (req, res) => {
  try {
    const task = taskDb.markDone(req.params.id);
    res.json(task);
  } catch (e) {
    const status = e.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

app.post('/api/task/:id/archive', (req, res) => {
  try {
    const task = taskDb.archiveTask(req.params.id);
    res.json(task);
  } catch (e) {
    const status = e.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

app.post('/api/task/:id/unarchive', (req, res) => {
  try {
    const task = taskDb.unarchiveTask(req.params.id);
    res.json(task);
  } catch (e) {
    const status = e.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

app.put('/api/recurring-task/:id', (req, res) => {
  try {
    const task = taskDb.updateRecurringTask(req.params.id, req.body);
    res.json(task);
  } catch (e) {
    const status = e.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

// Read a file (raw markdown)
app.get('/api/file', (req, res) => {
  const filePath = path.join(ROOT, req.query.path || '');
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.type('text/plain').send(fs.readFileSync(filePath, 'utf8'));
});

// Save a file
app.put('/api/file', (req, res) => {
  const filePath = path.join(ROOT, req.body.path || '');
  if (!filePath.startsWith(ROOT)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  fs.writeFileSync(filePath, req.body.content, 'utf8');
  res.json({ ok: true });
});

// --- Annotation API ---

// Get annotations for a file
app.get('/api/annotations', (req, res) => {
  const docPath = req.query.path;
  if (!docPath) return res.status(400).json({ error: 'path required' });
  res.json({ annotations: readAnnotations(docPath) });
});

// Save annotations for a file (full replace)
app.put('/api/annotations', (req, res) => {
  const { path: docPath, annotations } = req.body;
  if (!docPath) return res.status(400).json({ error: 'path required' });
  writeAnnotations(docPath, annotations || []);
  res.json({ ok: true, annotations: readAnnotations(docPath) });
});

// Delete a single annotation by id
app.delete('/api/annotations', (req, res) => {
  const { path: docPath, id } = req.body;
  if (!docPath || !id) return res.status(400).json({ error: 'path and id required' });
  const annotations = readAnnotations(docPath).filter(a => a.id !== id);
  writeAnnotations(docPath, annotations);
  res.json({ ok: true, annotations });
});

// List all files that have annotations
app.get('/api/annotations/list', (req, res) => {
  res.json({ files: listAnnotatedFiles() });
});

// --- Process endpoint (streams claude output via SSE) ---

app.post('/api/process', (req, res) => {
  const { path: docPath } = req.body;
  if (!docPath) return res.status(400).json({ error: 'path required' });

  const annotations = readAnnotations(docPath);
  if (annotations.length === 0) {
    return res.status(400).json({ error: 'No annotations to process' });
  }

  // SSE headers for streaming
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Resolve claude binary - may be in ~/.local/bin which isn't in PATH for child processes
  const claudeBin = process.env.CLAUDE_BIN || findExecutable('claude');
  if (!claudeBin) {
    res.write(`data: ${JSON.stringify({ type: 'error', content: 'claude CLI not found on PATH. Set CLAUDE_BIN env var or ensure claude is in PATH.' })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done', code: 1 })}\n\n`);
    res.end();
    return;
  }

  const args = [
    '-p',
    `/process-ui-annotations ${docPath}`,
    '--output-format', 'stream-json',
    '--verbose',
    '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash',
  ];
  console.log('[process] spawning:', claudeBin, args.join(' '));
  res.write(`data: ${JSON.stringify({ type: 'text', content: 'Starting Claude...\n' })}\n\n`);

  const child = spawn(claudeBin, args, {
    cwd: ROOT,
    env: { ...process.env, PATH: process.env.PATH + ':' + path.join(process.env.HOME || '', '.local', 'bin') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.on('spawn', () => console.log('[process] child spawned, pid:', child.pid));

  let buffer = '';

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    // stream-json outputs one JSON object per line
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line in buffer
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);

        if (parsed.type === 'assistant' && parsed.message?.content) {
          // Extract text from the assistant message content array
          for (const block of parsed.message.content) {
            if (block.type === 'text' && block.text) {
              res.write(`data: ${JSON.stringify({ type: 'text', content: block.text })}\n\n`);
            } else if (block.type === 'tool_use') {
              res.write(`data: ${JSON.stringify({ type: 'text', content: `\n[${block.name}] ` })}\n\n`);
            }
          }
        } else if (parsed.type === 'result') {
          res.write(`data: ${JSON.stringify({ type: 'result', content: parsed.result })}\n\n`);
        }
        // Skip system, user, rate_limit events silently
      } catch (e) {
        // Forward raw text as fallback
        res.write(`data: ${JSON.stringify({ type: 'text', content: line })}\n\n`);
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    console.log('[process] stderr:', text);
    res.write(`data: ${JSON.stringify({ type: 'error', content: text })}\n\n`);
  });

  child.on('close', (code, signal) => {
    console.log('[process] close: code=%s signal=%s', code, signal);
    res.write(`data: ${JSON.stringify({ type: 'done', code: code ?? 0 })}\n\n`);
    res.end();
  });

  child.on('error', (err) => {
    res.write(`data: ${JSON.stringify({ type: 'error', content: 'Failed to start claude: ' + err.message })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done', code: 1 })}\n\n`);
    res.end();
  });

  // Kill child only if the client drops the SSE connection
  let processDone = false;
  child.on('close', () => { processDone = true; });
  res.on('close', () => {
    if (!processDone && !child.killed) {
      console.log('[process] client disconnected, killing child');
      child.kill();
    }
  });
});

// Main page - serve the shell HTML for any non-API route
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- File watcher ---

const watcher = chokidar.watch(ROOT, {
  ignored: [
    /(^|[\/\\])\./,       // dotfiles
    /node_modules/,
    /ui\//,                // don't watch ourselves
    /\.annotations\//,     // annotation storage
  ],
  persistent: true,
  ignoreInitial: true,
});

watcher.on('change', broadcastReload);
watcher.on('add', broadcastReload);

// --- Start ---

app.listen(PORT, () => {
  console.log(`\n  Chief of Staff running at http://localhost:${PORT}\n`);
});
