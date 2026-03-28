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
import { Annotation } from './annotations.js';
import { loadAnnotations, saveAnnotations, getAnnotations, deleteAnnotation, generateId } from './annotations-store.js';
import { showAnnotationDetail, hideAnnotationPanel } from './annotations-panel.js';

const lowlight = createLowlight(common);

let editor = null;
let currentPath = null;
let isDirty = false;
let isSaving = false;
let isHydrating = false;
let saveTimer = null;
let autoSaveInterval = null;
let onNavigate = null;
let onAnnotationsChanged = null;

// Debounced save after edits
const DEBOUNCE_MS = 2000;
// Periodic save interval
const AUTOSAVE_MS = 30000;

export function initEditor(containerEl, bubbleMenuEl, opts = {}) {
  onNavigate = opts.onNavigate || null;
  onAnnotationsChanged = opts.onAnnotationsChanged || null;

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
          maxWidth: 'none',
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false, allowTableNodeSelection: true }),
      TableRow,
      TableCell,
      TableHeader,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: 'editor-link' },
      }),
      CodeBlockLowlight.configure({ lowlight }),
      Annotation,
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
      if (!currentPath || isHydrating) return;
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

  // Direct DOM listener for annotation clicks (more reliable than ProseMirror handleClick)
  containerEl.addEventListener('click', (e) => {
    const annotationEl = e.target.closest('mark.annotation-highlight');
    if (!annotationEl) return;
    const id = annotationEl.getAttribute('data-annotation-id');
    const annotation = getAnnotations().find(a => a.id === id);
    if (!annotation) return;

    e.preventDefault();
    e.stopPropagation();
    const rect = annotationEl.getBoundingClientRect();
    showAnnotationDetail(annotation, rect, async (deleteId) => {
      await removeAnnotation(deleteId);
    });
  });

  return editor;
}

export async function loadFile(filePath, markdown) {
  if (!editor) return;

  // Save current file first
  if (isDirty && currentPath) {
    saveSync();
  }

  hideAnnotationPanel();
  currentPath = filePath;
  isDirty = false;
  editor.commands.setContent(markdown);
  editor.setEditable(true);
  updateSaveStatus('saved');

  // Hydrate annotations from store
  await hydrateAnnotations(filePath);

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

// --- Annotation helpers ---

async function hydrateAnnotations(filePath) {
  const annotations = await loadAnnotations(filePath);
  if (!annotations.length) {
    notifyAnnotationsChanged(0);
    return;
  }

  isHydrating = true;
  const docText = editor.state.doc.textContent;

  for (const annotation of annotations) {
    const range = findTextRange(editor.state.doc, annotation.text, annotation.textBefore, annotation.textAfter);
    if (range) {
      editor.chain()
        .setTextSelection(range)
        .setAnnotation({ id: annotation.id, comment: annotation.comment })
        .run();
    }
  }

  // Reset state after hydration
  editor.commands.setTextSelection(0);
  isDirty = false;
  isHydrating = false;
  notifyAnnotationsChanged(annotations.length);
}

// Find a text range in the ProseMirror document by searching for text content.
// Uses doc.textBetween with block separators to build a position map,
// so string indices map correctly to ProseMirror positions.
function findTextRange(doc, text, textBefore, textAfter) {
  // Build a text string with a position map: for each character in the string,
  // track its ProseMirror position.
  const posMap = [];
  const chars = [];

  doc.descendants((node, pos) => {
    if (node.isText) {
      for (let i = 0; i < node.text.length; i++) {
        chars.push(node.text[i]);
        posMap.push(pos + i);
      }
    } else if (node.isBlock && chars.length > 0 && chars[chars.length - 1] !== '\n') {
      // Add a separator between blocks so text from different paragraphs
      // doesn't run together
      chars.push('\n');
      posMap.push(-1); // sentinel: not a real position
    }
    return true; // continue traversal
  });

  const fullText = chars.join('');

  // Try match with surrounding context first
  if (textBefore || textAfter) {
    const searchStr = (textBefore || '') + text + (textAfter || '');
    const idx = fullText.indexOf(searchStr);
    if (idx !== -1) {
      const start = idx + (textBefore || '').length;
      const end = start + text.length;
      const fromPos = posMap[start];
      const toPos = posMap[end - 1] + 1;
      if (fromPos >= 0 && toPos > fromPos) {
        return { from: fromPos, to: toPos };
      }
    }
  }

  // Fallback: find the text directly
  const idx = fullText.indexOf(text);
  if (idx !== -1) {
    const fromPos = posMap[idx];
    const toPos = posMap[idx + text.length - 1] + 1;
    if (fromPos >= 0 && toPos > fromPos) {
      return { from: fromPos, to: toPos };
    }
  }

  return null;
}

export async function addAnnotation(comment) {
  if (!editor || !currentPath) return;

  const { from, to } = editor.state.selection;
  if (from === to) return; // no selection

  const selectedText = editor.state.doc.textBetween(from, to);
  // Use ProseMirror's textBetween to get surrounding context with correct positions
  const docSize = editor.state.doc.content.size;
  const textBefore = editor.state.doc.textBetween(Math.max(1, from - 30), from, '\n');
  const textAfter = editor.state.doc.textBetween(to, Math.min(docSize, to + 30), '\n');

  const id = generateId();
  const annotation = {
    id,
    text: selectedText,
    comment,
    textBefore,
    textAfter,
    createdAt: new Date().toISOString(),
  };

  // Apply the mark visually
  editor.chain()
    .setAnnotation({ id, comment })
    .run();

  // Persist immediately
  const annotations = [...getAnnotations(), annotation];
  await saveAnnotations(currentPath, annotations);
  notifyAnnotationsChanged(annotations.length);
}

async function removeAnnotation(id) {
  if (!editor || !currentPath) return;

  // Remove the mark from the editor
  editor.commands.removeAnnotation(id);

  // Remove from store
  const remaining = await deleteAnnotation(currentPath, id);
  notifyAnnotationsChanged(remaining.length);
}

function notifyAnnotationsChanged(count) {
  if (onAnnotationsChanged) onAnnotationsChanged(count);
}

export { removeAnnotation };

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
