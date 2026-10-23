import { memo, useEffect, useMemo, useRef } from "react";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import { openUrl } from "@tauri-apps/plugin-opener";

import "../../editor/editor.css";
import { ensureDocPath } from "../../editor/linkOpen";
import { intentFromEvent } from "../../state/tabs";

/**
 * Read-only markdown renderer for chat transcript messages.
 *
 * Replaces the per-message Tiptap `MarkdownView`: a long conversation
 * was spinning up one full ProseMirror editor per assistant text block,
 * which dominated Console mount time (O(messages) editor instances).
 * markdown-it → HTML is ~two orders of magnitude cheaper and visually
 * identical — `tiptap-markdown` renders through the same markdown-it
 * under the hood, and chat messages never used syntax highlighting or
 * an editable surface. We render into `ProseMirror cos-markdown-view`
 * for the shared base styling; note the doc-editor's block-spacing rules
 * are scoped under `.cos-tiptap` and do NOT reach here — the tight
 * paragraph/heading/list margins live in the `.cos-markdown-view` rules
 * in App.css (see the block-spacing comment there).
 *
 * Safety: `html: false` makes markdown-it escape any raw HTML in the
 * assistant's output (so an injected `<script>` renders as text), and
 * markdown-it's default `validateLink` already blocks `javascript:` /
 * `vbscript:` / unsafe `data:` hrefs — so `dangerouslySetInnerHTML` here
 * only ever receives markdown-it's own safe tag set.
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
}).use(taskLists, { label: true });

export const ChatMarkdown = memo(function ChatMarkdown({
  markdown,
}: {
  markdown: string;
}) {
  const html = useMemo(() => md.render(markdown), [markdown]);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Route link clicks like MarkdownView did: external http(s) opens in
  // the system browser; everything else is treated as a content-tree
  // path and dispatched through the cos:open-doc bus (Cmd/Ctrl/middle
  // -click carries an intent so the target opens in a new tab). Bound
  // to the wrapper, not per-anchor, so it survives HTML re-renders.
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
      if (/^https?:\/\//i.test(href)) {
        openUrl(href).catch(() => {
          navigator.clipboard?.writeText(href).catch(() => {});
        });
        return;
      }
      const final = ensureDocPath(href.replace(/^\//, ""));
      const label = final.split("/").pop()?.replace(/\.md$/, "") ?? final;
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
  }, []);

  return (
    <div
      ref={containerRef}
      className="ProseMirror cos-markdown-view"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
