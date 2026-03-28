// Task dashboard rendering, editing, and interactions

let refreshCallback = null;
let allTasks = null;
let activeFilter = 'all';
let editingTaskId = null; // currently open edit panel (null = none, 'new' = creating)

export function setRefreshCallback(fn) {
  refreshCallback = fn;
}

export function renderTasks(tasks) {
  allTasks = tasks;
  const today = new Date().toISOString().slice(0, 10);
  let html = '';

  // Collect all tags and projects for autocomplete
  const allTags = new Set();
  const allProjects = new Set();
  for (const t of tasks.active) {
    (t.tags || []).forEach(tag => allTags.add(tag));
    if (t.project) allProjects.add(t.project);
  }

  html += `<div class="tasks-view">`;
  html += `<div class="tasks-header-row">
    <h1>Tasks</h1>
    <button class="btn btn-primary" id="new-task-btn">+ New Task</button>
  </div>`;

  // Filters
  html += `<div class="tasks-filters">
    <button class="filter-btn${activeFilter === 'all' ? ' active' : ''}" data-filter="all">All</button>
    <button class="filter-btn${activeFilter === 'work' ? ' active' : ''}" data-filter="work">Work</button>
    <button class="filter-btn${activeFilter === 'personal' ? ' active' : ''}" data-filter="personal">Personal</button>`;
  const teamTags = [...allTags].filter(t => t.startsWith('team:')).sort();
  for (const tag of teamTags) {
    html += `<button class="filter-btn${activeFilter === tag ? ' active' : ''}" data-filter="${tag}">${tag}</button>`;
  }
  html += `</div>`;

  // New task panel (if creating)
  if (editingTaskId === 'new') {
    html += renderEditPanel(null, allTags, allProjects);
  }

  // Datalists for autocomplete (hidden)
  html += `<datalist id="tag-suggestions">${[...allTags].map(t => `<option value="${t}">`).join('')}</datalist>`;
  html += `<datalist id="project-suggestions">${[...allProjects].map(p => `<option value="${p}">`).join('')}</datalist>`;

  // Active tasks
  const overdue = tasks.active.filter(t => t.due && t.due < today).sort((a, b) => (a.due || '').localeCompare(b.due || ''));
  const upcoming = tasks.active.filter(t => t.due && t.due >= today).sort((a, b) => (a.due || '').localeCompare(b.due || ''));
  const noDue = tasks.active.filter(t => !t.due);

  if (overdue.length) {
    html += `<div class="tasks-section-header">Overdue (${overdue.length})</div>`;
    html += overdue.map(t => renderTaskCard(t, today, false, allTags, allProjects)).join('');
  }

  if (upcoming.length) {
    html += `<div class="tasks-section-header">Upcoming</div>`;
    html += upcoming.map(t => renderTaskCard(t, today, false, allTags, allProjects)).join('');
  }

  if (noDue.length) {
    html += `<div class="tasks-section-header">No Due Date</div>`;
    html += noDue.map(t => renderTaskCard(t, today, false, allTags, allProjects)).join('');
  }

  if (tasks.recurring.length) {
    html += `<div class="tasks-section-header">Recurring</div>`;
    html += tasks.recurring.map(t => renderTaskCard(t, today, true, allTags, allProjects)).join('');
  }

  html += `</div>`;

  // Toast container
  html += `<div id="task-toast" class="task-toast hidden"></div>`;

  return html;
}

function renderTaskCard(task, today, isRecurring = false, allTags = new Set(), allProjects = new Set()) {
  const isOverdue = !isRecurring && task.due && task.due < today;
  const tags = (task.tags || []).map(t => `<span class="task-tag">${escapeHtml(t)}</span>`).join(' ');
  const dueText = task.due ? task.due : (isRecurring && task.cadence ? task.cadence : 'no date');
  const priority = task.priority || 'medium';
  const notes = task.notes ? task.notes.trim() : '';
  const project = task.project ? `<span class="task-tag">${escapeHtml(task.project)}</span>` : '';
  const isEditing = editingTaskId === task.id;

  let cardHtml = `<div class="task-card${isEditing ? ' editing' : ''}" data-tags="${(task.tags || []).join(',')}" data-id="${task.id}">
    <div class="task-card-header">`;

  // Checkbox for mark-done (active tasks only)
  if (!isRecurring) {
    cardHtml += `<label class="task-checkbox" title="Mark done"><input type="checkbox" data-done-id="${task.id}"><span class="task-checkbox-mark"></span></label>`;
  }

  cardHtml += `<span class="task-priority ${priority}">${priority}</span>
      <span class="task-card-title">${escapeHtml(task.title)}</span>
    </div>
    <div class="task-meta">
      <span class="${isOverdue ? 'task-overdue' : ''}">${isOverdue ? 'OVERDUE: ' : ''}${dueText}</span>
      ${project}
      ${tags}
    </div>
    ${notes ? `<div class="task-notes">${escapeHtml(notes)}</div>` : ''}`;

  // Edit panel (inline, below card content)
  if (isEditing) {
    cardHtml += renderEditPanel(task, allTags, allProjects);
  }

  cardHtml += `</div>`;
  return cardHtml;
}

function renderEditPanel(task, allTags, allProjects) {
  const isNew = !task;
  const title = task ? escapeAttr(task.title) : '';
  const status = task ? task.status : 'todo';
  const priority = task ? task.priority : 'medium';
  const due = task ? (task.due || '') : '';
  const project = task ? (task.project || '') : '';
  const tags = task ? (task.tags || []) : [];
  const notes = task ? (task.notes || '') : '';

  return `<div class="task-edit-panel" data-edit-id="${isNew ? 'new' : task.id}">
    <div class="task-edit-field">
      <label>Title</label>
      <input type="text" name="title" value="${title}" placeholder="Task title" required>
    </div>
    <div class="task-edit-row">
      <div class="task-edit-field">
        <label>Status</label>
        <select name="status">
          <option value="todo"${status === 'todo' ? ' selected' : ''}>Todo</option>
          <option value="in-progress"${status === 'in-progress' ? ' selected' : ''}>In Progress</option>
        </select>
      </div>
      <div class="task-edit-field">
        <label>Priority</label>
        <select name="priority">
          <option value="high"${priority === 'high' ? ' selected' : ''}>High</option>
          <option value="medium"${priority === 'medium' ? ' selected' : ''}>Medium</option>
          <option value="low"${priority === 'low' ? ' selected' : ''}>Low</option>
        </select>
      </div>
      <div class="task-edit-field">
        <label>Due</label>
        <input type="date" name="due" value="${due}">
      </div>
    </div>
    <div class="task-edit-field">
      <label>Project</label>
      <input type="text" name="project" value="${escapeAttr(project)}" placeholder="Project ID" list="project-suggestions">
    </div>
    <div class="task-edit-field">
      <label>Tags</label>
      <div class="tag-editor">
        <div class="tag-pills">${tags.map(t => `<span class="tag-pill" data-tag="${escapeAttr(t)}">${escapeHtml(t)} <button class="tag-remove">&times;</button></span>`).join('')}</div>
        <input type="text" class="tag-input" placeholder="Add tag..." list="tag-suggestions">
      </div>
    </div>
    <div class="task-edit-field">
      <label>Notes</label>
      <textarea name="notes" placeholder="Notes..." rows="3">${escapeHtml(notes)}</textarea>
    </div>
    <div class="task-edit-actions">
      <div class="task-edit-actions-left">
        ${!isNew ? `<button class="btn task-delete-btn" data-delete-id="${task.id}" title="Delete task">Delete</button>` : ''}
      </div>
      <div class="task-edit-actions-right">
        <button class="btn btn-ghost task-cancel-btn">Cancel</button>
        <button class="btn btn-primary task-save-btn">${isNew ? 'Create' : 'Save'}</button>
      </div>
    </div>
  </div>`;
}

export function setupTaskInteractions(container) {
  applyFilter(container);

  // Only attach event handlers once (container persists across refreshes)
  if (container._hasTaskHandlers) return;
  container._hasTaskHandlers = true;

  // Event delegation for all task interactions
  container.addEventListener('click', async (e) => {
    // Filters
    const filterBtn = e.target.closest('.filter-btn');
    if (filterBtn) {
      container.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      filterBtn.classList.add('active');
      activeFilter = filterBtn.dataset.filter;
      applyFilter(container);
      return;
    }

    // New task button
    if (e.target.closest('#new-task-btn')) {
      editingTaskId = 'new';
      refresh();
      return;
    }

    // Mark done checkbox
    const checkbox = e.target.closest('[data-done-id]');
    if (checkbox) {
      e.stopPropagation();
      const id = checkbox.dataset.doneId;
      await markTaskDone(id);
      return;
    }

    // Tag remove
    if (e.target.closest('.tag-remove')) {
      e.stopPropagation();
      const pill = e.target.closest('.tag-pill');
      if (pill) pill.remove();
      return;
    }

    // Save
    if (e.target.closest('.task-save-btn')) {
      e.stopPropagation();
      const panel = e.target.closest('.task-edit-panel');
      if (panel) await saveTask(panel);
      return;
    }

    // Cancel
    if (e.target.closest('.task-cancel-btn')) {
      e.stopPropagation();
      editingTaskId = null;
      refresh();
      return;
    }

    // Delete
    if (e.target.closest('.task-delete-btn')) {
      e.stopPropagation();
      const id = e.target.closest('.task-delete-btn').dataset.deleteId;
      await confirmDeleteTask(id, container);
      return;
    }

    // Click task card to toggle edit panel (not on recurring cards, not on links/buttons)
    const card = e.target.closest('.task-card');
    if (card && !e.target.closest('.task-edit-panel') && !e.target.closest('label') && !e.target.closest('button')) {
      const id = card.dataset.id;
      // Don't open edit for recurring tasks
      if (card.closest('.tasks-view') && allTasks) {
        const isRecurring = allTasks.recurring.some(t => t.id === id);
        if (isRecurring) return;
      }
      editingTaskId = editingTaskId === id ? null : id;
      refresh();
    }
  });

  // Escape to close edit panel
  container.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && editingTaskId) {
      editingTaskId = null;
      refresh();
    }
  });

  // Tag input - add tag on Enter or comma
  container.addEventListener('keydown', (e) => {
    if (e.target.classList.contains('tag-input')) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const val = e.target.value.replace(',', '').trim();
        if (val) {
          const pills = e.target.closest('.tag-editor').querySelector('.tag-pills');
          // Don't add duplicate
          if (!pills.querySelector(`[data-tag="${val}"]`)) {
            const pill = document.createElement('span');
            pill.className = 'tag-pill';
            pill.dataset.tag = val;
            pill.innerHTML = `${escapeHtml(val)} <button class="tag-remove">&times;</button>`;
            pills.appendChild(pill);
          }
          e.target.value = '';
        }
      }
    }
  });

  // Auto-grow textarea
  container.addEventListener('input', (e) => {
    if (e.target.tagName === 'TEXTAREA') {
      e.target.style.height = 'auto';
      e.target.style.height = e.target.scrollHeight + 'px';
    }
  });

  applyFilter(container);
}

function applyFilter(container) {
  container.querySelectorAll('.task-card').forEach(card => {
    if (activeFilter === 'all') card.style.display = '';
    else card.style.display = card.dataset.tags.includes(activeFilter) ? '' : 'none';
  });
}

async function saveTask(panel) {
  const editId = panel.dataset.editId;
  const isNew = editId === 'new';

  const title = panel.querySelector('[name="title"]').value.trim();
  if (!title) {
    panel.querySelector('[name="title"]').focus();
    return;
  }

  const tags = [...panel.querySelectorAll('.tag-pill')].map(p => p.dataset.tag);

  const body = {
    title,
    status: panel.querySelector('[name="status"]').value,
    priority: panel.querySelector('[name="priority"]').value,
    due: panel.querySelector('[name="due"]').value || null,
    project: panel.querySelector('[name="project"]').value.trim() || null,
    tags,
    notes: panel.querySelector('[name="notes"]').value || null,
  };

  try {
    if (isNew) {
      await fetchAPI('/api/task', { method: 'POST', body });
    } else {
      await fetchAPI(`/api/task/${editId}`, { method: 'PUT', body });
    }
    editingTaskId = null;
    refresh();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function markTaskDone(id) {
  try {
    await fetchAPI(`/api/task/${id}/done`, { method: 'POST' });
    showToast('Task marked done', 'success', [
      { label: 'Undo', action: () => undoMarkDone(id) }
    ]);
    refresh();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function undoMarkDone(id) {
  try {
    await fetchAPI(`/api/task/${id}/unarchive`, { method: 'POST' });
    refresh();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function confirmDeleteTask(id, container) {
  const task = allTasks?.active.find(t => t.id === id);
  const name = task ? task.title : id;

  // Simple confirm dialog
  if (!confirm(`Delete "${name}"?\n\nThis cannot be undone.`)) return;

  try {
    await fetchAPI(`/api/task/${id}`, { method: 'DELETE' });
    editingTaskId = null;
    showToast('Task deleted', 'success');
    refresh();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

function refresh() {
  if (refreshCallback) refreshCallback();
}

// --- Toast ---

let toastTimer = null;

function showToast(message, type = 'success', actions = []) {
  const toast = document.getElementById('task-toast');
  if (!toast) return;

  clearTimeout(toastTimer);

  let html = `<span class="toast-message">${escapeHtml(message)}</span>`;
  for (const action of actions) {
    html += `<button class="toast-action" data-toast-action="${escapeAttr(action.label)}">${escapeHtml(action.label)}</button>`;
    // Store callback
    toast._actions = toast._actions || {};
    toast._actions[action.label] = action.action;
  }

  toast.innerHTML = html;
  toast.className = `task-toast ${type}`;

  // Wire action buttons
  toast.querySelectorAll('.toast-action').forEach(btn => {
    btn.addEventListener('click', () => {
      const fn = toast._actions?.[btn.dataset.toastAction];
      if (fn) fn();
      toast.classList.add('hidden');
      clearTimeout(toastTimer);
    });
  });

  toastTimer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 5000);
}

// --- API helper ---

async function fetchAPI(url, { method = 'GET', body } = {}) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// --- Helpers ---

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
