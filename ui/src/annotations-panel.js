// Annotation popover panel for creating and viewing annotation comments.
// Positioned absolutely within #content-body.

let panelEl = null;
let activeCallback = null;

function ensurePanel() {
  if (panelEl) return panelEl;
  panelEl = document.createElement('div');
  panelEl.id = 'annotation-panel';
  panelEl.className = 'annotation-panel hidden';
  document.getElementById('content-body').appendChild(panelEl);

  // Close on outside click
  document.addEventListener('mousedown', (e) => {
    if (panelEl && !panelEl.contains(e.target) && !panelEl.classList.contains('hidden')) {
      hideAnnotationPanel();
    }
  });

  return panelEl;
}

function positionPanel(coords) {
  const panel = ensurePanel();
  const contentBody = document.getElementById('content-body');
  const bodyRect = contentBody.getBoundingClientRect();

  let top = coords.bottom - bodyRect.top + contentBody.scrollTop + 8;
  let left = coords.left - bodyRect.left;

  // Keep within bounds
  left = Math.max(8, Math.min(left, bodyRect.width - 320));

  panel.style.top = `${top}px`;
  panel.style.left = `${left}px`;
}

export function showAnnotationInput(coords, onSave) {
  const panel = ensurePanel();
  activeCallback = onSave;

  panel.innerHTML = `
    <div class="annotation-panel-header">Add Annotation</div>
    <textarea class="annotation-input" placeholder="What should Claude do with this text?" rows="3"></textarea>
    <div class="annotation-panel-actions">
      <button class="btn btn-ghost annotation-cancel">Cancel</button>
      <button class="btn btn-primary annotation-save">Save</button>
    </div>
  `;

  positionPanel(coords);
  panel.classList.remove('hidden');

  const textarea = panel.querySelector('.annotation-input');
  textarea.focus();

  // Enter to save (Shift+Enter for newline)
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSave();
    }
    if (e.key === 'Escape') {
      hideAnnotationPanel();
    }
  });

  panel.querySelector('.annotation-save').addEventListener('click', doSave);
  panel.querySelector('.annotation-cancel').addEventListener('click', hideAnnotationPanel);

  function doSave() {
    const comment = textarea.value.trim();
    if (comment && activeCallback) {
      activeCallback(comment);
    }
    hideAnnotationPanel();
  }
}

export function showAnnotationDetail(annotation, coords, onDelete) {
  const panel = ensurePanel();

  const date = annotation.createdAt
    ? new Date(annotation.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';

  panel.innerHTML = `
    <div class="annotation-panel-header">
      Annotation
      ${date ? `<span class="annotation-date">${date}</span>` : ''}
    </div>
    <div class="annotation-comment">${escapeHtml(annotation.comment)}</div>
    <div class="annotation-panel-actions">
      <button class="btn btn-ghost annotation-delete">Delete</button>
      <button class="btn btn-ghost annotation-close">Close</button>
    </div>
  `;

  positionPanel(coords);
  panel.classList.remove('hidden');

  panel.querySelector('.annotation-delete').addEventListener('click', () => {
    if (onDelete) onDelete(annotation.id);
    hideAnnotationPanel();
  });

  panel.querySelector('.annotation-close').addEventListener('click', hideAnnotationPanel);
}

export function hideAnnotationPanel() {
  if (panelEl) {
    panelEl.classList.add('hidden');
    panelEl.innerHTML = '';
  }
  activeCallback = null;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
