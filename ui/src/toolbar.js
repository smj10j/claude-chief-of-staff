import {
  toggleBold, toggleItalic, toggleStrike, toggleCode,
  toggleHeading, toggleBulletList, toggleOrderedList,
  toggleTaskList, toggleBlockquote, toggleCodeBlock,
  setLink, unsetLink, isActive, getEditor,
} from './editor.js';

// Floating toolbar (Notion-style bubble menu)
// The BubbleMenu extension handles showing/hiding.
// We just need to wire up the buttons.

export function initToolbar(bubbleMenuEl) {
  bubbleMenuEl.innerHTML = `
    <div class="toolbar">
      <button data-action="heading" data-level="1" title="Heading 1">H1</button>
      <button data-action="heading" data-level="2" title="Heading 2">H2</button>
      <button data-action="heading" data-level="3" title="Heading 3">H3</button>
      <span class="toolbar-sep"></span>
      <button data-action="bold" title="Bold (Cmd+B)"><strong>B</strong></button>
      <button data-action="italic" title="Italic (Cmd+I)"><em>I</em></button>
      <button data-action="strike" title="Strikethrough">S</button>
      <button data-action="code" title="Inline code">&#60;/&#62;</button>
      <span class="toolbar-sep"></span>
      <button data-action="link" title="Link">Link</button>
      <span class="toolbar-sep"></span>
      <button data-action="bulletList" title="Bullet list">&#8226;</button>
      <button data-action="orderedList" title="Numbered list">1.</button>
      <button data-action="taskList" title="Task list">&#9745;</button>
      <span class="toolbar-sep"></span>
      <button data-action="blockquote" title="Quote">&#8220;</button>
      <button data-action="codeBlock" title="Code block">{ }</button>
    </div>
  `;

  bubbleMenuEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    const action = btn.dataset.action;
    switch (action) {
      case 'bold': toggleBold(); break;
      case 'italic': toggleItalic(); break;
      case 'strike': toggleStrike(); break;
      case 'code': toggleCode(); break;
      case 'heading': toggleHeading(parseInt(btn.dataset.level)); break;
      case 'bulletList': toggleBulletList(); break;
      case 'orderedList': toggleOrderedList(); break;
      case 'taskList': toggleTaskList(); break;
      case 'blockquote': toggleBlockquote(); break;
      case 'codeBlock': toggleCodeBlock(); break;
      case 'link':
        if (isActive('link')) unsetLink();
        else setLink();
        break;
    }

    updateActiveStates(bubbleMenuEl);
  });

  // Update active button states when editor selection changes
  const editor = getEditor();
  if (editor) {
    editor.on('selectionUpdate', () => updateActiveStates(bubbleMenuEl));
    editor.on('transaction', () => updateActiveStates(bubbleMenuEl));
  }
}

function updateActiveStates(menuEl) {
  const buttons = menuEl.querySelectorAll('button');
  buttons.forEach(btn => {
    const action = btn.dataset.action;
    let active = false;
    switch (action) {
      case 'bold': active = isActive('bold'); break;
      case 'italic': active = isActive('italic'); break;
      case 'strike': active = isActive('strike'); break;
      case 'code': active = isActive('code'); break;
      case 'heading': active = isActive('heading', { level: parseInt(btn.dataset.level) }); break;
      case 'bulletList': active = isActive('bulletList'); break;
      case 'orderedList': active = isActive('orderedList'); break;
      case 'taskList': active = isActive('taskList'); break;
      case 'blockquote': active = isActive('blockquote'); break;
      case 'codeBlock': active = isActive('codeBlock'); break;
      case 'link': active = isActive('link'); break;
    }
    btn.classList.toggle('active', active);
  });
}
