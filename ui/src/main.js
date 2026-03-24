import { initEditor, loadFile, getCurrentPath } from './editor.js';
import { initToolbar } from './toolbar.js';
import { renderTasks, setupTaskInteractions } from './tasks.js';

let tree = null;

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize editor
  const editorContainer = document.getElementById('editor-container');
  const bubbleMenu = document.getElementById('bubble-menu');

  const editor = initEditor(editorContainer, bubbleMenu, {
    onNavigate: (path) => navigate(path),
  });

  initToolbar(bubbleMenu);

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

// --- Navigation ---

async function navigate(filePath, pushState = true) {
  const raw = await fetchText(`/api/file?path=${encodeURIComponent(filePath)}`);
  loadFile(filePath, raw);

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
