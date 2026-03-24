// Task dashboard rendering and interactions

export function renderTasks(tasks) {
  const today = new Date().toISOString().slice(0, 10);
  let html = '';

  // Collect all tags
  const allTags = new Set();
  for (const t of tasks.active) {
    (t.tags || []).forEach(tag => allTags.add(tag));
  }

  html += `<div class="tasks-view">`;
  html += `<h1>Tasks</h1>`;

  // Filters
  html += `<div class="tasks-filters">
    <button class="filter-btn active" data-filter="all">All</button>
    <button class="filter-btn" data-filter="work">Work</button>
    <button class="filter-btn" data-filter="personal">Personal</button>`;
  const teamTags = [...allTags].filter(t => t.startsWith('team:')).sort();
  for (const tag of teamTags) {
    html += `<button class="filter-btn" data-filter="${tag}">${tag}</button>`;
  }
  html += `</div>`;

  // Active tasks
  const overdue = tasks.active.filter(t => t.due && t.due < today).sort((a, b) => (a.due || '').localeCompare(b.due || ''));
  const upcoming = tasks.active.filter(t => t.due && t.due >= today).sort((a, b) => (a.due || '').localeCompare(b.due || ''));
  const noDue = tasks.active.filter(t => !t.due);

  if (overdue.length) {
    html += `<div class="tasks-section-header">Overdue (${overdue.length})</div>`;
    html += overdue.map(t => renderTaskCard(t, today)).join('');
  }

  if (upcoming.length) {
    html += `<div class="tasks-section-header">Upcoming</div>`;
    html += upcoming.map(t => renderTaskCard(t, today)).join('');
  }

  if (noDue.length) {
    html += `<div class="tasks-section-header">No Due Date</div>`;
    html += noDue.map(t => renderTaskCard(t, today)).join('');
  }

  if (tasks.recurring.length) {
    html += `<div class="tasks-section-header">Recurring</div>`;
    html += tasks.recurring.map(t => renderTaskCard(t, today, true)).join('');
  }

  html += `</div>`;
  return html;
}

function renderTaskCard(task, today, isRecurring = false) {
  const isOverdue = !isRecurring && task.due && task.due < today;
  const tags = (task.tags || []).map(t => `<span class="task-tag">${t}</span>`).join(' ');
  const dueText = task.due ? task.due : (isRecurring && task.cadence ? task.cadence : 'no date');
  const priority = task.priority || 'medium';
  const notes = task.notes ? task.notes.trim() : '';
  const project = task.project ? `<span class="task-tag">${task.project}</span>` : '';

  return `<div class="task-card" data-tags="${(task.tags || []).join(',')}" data-id="${task.id}">
    <div class="task-card-header">
      <span class="task-priority ${priority}">${priority}</span>
      <span class="task-card-title">${escapeHtml(task.title)}</span>
    </div>
    <div class="task-meta">
      <span class="${isOverdue ? 'task-overdue' : ''}">${isOverdue ? 'OVERDUE: ' : ''}${dueText}</span>
      ${project}
      ${tags}
    </div>
    ${notes ? `<div class="task-notes">${escapeHtml(notes)}</div>` : ''}
  </div>`;
}

export function setupTaskInteractions(container) {
  // Filters
  container.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const filter = btn.dataset.filter;
      container.querySelectorAll('.task-card').forEach(card => {
        if (filter === 'all') card.style.display = '';
        else card.style.display = card.dataset.tags.includes(filter) ? '' : 'none';
      });
    });
  });

  // Expand/collapse
  container.querySelectorAll('.task-card').forEach(card => {
    card.addEventListener('click', () => card.classList.toggle('expanded'));
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
