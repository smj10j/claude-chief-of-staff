/**
 * Lightweight, read-only markdown renderer for Console transcript text
 * blocks.
 *
 * Replaces the per-message Tiptap `MarkdownView`, which spun up a full
 * ProseMirror editor instance for *every* assistant text block. A large
 * conversation meant dozens of editors mounted at once, which is what
 * made the Console surface slow to open and switch to. `react-markdown`
 * renders straight to React nodes (no editor, no raw HTML — HTML in the
 * source is escaped, not executed), and the component is wrapped in
 * `React.memo` so an unchanged block is never re-rendered while the rest
 * of the conversation streams.
 *
 * Link behavior mirrors `MarkdownView`: external links open in the
 * browser; content-tree links dispatch `cos:open-doc`. Cmd/Ctrl/middle
 * -click carries an `intent` so the target opens in a new tab (shared
 * with the in-surface cmd-click support).
 */
import { memo, type MouseEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";

import { ensureDocPath } from "../../editor/linkOpen";
import { intentFromEvent } from "../../state/tabs";

function handleLink(
  e: MouseEvent<HTMLAnchorElement>,
  href: string | undefined,
): void {
  // auxclick fires for every non-primary button; only middle-click
  // (button 1 ≡ open-in-background) should route a link.
  if (e.type === "auxclick" && e.button !== 1) return;
  if (!href) return;
  e.preventDefault();
  if (/^https?:\/\//i.test(href)) {
    openUrl(href).catch(() => {
      navigator.clipboard?.writeText(href).catch(() => {});
    });
    return;
  }
  const resolved = href.replace(/^\//, "");
  if (!resolved) return;
  const final = ensureDocPath(resolved);
  const label = final.split("/").pop()?.replace(/\.md$/, "") ?? final;
  window.dispatchEvent(
    new CustomEvent("cos:open-doc", {
      detail: { relPath: final, label, intent: intentFromEvent(e) },
    }),
  );
}

export const ChatMarkdown = memo(function ChatMarkdown({
  markdown,
}: {
  markdown: string;
}) {
  return (
    <div className="cos-chat-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => handleLink(e, href)}
              onAuxClick={(e) => handleLink(e, href)}
            >
              {children}
            </a>
          ),
        }}
      >
        {markdown}
      </Markdown>
    </div>
  );
});
