// Quick search / command palette (Cmd+K)
// Searches file names from the navigation tree, keyboard-navigable results.

let overlayEl = null;
let inputEl = null;
let resultsEl = null;
let allItems = [];
let filteredItems = [];
let selectedIndex = 0;
let onSelect = null;

export function initSearch(tree, navigateFn) {
  onSelect = navigateFn;
  buildItemList(tree);

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      showSearch();
    }
    if (e.key === 'Escape' && overlayEl && !overlayEl.classList.contains('hidden')) {
      hideSearch();
    }
  });
}

export function updateSearchTree(tree) {
  buildItemList(tree);
}

function buildItemList(tree) {
  allItems = [];

  // Tasks
  allItems.push({ label: 'Tasks', path: '__tasks__', section: 'Tasks' });

  // People
  for (const [key, group] of Object.entries(tree.people || {})) {
    for (const person of group.people) {
      allItems.push({ label: person.label, path: person.readmePath, section: group.label });
      for (const session of person.sessions) {
        allItems.push({ label: `${person.label} / ${session.name}`, path: session.path, section: group.label });
      }
    }
  }

  // Meetings
  for (const meeting of tree.meetings || []) {
    allItems.push({ label: meeting.label, path: meeting.readmePath, section: 'Meetings' });
    for (const session of meeting.sessions) {
      allItems.push({ label: `${meeting.label} / ${session.name}`, path: session.path, section: 'Meetings' });
    }
  }

  // Projects
  for (const project of tree.projects || []) {
    const mainFile = project.files.find(f => f.name === 'README') || project.files[0];
    if (mainFile) {
      allItems.push({ label: project.label, path: mainFile.path, section: 'Projects' });
    }
    for (const file of project.files) {
      if (file.name === 'README') continue;
      allItems.push({ label: `${project.label} / ${file.name}`, path: file.path, section: 'Projects' });
    }
  }

  // Areas
  for (const area of tree.areas || []) {
    for (const file of area.files) {
      allItems.push({ label: file.name, path: file.path, section: area.label });
    }
  }

  // Reference
  for (const ref of tree.reference || []) {
    allItems.push({ label: ref.label, path: ref.path, section: 'Reference' });
  }
}

function ensureOverlay() {
  if (overlayEl) return;
  overlayEl = document.createElement('div');
  overlayEl.id = 'search-overlay';
  overlayEl.className = 'search-overlay hidden';
  overlayEl.innerHTML = `
    <div class="search-backdrop"></div>
    <div class="search-dialog">
      <input type="text" class="search-input" placeholder="Search files..." />
      <div class="search-results"></div>
    </div>
  `;
  document.body.appendChild(overlayEl);

  inputEl = overlayEl.querySelector('.search-input');
  resultsEl = overlayEl.querySelector('.search-results');

  inputEl.addEventListener('input', () => {
    filterItems(inputEl.value);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, filteredItems.length - 1);
      renderResults();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      renderResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectCurrent();
    }
  });

  overlayEl.querySelector('.search-backdrop').addEventListener('click', hideSearch);
}

function showSearch() {
  ensureOverlay();
  overlayEl.classList.remove('hidden');
  inputEl.value = '';
  filterItems('');
  inputEl.focus();
}

function hideSearch() {
  if (overlayEl) overlayEl.classList.add('hidden');
}

function filterItems(query) {
  selectedIndex = 0;
  if (!query.trim()) {
    filteredItems = allItems.slice(0, 20);
  } else {
    const terms = query.toLowerCase().split(/\s+/);
    filteredItems = allItems
      .map(item => {
        const text = (item.label + ' ' + item.section).toLowerCase();
        let score = 0;
        for (const term of terms) {
          const idx = text.indexOf(term);
          if (idx === -1) return null;
          // Boost exact start matches
          score += idx === 0 ? 2 : 1;
          // Boost label matches over section
          if (item.label.toLowerCase().indexOf(term) !== -1) score += 1;
        }
        return { ...item, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }
  renderResults();
}

function renderResults() {
  if (filteredItems.length === 0) {
    resultsEl.innerHTML = '<div class="search-empty">No results</div>';
    return;
  }

  resultsEl.innerHTML = filteredItems.map((item, i) => `
    <div class="search-result ${i === selectedIndex ? 'selected' : ''}" data-index="${i}">
      <span class="search-result-label">${escapeHtml(item.label)}</span>
      <span class="search-result-section">${escapeHtml(item.section)}</span>
    </div>
  `).join('');

  // Scroll selected into view
  const selected = resultsEl.querySelector('.search-result.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });

  // Click handler
  resultsEl.querySelectorAll('.search-result').forEach(el => {
    el.addEventListener('click', () => {
      selectedIndex = parseInt(el.dataset.index);
      selectCurrent();
    });
  });
}

function selectCurrent() {
  if (filteredItems.length === 0) return;
  const item = filteredItems[selectedIndex];
  hideSearch();
  if (onSelect) onSelect(item.path);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
