/**
 * Editor outline panel (CP15). Collapsible heading-tree above the
 * editor body — click a heading to scroll the matching node into
 * view. Pure UI; we walk the editor's doc on each render and use
 * ProseMirror selection + scrollIntoView to jump.
 *
 * Hidden when the doc has fewer than three headings — most session
 * notes don't need a TOC.
 */

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { Editor } from "@tiptap/react";

const PANEL_OPEN_KEY = "cos.outline-open.v1";

type Heading = {
  level: number;
  text: string;
  pos: number;
};

function listHeadings(editor: Editor | null): Heading[] {
  if (!editor) return [];
  const out: Heading[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      const level = (node.attrs.level as number | undefined) ?? 1;
      const text = node.textContent.trim();
      if (text.length > 0) out.push({ level, text, pos });
    }
  });
  return out;
}

export function OutlinePanel({ editor }: { editor: Editor | null }) {
  const [, force] = useState(0);
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(PANEL_OPEN_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => force((n) => n + 1);
    editor.on("update", onUpdate);
    editor.on("transaction", onUpdate);
    return () => {
      editor.off("update", onUpdate);
      editor.off("transaction", onUpdate);
    };
  }, [editor]);

  // Cmd+Shift+O toggles the outline panel from the keyboard. Only
  // fires when the editor is mounted; the outline component itself is
  // conditionally rendered above 3 headings, but the listener stays
  // bound — toggling on a doc with fewer headings is a no-op since
  // the panel doesn't render anyway.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !e.shiftKey) return;
      if (e.key.toLowerCase() !== "o") return;
      e.preventDefault();
      setOpen((v) => {
        const next = !v;
        try {
          window.localStorage.setItem(PANEL_OPEN_KEY, String(next));
        } catch {
          // ignore
        }
        return next;
      });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const headings = listHeadings(editor);
  if (headings.length < 3) return null;

  function toggle() {
    setOpen((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(PANEL_OPEN_KEY, String(next));
      } catch {
        // ignore quota / private mode
      }
      return next;
    });
  }

  function jump(h: Heading) {
    if (!editor) return;
    editor
      .chain()
      .focus()
      .setTextSelection({ from: h.pos + 1, to: h.pos + 1 })
      .scrollIntoView()
      .run();
  }

  return (
    <div className="cos-outline-panel">
      <button
        type="button"
        className="cos-outline-toggle"
        aria-expanded={open}
        onClick={toggle}
      >
        <ChevronRight
          size={12}
          strokeWidth={1.75}
          aria-hidden
          style={{
            transform: open ? "rotate(90deg)" : undefined,
            transition: "transform var(--cos-motion-quick) var(--cos-motion-ease)",
          }}
        />
        <span>Outline · {headings.length}</span>
      </button>
      {open && (
        <ul className="cos-outline-list">
          {headings.map((h, i) => (
            <li key={`${h.pos}-${i}`}>
              <button
                type="button"
                className="cos-outline-row"
                style={{ paddingLeft: 8 + (h.level - 1) * 14 }}
                onClick={() => jump(h)}
                title={h.text}
              >
                {h.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
