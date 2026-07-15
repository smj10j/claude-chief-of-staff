import { useEffect, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "tiptap-markdown";
import { openUrl } from "@tauri-apps/plugin-opener";

import "../editor/editor.css";
import { resolveRelativePath } from "../editor/resolveRelativePath";
import { ensureDocPath } from "../editor/linkOpen";
import { intentFromEvent } from "../state/tabs";

/**
 * Read-only markdown renderer. Reuses the same Tiptap extension set
 * as the editor so rendering fidelity matches (lists, tasks, links,
 * code blocks). Kept separate from DocEditor so we don't inherit
 * autosave, audit, and dirty-tracking wiring we don't need here.
 */
export function MarkdownView({
  markdown,
  relPath,
}: {
  markdown: string;
  /** Path of the doc being rendered, used to resolve relative links
   *  against. When omitted, only absolute (content-root) and external
   *  links are clickable. */
  relPath?: string;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      // openOnClick:false so we can intercept and route through cos.
      Link.configure({ openOnClick: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ transformPastedText: false }),
    ],
    content: markdown,
    editable: false,
    editorProps: {
      attributes: {
        class: "ProseMirror cos-markdown-view",
      },
    },
  });

  // Syncing `content` when the prop changes. Tiptap doesn't react to
  // content prop updates on its own, so push via setContent.
  useEffect(() => {
    if (editor && editor.storage.markdown?.getMarkdown() !== markdown) {
      editor.commands.setContent(markdown, { emitUpdate: false });
    }
  }, [editor, markdown]);

  // Click routing — same flow as DocEditor's intra-app navigation.
  // Plain click in read mode is the natural way to follow a link, so
  // there's no cmd-modifier requirement here. External http(s) goes to
  // the browser via the Tauri opener; everything else is treated as a
  // content-tree path and dispatched through cos:open-doc.
  //
  // Listener attaches to a wrapper div, NOT `editor.view.dom`. Reading
  // `editor.view` before the editor is mounted logs a "[tiptap error]:
  // The editor view is not available" message + throws, which blanked
  // the entire surface (no error boundary). The wrapper ref is always
  // available once React has rendered the JSX below.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    function onClick(e: MouseEvent) {
      // auxclick fires for every non-primary button; only middle-click
      // (button 1 ≡ open-in-background) should route a link.
      if (e.type === "auxclick" && e.button !== 1) return;
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      e.preventDefault();
      const isExternal = /^https?:\/\//i.test(href);
      if (isExternal) {
        openUrl(href).catch(() => {
          navigator.clipboard?.writeText(href).catch(() => {});
        });
        return;
      }
      const normalized = href.replace(/^\//, "");
      const resolved =
        relPath && /^\.{1,2}\//.test(normalized)
          ? resolveRelativePath(relPath, normalized)
          : normalized;
      if (!resolved) return;
      const final = ensureDocPath(resolved);
      const label = final.split("/").pop()?.replace(/\.md$/, "") ?? final;
      // Cmd/Ctrl/middle-click opens the target in a new tab; a plain
      // click follows in place (read-mode default).
      window.dispatchEvent(
        new CustomEvent("cos:open-doc", {
          detail: { relPath: final, label, intent: intentFromEvent(e) },
        }),
      );
    }
    container.addEventListener("click", onClick);
    container.addEventListener("auxclick", onClick);
    return () => {
      container.removeEventListener("click", onClick);
      container.removeEventListener("auxclick", onClick);
    };
  }, [relPath]);

  if (!editor) return null;
  return (
    <div ref={containerRef}>
      <EditorContent editor={editor} />
    </div>
  );
}
