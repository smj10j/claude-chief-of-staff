const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

// --- Test helpers ---

let tmpRoot;
let serverProcess;
let baseUrl;

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFile(relPath, content) {
  const full = path.join(tmpRoot, relPath);
  mkdirp(path.dirname(full));
  fs.writeFileSync(full, content, 'utf8');
}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {},
    };
    let payload;
    if (body) {
      payload = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('Server did not start within timeout'));
      }
      const req = http.get(url + '/api/tree', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve());
      });
      req.on('error', () => setTimeout(check, 200));
    }
    check();
  });
}

// --- Scaffolding ---
// We create a temp directory with the full repo structure, then use a
// small bootstrap script that patches ROOT before loading server.js.

const REPO_ROOT = path.resolve(__dirname, '..', '..');

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-ui-test-'));

  // Scaffold data/files structure
  const dirs = [
    'data/files/areas/one-on-ones/direct-reports',
    'data/files/areas/one-on-ones/manager',
    'data/files/areas/one-on-ones/peers',
    'data/files/areas/one-on-ones/skip-level',
    'data/files/areas/one-on-ones/skip-level-reports',
    'data/files/areas/one-on-ones/xfn',
    'data/files/areas/meetings',
    'data/files/areas/career',
    'data/files/areas/comms',
    'data/files/areas/daily-briefings/sessions',
    'data/files/projects',
    'data/files/archive',
    'cos-dev/PRDs',
    'ui',
  ];
  for (const d of dirs) mkdirp(path.join(tmpRoot, d));

  // Create test content
  writeFile('CLAUDE.md', '# Test CLAUDE.md\n\nThis is a test.');
  writeFile('data/files/style-guide.md', '# Style Guide\n\nTest style guide.');
  writeFile('data/files/reading-list.md', '# Reading List\n\n- Item 1');
  writeFile('data/files/google-docs-style-guide.md', '# Google Docs Style\n\nTest.');
  writeFile('data/files/projects/INDEX.md', '# Projects\n');
  writeFile('data/files/areas/one-on-ones/README.md', '# 1:1 System\n\nTest.');
  writeFile('data/files/areas/meetings/README.md', '# Meetings\n\nTest.');
  writeFile('data/files/areas/career/README.md', '# Career\n\nTest.');

  // Test person with sessions
  const personDir = 'data/files/areas/one-on-ones/direct-reports/alice';
  writeFile(`${personDir}/README.md`, '# Alice\n\nDirect report.');
  mkdirp(path.join(tmpRoot, personDir, 'sessions'));
  writeFile(`${personDir}/sessions/2026-03-25.md`, '# Session 2026-03-25\n\n## Raw Notes\n');
  writeFile(`${personDir}/sessions/2026-03-18.md`, '# Session 2026-03-18\n\n## Raw Notes\n');

  // Test meeting with sessions
  const meetingDir = 'data/files/areas/meetings/team-standup';
  writeFile(`${meetingDir}/README.md`, '# Team Standup\n\nDaily sync.');
  mkdirp(path.join(tmpRoot, meetingDir, 'sessions'));
  writeFile(`${meetingDir}/sessions/2026-03-25.md`, '# Standup 2026-03-25\n');

  // Test project
  writeFile('data/files/projects/widget-v2/README.md', '# Widget V2\n\nNew widget.');

  // cos-dev docs
  writeFile('cos-dev/SECURITY.md', '# Security\n\nTest security doc.');
  writeFile('cos-dev/PRDs/INDEX.md', '# PRD Index\n\nTest.');

  // Copy public assets for static serving
  const publicDir = path.join(REPO_ROOT, 'ui', 'public');
  mkdirp(path.join(tmpRoot, 'ui', 'public'));
  for (const f of fs.readdirSync(publicDir)) {
    const src = path.join(publicDir, f);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(tmpRoot, 'ui', 'public', f));
    }
  }

  // Write a bootstrap script that patches paths and loads the real server
  const port = 3737 + Math.floor(Math.random() * 1000);
  baseUrl = `http://localhost:${port}`;

  const bootstrapScript = `
    // Patch the module resolution so require('../bin/db/task-db.js') works
    const Module = require('module');
    const path = require('path');
    const origResolve = Module._resolveFilename;
    const REPO = ${JSON.stringify(REPO_ROOT)};
    const TMP = ${JSON.stringify(tmpRoot)};

    Module._resolveFilename = function(request, parent, ...rest) {
      // Redirect bin/db requires to the real repo
      if (request.includes('bin/db/')) {
        const resolved = path.resolve(REPO, request.replace(/^.*?(bin\\/db\\/)/, '$1'));
        return origResolve.call(this, resolved, parent, ...rest);
      }
      // Redirect node_modules to the real ui/node_modules
      if (parent && parent.filename && parent.filename.startsWith(TMP)) {
        try {
          return origResolve.call(this, request, parent, ...rest);
        } catch(e) {
          // Try the real repo's ui/node_modules
          const fakeParent = { ...parent, filename: parent.filename.replace(TMP, REPO), paths: undefined };
          return origResolve.call(this, request, fakeParent, ...rest);
        }
      }
      return origResolve.call(this, request, parent, ...rest);
    };

    // Override task-db configure to use the temp root for DB
    process.env.PORT = ${JSON.stringify(String(port))};

    // Now load the real server.js from the temp dir (which we'll copy)
    require(${JSON.stringify(path.join(REPO_ROOT, 'ui', 'server.js'))});
  `;

  writeFile('_test-bootstrap.js', bootstrapScript);

  // The server resolves ROOT as path.resolve(__dirname, '..').
  // Since we're loading server.js from its real location, ROOT will point
  // to the real repo. We need to override __dirname. Instead, let's use
  // a different approach: create a wrapper server that sets ROOT.

  // Actually, let's create a minimal wrapper that overrides the ROOT constant
  const wrapperScript = `
    const path = require('path');
    const TMP = ${JSON.stringify(tmpRoot)};
    const REPO = ${JSON.stringify(REPO_ROOT)};

    // We need to load the real server but with ROOT pointing to TMP.
    // server.js sets ROOT = path.resolve(__dirname, '..');
    // We'll load it from a temp ui/ dir so __dirname resolves correctly.

    // First, ensure task-db can find the real migrations
    const taskDb = require(path.join(REPO, 'bin', 'db', 'task-db.js'));
    taskDb.configure({
      dbPath: path.join(TMP, 'data', 'cos.db'),
      root: TMP,
    });
    taskDb.initialize();

    // Now we need to serve from TMP. Rather than fighting with server.js
    // ROOT resolution, just patch path.resolve for the initial call.
    const origResolve = path.resolve;

    // Load dependencies from the real node_modules
    const modulePaths = require('module')._nodeModulePaths(path.join(REPO, 'ui'));
    require('module').globalPaths.push(...modulePaths);

    // Set up minimal ENV
    process.env.PORT = ${JSON.stringify(String(port))};

    // Load the server with a patched __dirname context
    // The simplest approach: just use require and monkey-patch ROOT after load
    // But server.js has const ROOT = ... at top level. So we read, patch, eval.
    const fs = require('fs');
    let serverCode = fs.readFileSync(path.join(REPO, 'ui', 'server.js'), 'utf8');

    // Replace the ROOT and taskDb lines
    serverCode = serverCode.replace(
      "const ROOT = path.resolve(__dirname, '..');",
      "const ROOT = " + JSON.stringify(TMP) + ";"
    );
    serverCode = serverCode.replace(
      "const taskDb = require('../bin/db/task-db.js');",
      "const taskDb = require(" + JSON.stringify(path.join(REPO, 'bin', 'db', 'task-db.js')) + ");"
    );

    // Ensure __dirname points to the temp ui/ dir for static asset serving
    const vm = require('vm');
    const m = new module.constructor();
    m.paths = require('module')._nodeModulePaths(path.join(REPO, 'ui'));
    m.filename = path.join(TMP, 'ui', 'server.js');
    m._compile(serverCode, m.filename);
  `;

  writeFile('_test-server.js', wrapperScript);

  serverProcess = spawn(process.execPath, [path.join(tmpRoot, '_test-server.js')], {
    cwd: tmpRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  serverProcess.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  serverProcess.on('exit', (code) => {
    if (code && code !== 0 && stderr) {
      console.error('[test server stderr]', stderr.slice(0, 2000));
    }
  });

  // Give the server a moment to crash if it's going to
  await new Promise(r => setTimeout(r, 500));
  if (serverProcess.exitCode !== null) {
    throw new Error('Server process exited early: ' + stderr.slice(0, 1000));
  }

  await waitForServer(baseUrl);
});

after(() => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
  }
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// === Tests ===

describe('GET /api/tree', () => {
  it('returns the navigation tree with expected shape', async () => {
    const res = await request('GET', '/api/tree');
    assert.equal(res.status, 200);
    assert.ok(res.body.people, 'tree has people');
    assert.ok(Array.isArray(res.body.meetings), 'tree has meetings');
    assert.ok(Array.isArray(res.body.projects), 'tree has projects');
    assert.ok(Array.isArray(res.body.areas), 'tree has areas');
    assert.ok(Array.isArray(res.body.reference), 'tree has reference');
    assert.ok(Array.isArray(res.body.docs), 'tree has docs');
  });

  it('includes people organized by relationship type', async () => {
    const res = await request('GET', '/api/tree');
    const dr = res.body.people['direct-reports'];
    assert.ok(dr, 'has direct-reports');
    assert.equal(dr.label, 'Direct Reports');

    const alice = dr.people.find(p => p.name === 'alice');
    assert.ok(alice, 'alice exists');
    assert.equal(alice.label, 'Alice');
    assert.ok(alice.path.includes('data/files/areas/one-on-ones/direct-reports/alice'));
    assert.ok(alice.sessions.length >= 2, 'alice has 2+ sessions');
    assert.equal(alice.sessions[0].name, '2026-03-25', 'sessions sorted newest first');
  });

  it('includes meetings with sessions', async () => {
    const res = await request('GET', '/api/tree');
    const standup = res.body.meetings.find(m => m.name === 'team-standup');
    assert.ok(standup, 'team-standup exists');
    assert.ok(standup.path.includes('data/files/areas/meetings/team-standup'));
    assert.ok(standup.sessions.length >= 1);
  });

  it('includes projects', async () => {
    const res = await request('GET', '/api/tree');
    const widget = res.body.projects.find(p => p.name === 'widget-v2');
    assert.ok(widget, 'widget-v2 exists');
    assert.ok(widget.path.includes('data/files/projects/widget-v2'));
  });

  it('includes reference files with data/files/ paths', async () => {
    const res = await request('GET', '/api/tree');
    const refNames = res.body.reference.map(r => r.name);
    assert.ok(refNames.includes('reading-list'));
    assert.ok(refNames.includes('style-guide'));
    assert.ok(refNames.includes('CLAUDE'));

    const sg = res.body.reference.find(r => r.name === 'style-guide');
    assert.equal(sg.path, 'data/files/style-guide.md');
  });

  it('includes cos-dev docs', async () => {
    const res = await request('GET', '/api/tree');
    assert.ok(res.body.docs.length >= 1);
    const sec = res.body.docs.find(d => d.name === 'SECURITY');
    assert.ok(sec, 'SECURITY doc present');
  });
});

describe('GET /api/file', () => {
  it('reads a root-level file', async () => {
    const res = await request('GET', '/api/file?path=CLAUDE.md');
    assert.equal(res.status, 200);
    assert.ok(res.raw.includes('Test CLAUDE.md'));
  });

  it('reads files in data/files/', async () => {
    const res = await request('GET', '/api/file?path=data/files/style-guide.md');
    assert.equal(res.status, 200);
    assert.ok(res.raw.includes('Test style guide'));
  });

  it('returns 404 for missing files', async () => {
    const res = await request('GET', '/api/file?path=nonexistent.md');
    assert.equal(res.status, 404);
  });
});

describe('PUT /api/file', () => {
  it('writes and persists a file', async () => {
    const marker = 'content-' + Date.now();
    const res = await request('PUT', '/api/file', {
      path: 'data/files/style-guide.md',
      content: `# Updated\n\n${marker}`,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    const readRes = await request('GET', '/api/file?path=data/files/style-guide.md');
    assert.ok(readRes.raw.includes(marker));
  });

  it('creates new files', async () => {
    const res = await request('PUT', '/api/file', {
      path: 'data/files/areas/comms/test-draft.md',
      content: '# Draft\n\nTest.',
    });
    assert.equal(res.status, 200);

    const readRes = await request('GET', '/api/file?path=data/files/areas/comms/test-draft.md');
    assert.equal(readRes.status, 200);
  });
});

describe('Task CRUD API', () => {
  it('GET /api/tasks returns structured data', async () => {
    const res = await request('GET', '/api/tasks');
    assert.equal(res.status, 200);
    assert.ok('active' in res.body);
    assert.ok('archived' in res.body);
    assert.ok('recurring' in res.body);
  });

  it('POST /api/task creates a task', async () => {
    const res = await request('POST', '/api/task', {
      title: 'Test task',
      priority: 'high',
      tags: ['work', 'test'],
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.title, 'Test task');
    assert.equal(res.body.priority, 'high');
    assert.ok(res.body.tags.includes('work'));
  });

  it('GET /api/task/:id retrieves a task', async () => {
    const { body: created } = await request('POST', '/api/task', { title: 'Fetch me' });
    const res = await request('GET', `/api/task/${created.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'Fetch me');
  });

  it('GET /api/task/:id returns 404 for missing', async () => {
    const res = await request('GET', '/api/task/nonexistent-xyz-99');
    assert.equal(res.status, 404);
  });

  it('PUT /api/task/:id updates fields', async () => {
    const { body: created } = await request('POST', '/api/task', { title: 'Update me', priority: 'low' });
    const res = await request('PUT', `/api/task/${created.id}`, {
      priority: 'high',
      due: '2026-04-01',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.priority, 'high');
    assert.equal(res.body.due, '2026-04-01');
  });

  it('POST /api/task/:id/done marks done and archives', async () => {
    const { body: created } = await request('POST', '/api/task', { title: 'Complete me' });
    const res = await request('POST', `/api/task/${created.id}/done`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'done');
    assert.equal(res.body.is_archived, 1);
  });

  it('POST /api/task/:id/archive archives without completing', async () => {
    const { body: created } = await request('POST', '/api/task', { title: 'Archive me' });
    const res = await request('POST', `/api/task/${created.id}/archive`);
    assert.equal(res.status, 200);
    assert.equal(res.body.is_archived, 1);
    assert.notEqual(res.body.status, 'done');
  });

  it('POST /api/task/:id/unarchive restores a task', async () => {
    const { body: created } = await request('POST', '/api/task', { title: 'Restore me' });
    await request('POST', `/api/task/${created.id}/archive`);
    const res = await request('POST', `/api/task/${created.id}/unarchive`);
    assert.equal(res.status, 200);
    assert.equal(res.body.is_archived, 0);
  });

  it('DELETE /api/task/:id removes a task', async () => {
    const { body: created } = await request('POST', '/api/task', { title: 'Delete me' });
    const res = await request('DELETE', `/api/task/${created.id}`);
    assert.equal(res.status, 200);

    const getRes = await request('GET', `/api/task/${created.id}`);
    assert.equal(getRes.status, 404);
  });
});

describe('Annotations API', () => {
  const testDocPath = 'data/files/areas/one-on-ones/direct-reports/alice/README.md';

  afterEach(async () => {
    await request('PUT', '/api/annotations', { path: testDocPath, annotations: [] });
  });

  it('returns empty annotations for unannotated file', async () => {
    const res = await request('GET', `/api/annotations?path=${encodeURIComponent(testDocPath)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.annotations, []);
  });

  it('saves and retrieves annotations', async () => {
    const annotations = [
      { id: 'a1', text: 'Test', comment: 'Expand', textBefore: '', textAfter: '', createdAt: new Date().toISOString() },
    ];
    await request('PUT', '/api/annotations', { path: testDocPath, annotations });

    const res = await request('GET', `/api/annotations?path=${encodeURIComponent(testDocPath)}`);
    assert.equal(res.body.annotations.length, 1);
    assert.equal(res.body.annotations[0].id, 'a1');
  });

  it('deletes a single annotation by id', async () => {
    const annotations = [
      { id: 'a2', text: 'A', comment: 'X', textBefore: '', textAfter: '', createdAt: new Date().toISOString() },
      { id: 'a3', text: 'B', comment: 'Y', textBefore: '', textAfter: '', createdAt: new Date().toISOString() },
    ];
    await request('PUT', '/api/annotations', { path: testDocPath, annotations });

    const res = await request('DELETE', '/api/annotations', { path: testDocPath, id: 'a2' });
    assert.equal(res.body.annotations.length, 1);
    assert.equal(res.body.annotations[0].id, 'a3');
  });

  it('lists files with annotations', async () => {
    const annotations = [
      { id: 'a4', text: 'T', comment: 'C', textBefore: '', textAfter: '', createdAt: new Date().toISOString() },
    ];
    await request('PUT', '/api/annotations', { path: testDocPath, annotations });

    const res = await request('GET', '/api/annotations/list');
    assert.ok(res.body.files.length >= 1);
    const found = res.body.files.find(f => f.path === testDocPath);
    assert.ok(found);
    assert.equal(found.count, 1);
  });

  it('returns 400 without path parameter', async () => {
    const res = await request('GET', '/api/annotations');
    assert.equal(res.status, 400);
  });
});

describe('SSE endpoint', () => {
  it('returns event-stream content type', async () => {
    const res = await new Promise((resolve) => {
      const url = new URL('/api/events', baseUrl);
      const req = http.get(url, (res) => {
        setTimeout(() => {
          resolve({ status: res.statusCode, headers: res.headers });
          res.destroy();
        }, 300);
      });
      req.on('error', () => resolve({ status: 0, headers: {} }));
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/event-stream'));
  });
});

describe('Static assets', () => {
  it('serves HTML at root', async () => {
    const res = await request('GET', '/');
    assert.equal(res.status, 200);
    assert.ok(res.raw.includes('<html') || res.raw.includes('<!DOCTYPE'));
  });

  it('serves CSS at /static/style.css', async () => {
    const res = await request('GET', '/static/style.css');
    assert.equal(res.status, 200);
  });
});

describe('Path traversal protection', () => {
  it('rejects path traversal on GET /api/file', async () => {
    const res = await request('GET', '/api/file?path=../../etc/passwd');
    assert.equal(res.status, 404);
  });

  it('rejects path traversal on PUT /api/file', async () => {
    const res = await request('PUT', '/api/file', {
      path: '../../etc/evil',
      content: 'bad',
    });
    assert.equal(res.status, 403);
  });
});
