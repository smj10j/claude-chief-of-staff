import { initEditor, loadFile, getCurrentPath } from './editor.js';
import { initToolbar } from './toolbar.js';
import { renderTasks, setupTaskInteractions } from './tasks.js';
import { initSearch, updateSearchTree } from './search.js';

let tree = null;
let isProcessing = false;
let annotatedFiles = new Set(); // paths with unprocessed annotations

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize editor
  const editorContainer = document.getElementById('editor-container');
  const bubbleMenu = document.getElementById('bubble-menu');

  const editor = initEditor(editorContainer, bubbleMenu, {
    onNavigate: (path) => navigate(path),
    onAnnotationsChanged: (count) => {
      updateProcessButton(count);
      refreshAnnotationIndicators();
    },
  });

  initToolbar(bubbleMenu);

  // Wire up Process button
  document.getElementById('process-btn').addEventListener('click', startProcessing);

  // Load sidebar
  tree = await fetchJSON('/api/tree');
  renderSidebar(tree);
  await refreshAnnotationIndicators();

  // Search (Cmd+K)
  initSearch(tree, (path) => {
    if (path === '__tasks__') showTasks();
    else navigate(path);
  });

  // Breadcrumb navigation
  setupBreadcrumbNav();

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

// --- Annotation indicators in sidebar ---

async function refreshAnnotationIndicators() {
  try {
    const data = await fetchJSON('/api/annotations/list');
    const list = data.files || data;
    annotatedFiles = new Set(list.map(f => f.path));
  } catch (e) {
    annotatedFiles = new Set();
  }
  applyAnnotationIndicators();
}

function applyAnnotationIndicators() {
  // Clear all existing indicators
  document.querySelectorAll('.annotation-dot').forEach(el => el.remove());

  // Add dots to nav items whose data-path is in annotatedFiles
  for (const path of annotatedFiles) {
    const item = document.querySelector(`.nav-item[data-path="${path}"]`);
    if (!item) continue;
    item.appendChild(createDot());

    // Bubble up: mark parent nav-group toggle and nav-section-header
    const group = item.closest('.nav-group');
    if (group) {
      const toggle = group.querySelector(':scope > .nav-group-toggle');
      if (toggle && !toggle.querySelector('.annotation-dot')) {
        toggle.appendChild(createDot());
      }
    }
    const section = item.closest('.nav-section');
    if (section) {
      const header = section.querySelector(':scope > .nav-section-header');
      if (header && !header.querySelector('.annotation-dot')) {
        header.appendChild(createDot());
      }
    }
  }
}

function createDot() {
  const dot = document.createElement('span');
  dot.className = 'annotation-dot';
  return dot;
}

// --- Navigation ---

async function navigate(filePath, pushState = true) {
  const raw = await fetchText(`/api/file?path=${encodeURIComponent(filePath)}`);
  await loadFile(filePath, raw);

  // Show editor, hide tasks
  document.getElementById('editor-view').classList.remove('hidden');
  document.getElementById('tasks-view').classList.add('hidden');

  updateBreadcrumb(filePath);
  updateActiveNav(filePath, { scroll: true });

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
  updateActiveNav('__tasks__', { scroll: true });
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
        inner += `<div class="nav-group collapsed">`;
        inner += `<div class="nav-item nav-group-toggle" data-path="${person.readmePath}">
          <span class="nav-item-label">${person.label}</span>
          ${count ? `<span class="badge">${count}</span>` : ''}
        </div>`;
        if (count) {
          inner += `<div class="nav-group-children">`;
          for (const session of person.sessions) {
            inner += `<div class="nav-item nav-sub-item" data-path="${session.path}">${session.name}</div>`;
          }
          inner += `</div>`;
        }
        inner += `</div>`;
      }
    }
    return inner;
  });

  // Meetings
  html += renderNavSection('Meetings', () => {
    let inner = '';
    for (const meeting of tree.meetings) {
      const count = meeting.sessions.length;
      inner += `<div class="nav-group collapsed">`;
      inner += `<div class="nav-item nav-group-toggle" data-path="${meeting.readmePath}">
        <span class="nav-item-label">${meeting.label}</span>
        ${count ? `<span class="badge">${count}</span>` : ''}
      </div>`;
      if (count) {
        inner += `<div class="nav-group-children">`;
        for (const session of meeting.sessions) {
          inner += `<div class="nav-item nav-sub-item" data-path="${session.path}">${session.name}</div>`;
        }
        inner += `</div>`;
      }
      inner += `</div>`;
    }
    return inner;
  });

  // Projects
  html += renderNavSection('Projects', () => {
    let inner = '';
    for (const project of tree.projects) {
      const mainFile = project.files.find(f => f.name === 'README') || project.files[0];
      const subFiles = project.files.filter(f => f.name !== 'README');
      inner += `<div class="nav-group collapsed">`;
      if (mainFile) {
        inner += `<div class="nav-item nav-group-toggle" data-path="${mainFile.path}">
          <span class="nav-item-label">${project.label}</span>
          ${subFiles.length ? `<span class="badge">${subFiles.length}</span>` : ''}
        </div>`;
      }
      if (subFiles.length) {
        inner += `<div class="nav-group-children">`;
        for (const file of subFiles) {
          inner += `<div class="nav-item nav-sub-item" data-path="${file.path}">${file.name}</div>`;
        }
        inner += `</div>`;
      }
      inner += `</div>`;
    }
    return inner;
  });

  // Areas
  html += renderNavSection('Areas', () => {
    let inner = '';
    for (const area of tree.areas) {
      inner += `<div class="nav-group collapsed">`;
      inner += `<div class="nav-group-header nav-group-toggle">${area.label}${area.files.length ? ` <span class="badge">${area.files.length}</span>` : ''}</div>`;
      inner += `<div class="nav-group-children">`;
      for (const file of area.files) {
        inner += `<div class="nav-item nav-sub-item" data-path="${file.path}">${file.name}</div>`;
      }
      inner += `</div></div>`;
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

  // CoS Development (cos-dev/)
  if (tree.docs && tree.docs.length) {
    html += renderNavSection('CoS Development', () => {
      let inner = '';
      for (const item of tree.docs) {
        if (item.type === 'file') {
          inner += `<div class="nav-item" data-path="${item.path}">${item.label}</div>`;
        } else if (item.type === 'dir') {
          const indexFile = item.files.find(f => f.name === 'INDEX');
          const subFiles = item.files.filter(f => f.name !== 'INDEX');
          inner += `<div class="nav-group collapsed">`;
          if (indexFile) {
            inner += `<div class="nav-item nav-group-toggle" data-path="${indexFile.path}">
              <span class="nav-item-label">${item.label}</span>
              ${subFiles.length ? `<span class="badge">${subFiles.length}</span>` : ''}
            </div>`;
          } else {
            inner += `<div class="nav-group-header nav-group-toggle">${item.label}</div>`;
          }
          if (subFiles.length) {
            inner += `<div class="nav-group-children">`;
            for (const file of subFiles) {
              inner += `<div class="nav-item nav-sub-item" data-path="${file.path}">${file.label}</div>`;
            }
            inner += `</div>`;
          }
          inner += `</div>`;
        }
      }
      return inner;
    });
  }

  // Save collapse state before re-render
  const collapsedSections = new Set();
  nav.querySelectorAll('.nav-section.collapsed .nav-section-header').forEach(el => {
    collapsedSections.add(el.textContent.trim());
  });
  const expandedGroups = new Set();
  nav.querySelectorAll('.nav-group:not(.collapsed) .nav-group-toggle').forEach(el => {
    expandedGroups.add(el.textContent.trim());
  });

  nav.innerHTML = html;

  // Restore collapse state
  nav.querySelectorAll('.nav-section-header').forEach(el => {
    if (collapsedSections.has(el.textContent.trim())) {
      el.parentElement.classList.add('collapsed');
    }
  });
  nav.querySelectorAll('.nav-group-toggle').forEach(el => {
    if (expandedGroups.has(el.textContent.trim())) {
      el.closest('.nav-group')?.classList.remove('collapsed');
    }
  });

  // Event delegation (only attach once)
  if (!nav._hasClickHandler) {
    nav._hasClickHandler = true;
    nav.addEventListener('click', (e) => {
      // Toggle nested groups
      const groupToggle = e.target.closest('.nav-group-toggle');
      if (groupToggle) {
        const group = groupToggle.closest('.nav-group');
        const clickedBadge = e.target.closest('.badge');
        const clickedLabel = e.target.closest('.nav-item-label');
        if (clickedBadge || (!clickedLabel && !groupToggle.dataset.path)) {
          if (group) group.classList.toggle('collapsed');
          return;
        }
        // Clicked the label — navigate AND expand
        if (group) group.classList.remove('collapsed');
        const path = groupToggle.dataset.path;
        if (path) navigate(path);
        return;
      }

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
}

function renderNavSection(label, contentFn) {
  return `<div class="nav-section">
    <div class="nav-section-header"><span class="chevron">&#9660;</span> ${label}</div>
    <div class="nav-section-items">${contentFn()}</div>
  </div>`;
}

function updateActiveNav(activePath, { scroll = false } = {}) {
  document.querySelectorAll('.nav-item.active').forEach(el => el.classList.remove('active'));
  let activeEl = null;
  if (activePath === '__tasks__') {
    activeEl = document.querySelector('.nav-item[data-view="tasks"]');
  } else {
    activeEl = document.querySelector(`.nav-item[data-path="${activePath}"]`);
  }
  if (activeEl) {
    activeEl.classList.add('active');
    if (scroll) {
      // Ensure all parent sections and groups are expanded
      const section = activeEl.closest('.nav-section');
      if (section) section.classList.remove('collapsed');
      const group = activeEl.closest('.nav-group');
      if (group) group.classList.remove('collapsed');
      // Scroll into view within the sidebar
      activeEl.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
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
  bc.innerHTML = parts.map((p, i) => {
    const isLast = i === parts.length - 1;
    if (isLast) return `<span class="current">${p}</span>`;
    const partialPath = parts.slice(0, i + 1).join('/');
    return `<span data-breadcrumb-path="${partialPath}">${p}</span>`;
  }).join('<span class="sep">/</span>');
}

function setupBreadcrumbNav() {
  const bc = document.getElementById('breadcrumb');
  bc.addEventListener('click', (e) => {
    const span = e.target.closest('[data-breadcrumb-path]');
    if (!span) return;
    const prefix = span.dataset.breadcrumbPath;
    // Find the best matching nav item in the sidebar
    const nav = document.getElementById('sidebar-nav');
    const allItems = nav.querySelectorAll('[data-path]');
    let bestMatch = null;
    let bestLen = 0;
    for (const item of allItems) {
      const path = item.dataset.path;
      // Exact prefix match or the path starts with prefix/
      if (path === prefix || path.startsWith(prefix + '/')) {
        // Prefer shortest matching path (closest to the directory level)
        if (!bestMatch || path.length < bestLen) {
          bestMatch = item;
          bestLen = path.length;
        }
      }
    }
    if (bestMatch) {
      const path = bestMatch.dataset.path;
      navigate(path);
    }
  });
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
      updateSearchTree(tree);
      await refreshAnnotationIndicators();
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
