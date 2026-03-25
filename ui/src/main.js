import { initEditor, loadFile, getCurrentPath } from './editor.js';
import { initToolbar } from './toolbar.js';
import { renderTasks, setupTaskInteractions } from './tasks.js';

let tree = null;
let isProcessing = false;

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize editor
  const editorContainer = document.getElementById('editor-container');
  const bubbleMenu = document.getElementById('bubble-menu');

  const editor = initEditor(editorContainer, bubbleMenu, {
    onNavigate: (path) => navigate(path),
    onAnnotationsChanged: (count) => updateProcessButton(count),
  });

  initToolbar(bubbleMenu);

  // Wire up Process button
  document.getElementById('process-btn').addEventListener('click', startProcessing);

  // Load sidebar
  tree = await fetchJSON('/api/tree');
  renderSidebar(tree);

  // SSE for live reload
  setupSSE();

  // Handle back/forward
  window.addEventListener('popstate', (e) => {
    if (e.state?.path) navigate(e.state.path, false);
    else if (e.state?.view) showTasks(false);
  });

  // Load initial content from hash
  const hash = window.location.hash.slice(1);
  if (hash === 'tasks') showTasks(false);
  else if (hash) navigate(hash, false);
});

// --- Process with Claude ---

function updateProcessButton(annotationCount) {
  const btn = document.getElementById('process-btn');
  const badge = document.getElementById('process-badge');
  if (annotationCount > 0) {
    btn.classList.remove('hidden');
    badge.textContent = annotationCount;
    badge.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
    badge.classList.add('hidden');
  }
}

async function startProcessing() {
  const filePath = getCurrentPath();
  if (!filePath || isProcessing) return;

  isProcessing = true;
  const btn = document.getElementById('process-btn');
  btn.disabled = true;
  btn.textContent = 'Processing...';

  // Show the progress modal
  showProcessModal();

  try {
    const res = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          appendToProcessModal(data);

          if (data.type === 'done') {
            // Reload the file to see changes
            const raw = await fetchText(`/api/file?path=${encodeURIComponent(filePath)}`);
            await loadFile(filePath, raw);
          }
        } catch (e) {
          // skip unparseable lines
        }
      }
    }
  } catch (e) {
    appendToProcessModal({ type: 'error', content: `Connection error: ${e.message}` });
  } finally {
    isProcessing = false;
    btn.disabled = false;
    btn.textContent = 'Process with Claude';
  }
}

function showProcessModal() {
  let modal = document.getElementById('process-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'process-modal';
    modal.innerHTML = `
      <div class="process-modal-header">
        <span>Processing with Claude</span>
        <button class="process-modal-close" title="Close">&times;</button>
      </div>
      <div class="process-modal-body"></div>
    `;
    document.getElementById('content-body').appendChild(modal);
    modal.querySelector('.process-modal-close').addEventListener('click', () => {
      modal.classList.add('hidden');
    });
  }
  modal.querySelector('.process-modal-body').innerHTML = '';
  modal.classList.remove('hidden');
}

function appendToProcessModal(data) {
  const modal = document.getElementById('process-modal');
  if (!modal) return;
  const body = modal.querySelector('.process-modal-body');

  if (data.type === 'text') {
    const span = document.createElement('span');
    span.textContent = data.content;
    body.appendChild(span);
  } else if (data.type === 'error') {
    const div = document.createElement('div');
    div.className = 'process-error';
    div.textContent = data.content;
    body.appendChild(div);
  } else if (data.type === 'done') {
    const div = document.createElement('div');
    div.className = 'process-done';
    div.textContent = data.code === 0 ? 'Done.' : `Finished with code ${data.code}`;
    body.appendChild(div);
  }

  body.scrollTop = body.scrollHeight;
}

// --- Navigation ---

async function navigate(filePath, pushState = true) {
  const raw = await fetchText(`/api/file?path=${encodeURIComponent(filePath)}`);
  await loadFile(filePath, raw);

  // Show editor, hide tasks
  document.getElementById('editor-view').classList.remove('hidden');
  document.getElementById('tasks-view').classList.add('hidden');

  updateBreadcrumb(filePath);
  updateActiveNav(filePath);

  if (pushState) {
    history.pushState({ path: filePath }, '', `#${filePath}`);
  }
}

async function showTasks(pushState = true) {
  const tasks = await fetchJSON('/api/tasks');
  const container = document.getElementById('tasks-view');
  container.innerHTML = renderTasks(tasks);
  setupTaskInteractions(container);

  // Show tasks, hide editor
  container.classList.remove('hidden');
  document.getElementById('editor-view').classList.add('hidden');

  updateBreadcrumb('Tasks');
  updateActiveNav('__tasks__');
  updateProcessButton(0); // hide process button on tasks view

  if (pushState) {
    history.pushState({ view: 'tasks' }, '', '#tasks');
  }
}

// --- Sidebar ---

function renderSidebar(tree) {
  const nav = document.getElementById('sidebar-nav');
  let html = '';

  // Tasks
  html += `<div class="nav-section">
    <div class="nav-item nav-special" data-view="tasks">Tasks</div>
  </div>`;

  // People
  html += renderNavSection('People', () => {
    let inner = '';
    for (const [key, group] of Object.entries(tree.people)) {
      if (group.people.length === 0) continue;
      inner += `<div class="nav-group-header">${group.label}</div>`;
      for (const person of group.people) {
        const count = person.sessions.length;
        inner += `<div class="nav-item" data-path="${person.readmePath}">
          ${person.label}
          ${count ? `<span class="badge">${count}</span>` : ''}
        </div>`;
        for (const session of person.sessions) {
          inner += `<div class="nav-item nav-sub-item" data-path="${session.path}">${session.name}</div>`;
        }
      }
    }
    return inner;
  });

  // Meetings
  html += renderNavSection('Meetings', () => {
    let inner = '';
    for (const meeting of tree.meetings) {
      const count = meeting.sessions.length;
      inner += `<div class="nav-item" data-path="${meeting.readmePath}">
        ${meeting.label}
        ${count ? `<span class="badge">${count}</span>` : ''}
      </div>`;
      for (const session of meeting.sessions) {
        inner += `<div class="nav-item nav-sub-item" data-path="${session.path}">${session.name}</div>`;
      }
    }
    return inner;
  });

  // Projects
  html += renderNavSection('Projects', () => {
    let inner = '';
    for (const project of tree.projects) {
      const mainFile = project.files.find(f => f.name === 'README') || project.files[0];
      if (mainFile) {
        inner += `<div class="nav-item" data-path="${mainFile.path}">${project.label}</div>`;
      }
      for (const file of project.files) {
        if (file.name === 'README') continue;
        inner += `<div class="nav-item nav-sub-item" data-path="${file.path}">${file.name}</div>`;
      }
    }
    return inner;
  });

  // Areas
  html += renderNavSection('Areas', () => {
    let inner = '';
    for (const area of tree.areas) {
      inner += `<div class="nav-group-header">${area.label}</div>`;
      for (const file of area.files) {
        inner += `<div class="nav-item nav-sub-item" data-path="${file.path}">${file.name}</div>`;
      }
    }
    return inner;
  });

  // Reference
  html += renderNavSection('Reference', () => {
    let inner = '';
    for (const ref of tree.reference) {
      inner += `<div class="nav-item" data-path="${ref.path}">${ref.label}</div>`;
    }
    return inner;
  });

  nav.innerHTML = html;

  // Event delegation
  nav.addEventListener('click', (e) => {
    const item = e.target.closest('.nav-item');
    if (item) {
      const view = item.dataset.view;
      const path = item.dataset.path;
      if (view === 'tasks') showTasks();
      else if (path) navigate(path);
      return;
    }
    const header = e.target.closest('.nav-section-header');
    if (header) {
      header.parentElement.classList.toggle('collapsed');
    }
  });
}

function renderNavSection(label, contentFn) {
  return `<div class="nav-section">
    <div class="nav-section-header"><span class="chevron">&#9660;</span> ${label}</div>
    <div class="nav-section-items">${contentFn()}</div>
  </div>`;
}

function updateActiveNav(activePath) {
  document.querySelectorAll('.nav-item.active').forEach(el => el.classList.remove('active'));
  if (activePath === '__tasks__') {
    document.querySelector('.nav-item[data-view="tasks"]')?.classList.add('active');
  } else {
    document.querySelector(`.nav-item[data-path="${activePath}"]`)?.classList.add('active');
  }
}

// --- Breadcrumb ---

function updateBreadcrumb(filePath) {
  const bc = document.getElementById('breadcrumb');
  if (filePath === 'Tasks') {
    bc.innerHTML = '<span>Tasks</span>';
    return;
  }
  const parts = filePath.split('/');
  bc.innerHTML = parts.map(p => `<span>${p}</span>`).join('<span class="sep">/</span>');
}

// --- SSE ---

function setupSSE() {
  const events = new EventSource('/api/events');
  events.onmessage = async (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'reload') {
      // Refresh sidebar tree
      tree = await fetchJSON('/api/tree');
      renderSidebar(tree);
      const cp = getCurrentPath();
      if (cp) updateActiveNav(cp);

      // Don't reload the file we're currently editing (would clobber changes)
      // Only reload if it's a different file than what we're editing
      // (SSE fires on our own saves too - ignore those)
    }
  };
}

// --- Helpers ---

async function fetchJSON(url) {
  const res = await fetch(url);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  return res.text();
}
