const express = require('express');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const chokidar = require('chokidar');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3737;

// --- File tree helpers ---

function buildTree() {
  const tree = { people: {}, meetings: [], projects: [], areas: [], reference: [] };

  // People (1:1s)
  const oneOnOnesDir = path.join(ROOT, 'areas', 'one-on-ones');
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
  const meetingsDir = path.join(ROOT, 'areas', 'meetings');
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
  const projectsDir = path.join(ROOT, 'projects');
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
  const areasDir = path.join(ROOT, 'areas');
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
  const refFiles = ['reading-list.md', 'style-guide.md', 'google-docs-style-guide.md', 'CLAUDE.md'];
  for (const f of refFiles) {
    if (fs.existsSync(path.join(ROOT, f))) {
      tree.reference.push({ name: f.replace('.md', ''), label: formatName(f.replace('.md', '')), path: f });
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

// --- Task helpers ---

function loadTasks() {
  const tasksPath = path.join(ROOT, 'tasks.yaml');
  const archivePath = path.join(ROOT, 'tasks-archive.yaml');
  const recurringPath = path.join(ROOT, 'recurring.yaml');

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
