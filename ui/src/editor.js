import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import BubbleMenu from '@tiptap/extension-bubble-menu';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Link from '@tiptap/extension-link';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';

const lowlight = createLowlight(common);

let editor = null;
let currentPath = null;
let isDirty = false;
let isSaving = false;
let saveTimer = null;
let autoSaveInterval = null;
let onNavigate = null;

// Debounced save after edits
const DEBOUNCE_MS = 2000;
// Periodic save interval
const AUTOSAVE_MS = 30000;

export function initEditor(containerEl, bubbleMenuEl, opts = {}) {
  onNavigate = opts.onNavigate || null;

  editor = new Editor({
    element: containerEl,
    extensions: [
      StarterKit.configure({
        codeBlock: false, // replaced by CodeBlockLowlight
      }),
      Markdown.configure({
        html: true,
        tightLists: true,
        bulletListMarker: '-',
        transformPastedText: true,
        transformCopiedText: true,
      }),
      BubbleMenu.configure({
        element: bubbleMenuEl,
        tippyOptions: {
          duration: 150,
          placement: 'top',
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: 'editor-link' },
      }),
      CodeBlockLowlight.configure({ lowlight }),
    ],
    editorProps: {
      attributes: {
        class: 'editor-content',
      },
      handleClick(view, pos, event) {
        // Handle link clicks
        const link = event.target.closest('a.editor-link');
        if (link && event.metaKey) {
          const href = link.getAttribute('href');
          if (href && !href.startsWith('http') && !href.startsWith('#')) {
            event.preventDefault();
            if (onNavigate) {
              const dir = currentPath ? currentPath.substring(0, currentPath.lastIndexOf('/')) : '';
              const resolved = resolvePath(dir, href);
              onNavigate(resolved);
            }
            return true;
          }
          if (href && href.startsWith('http')) {
            window.open(href, '_blank');
            return true;
          }
        }
        return false;
      },
    },
    onUpdate() {
      if (!currentPath) return;
      isDirty = true;
      updateSaveStatus('unsaved');
      debouncedSave();
    },
  });

  // Periodic autosave
  autoSaveInterval = setInterval(() => {
    if (isDirty && !isSaving) save();
  }, AUTOSAVE_MS);

  // Save on blur
  window.addEventListener('blur', () => {
    if (isDirty && !isSaving) save();
  });

  return editor;
}

export function loadFile(filePath, markdown) {
  if (!editor) return;

  // Save current file first
  if (isDirty && currentPath) {
    saveSync();
  }

  currentPath = filePath;
  isDirty = false;
  editor.commands.setContent(markdown);
  editor.setEditable(true);
  updateSaveStatus('saved');

  // Scroll to top
  editor.commands.focus('start');
  const editorEl = editor.options.element;
  const scrollParent = editorEl.closest('#content-body');
  if (scrollParent) scrollParent.scrollTop = 0;
}

export function getMarkdown() {
  if (!editor) return '';
  return editor.storage.markdown.getMarkdown();
}

export function getCurrentPath() {
  return currentPath;
}

export function setReadOnly(readOnly) {
  if (editor) editor.setEditable(!readOnly);
}

export function getEditor() {
  return editor;
}

// --- Save ---

function debouncedSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (isDirty && !isSaving) save();
  }, DEBOUNCE_MS);
}

async function save() {
  if (!currentPath || !isDirty || isSaving) return;
  isSaving = true;
  updateSaveStatus('saving');

  const markdown = getMarkdown();
  try {
    await fetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentPath, content: markdown }),
    });
    isDirty = false;
    updateSaveStatus('saved');
  } catch (e) {
    updateSaveStatus('error');
  } finally {
    isSaving = false;
  }
}

function saveSync() {
  if (!currentPath || !isDirty) return;
  const markdown = getMarkdown();
  const xhr = new XMLHttpRequest();
  xhr.open('PUT', '/api/file', false);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.send(JSON.stringify({ path: currentPath, content: markdown }));
  isDirty = false;
}

function updateSaveStatus(status) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.className = `save-status ${status}`;
  const labels = { saved: 'Saved', saving: 'Saving...', unsaved: 'Unsaved', error: 'Save failed' };
  el.textContent = labels[status] || '';
}

// --- Helpers ---

function resolvePath(base, relative) {
  const parts = (base + '/' + relative).split('/');
  const resolved = [];
  for (const part of parts) {
    if (part === '..') resolved.pop();
    else if (part !== '.' && part !== '') resolved.push(part);
  }
  return resolved.join('/');
}

// --- Toolbar actions (exported for bubble menu) ---

export function toggleBold() { editor?.chain().focus().toggleBold().run(); }
export function toggleItalic() { editor?.chain().focus().toggleItalic().run(); }
export function toggleStrike() { editor?.chain().focus().toggleStrike().run(); }
export function toggleCode() { editor?.chain().focus().toggleCode().run(); }
export function toggleHeading(level) { editor?.chain().focus().toggleHeading({ level }).run(); }
export function toggleBulletList() { editor?.chain().focus().toggleBulletList().run(); }
export function toggleOrderedList() { editor?.chain().focus().toggleOrderedList().run(); }
export function toggleTaskList() { editor?.chain().focus().toggleTaskList().run(); }
export function toggleBlockquote() { editor?.chain().focus().toggleBlockquote().run(); }
export function toggleCodeBlock() { editor?.chain().focus().toggleCodeBlock().run(); }
export function setLink() {
  const url = window.prompt('URL:');
  if (url) editor?.chain().focus().setLink({ href: url }).run();
}
export function unsetLink() { editor?.chain().focus().unsetLink().run(); }

export function isActive(name, attrs) {
  return editor?.isActive(name, attrs) || false;
}
