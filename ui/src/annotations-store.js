// Browser-side annotation store.
// Wraps the server API. Abstracted so the backing store can change
// (filesystem today, SQLite later) without touching client code.

let currentPath = null;
let currentAnnotations = [];

export async function loadAnnotations(docPath) {
  currentPath = docPath;
  const res = await fetch(`/api/annotations?path=${encodeURIComponent(docPath)}`);
  const data = await res.json();
  currentAnnotations = data.annotations || [];
  return currentAnnotations;
}

export async function saveAnnotations(docPath, annotations) {
  currentPath = docPath;
  currentAnnotations = annotations;
  const res = await fetch('/api/annotations', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: docPath, annotations }),
  });
  const data = await res.json();
  currentAnnotations = data.annotations || annotations;
  return currentAnnotations;
}

export async function deleteAnnotation(docPath, id) {
  const res = await fetch('/api/annotations', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: docPath, id }),
  });
  const data = await res.json();
  currentAnnotations = data.annotations || currentAnnotations.filter(a => a.id !== id);
  return currentAnnotations;
}

export function getAnnotations() {
  return currentAnnotations;
}

export function getCurrentAnnotationPath() {
  return currentPath;
}

export function findAnnotationById(id) {
  return currentAnnotations.find(a => a.id === id);
}

export function generateId() {
  return Math.random().toString(36).substring(2, 10);
}
