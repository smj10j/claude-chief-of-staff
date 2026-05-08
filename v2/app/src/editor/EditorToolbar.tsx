import { useEffect, useRef, useState } from "react";
import { type Editor } from "@tiptap/react";

const TOOLBAR_DENSITY_KEY = "cos.toolbar-density.v1";

export type ToolbarDensity = "comfortable" | "compact";

export function readToolbarDensity(): ToolbarDensity {
  if (typeof window === "undefined") return "comfortable";
  try {
    const v = window.localStorage.getItem(TOOLBAR_DENSITY_KEY);
    return v === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

export function writeToolbarDensity(value: ToolbarDensity): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOOLBAR_DENSITY_KEY, value);
  } catch {
    // ignore
  }
}

/**
 * Sticky toolbar above the editor body. Same shape as the v1 bubble
 * menu (toolbar.js), but always-visible rather than selection-bound —
 * v2's editor is a full-page surface, so the bubble menu's "save
 * vertical space" advantage doesn't pay off, and the always-visible
 * version is easier to discover.
 *
 * Each button toggles the corresponding Tiptap mark/node and reflects
 * its active state via `editor.isActive`. We rerender on every
 * selection update so the active states track the cursor.
 */
export function EditorToolbar({
  editor,
  onEditLink,
}: {
  editor: Editor | null;
  /** Called when the toolbar's link button is clicked. The caller
   *  owns the dialog UI; we pass the current selection (so the dialog
   *  can apply the link to the right span even if the editor blurs)
   *  plus the existing href / display text when editing. */
  onEditLink?: (snapshot: {
    from: number;
    to: number;
    initialHref: string;
    initialText: string;
    hasSelection: boolean;
    onLink: boolean;
  }) => void;
}) {
  const [, force] = useState(0);
  const [density, setDensity] = useState<ToolbarDensity>(() =>
    readToolbarDensity(),
  );

  // Tiptap mutations are not React state, so the active states won't
  // refresh on their own. Listen to selectionUpdate + transaction for a
  // forced rerender. Throttling could be useful on huge docs, but the
  // current toolbar is cheap enough that updating per-tx is fine.
  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => force((n) => n + 1);
    editor.on("selectionUpdate", onUpdate);
    editor.on("transaction", onUpdate);
    return () => {
      editor.off("selectionUpdate", onUpdate);
      editor.off("transaction", onUpdate);
    };
  }, [editor]);

  // Subscribe to a window event so flipping the density from Settings
  // updates every mounted editor without a remount.
  useEffect(() => {
    function onChange() {
      setDensity(readToolbarDensity());
    }
    window.addEventListener("cos:toolbar-density-changed", onChange);
    return () =>
      window.removeEventListener("cos:toolbar-density-changed", onChange);
  }, []);

  if (!editor) return null;

  const action =
    (fn: () => boolean | void): React.MouseEventHandler<HTMLButtonElement> =>
    (e) => {
      // Use mousedown instead of click so the editor doesn't lose its
      // selection between focus events. preventDefault keeps the editor
      // from blurring; the toggle still runs synchronously.
      e.preventDefault();
      fn();
    };

  const openLinkDialog = () => {
    if (!onEditLink) return;
    // Snapshot the selection BEFORE the dialog opens. ProseMirror
    // collapses the selection when focus leaves the editor, so we
    // can't trust state.selection at commit time — pass it through.
    const { from, to } = editor.state.selection;
    const onLink = editor.isActive("link");
    let snapHref = editor.getAttributes("link").href ?? "";
    let snapFrom = from;
    let snapTo = to;
    let snapText = "";
    // If the cursor is inside an existing link mark, expand the
    // snapshot to cover the whole link span so editing replaces the
    // entire URL (matching the v1 behavior of extendMarkRange).
    if (onLink) {
      const linkRange = findLinkRange(editor, from);
      if (linkRange) {
        snapFrom = linkRange.from;
        snapTo = linkRange.to;
        snapHref = linkRange.href;
        snapText = editor.state.doc.textBetween(snapFrom, snapTo);
      }
    } else if (from !== to) {
      snapText = editor.state.doc.textBetween(from, to);
    }
    onEditLink({
      from: snapFrom,
      to: snapTo,
      initialHref: snapHref,
      initialText: snapText,
      hasSelection: snapFrom !== snapTo,
      onLink,
    });
  };

  const insertTable = () => {
    editor
      .chain()
      .focus()
      .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
      .run();
  };

  return (
    <div
      className={`cos-editor-toolbar cos-editor-toolbar-${density}`}
      role="toolbar"
      aria-label="Editor formatting"
      // Stop the editor from losing focus when clicking the toolbar
      // surface itself (the buttons handle their own preventDefault on
      // mousedown, but a stray click on the gap shouldn't blur).
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <ToolbarBtn
        label="↶"
        title="Undo (⌘Z)"
        disabled={!editor.can().undo()}
        onMouseDown={action(() => editor.chain().focus().undo().run())}
      />
      <ToolbarBtn
        label="↷"
        title="Redo (⌘⇧Z)"
        disabled={!editor.can().redo()}
        onMouseDown={action(() => editor.chain().focus().redo().run())}
      />
      <span className="cos-toolbar-sep" aria-hidden />
      <HeadingPicker editor={editor} action={action} />
      <span className="cos-toolbar-sep" aria-hidden />
      <ToolbarBtn
        label="B"
        title="Bold (⌘B)"
        active={editor.isActive("bold")}
        bold
        onMouseDown={action(() => editor.chain().focus().toggleBold().run())}
      />
      <ToolbarBtn
        label="I"
        title="Italic (⌘I)"
        active={editor.isActive("italic")}
        italic
        onMouseDown={action(() => editor.chain().focus().toggleItalic().run())}
      />
      <ToolbarBtn
        label="S"
        title="Strikethrough"
        active={editor.isActive("strike")}
        strike
        onMouseDown={action(() => editor.chain().focus().toggleStrike().run())}
      />
      <ToolbarBtn
        label="</>"
        title="Inline code"
        active={editor.isActive("code")}
        onMouseDown={action(() => editor.chain().focus().toggleCode().run())}
      />
      <span className="cos-toolbar-sep" aria-hidden />
      <ToolbarBtn
        label="•"
        title="Bullet list"
        active={editor.isActive("bulletList")}
        onMouseDown={action(() =>
          editor.chain().focus().toggleBulletList().run(),
        )}
      />
      <ToolbarBtn
        label="1."
        title="Numbered list"
        active={editor.isActive("orderedList")}
        onMouseDown={action(() =>
          editor.chain().focus().toggleOrderedList().run(),
        )}
      />
      <ToolbarBtn
        label="☐"
        title="Task list"
        active={editor.isActive("taskList")}
        onMouseDown={action(() =>
          editor.chain().focus().toggleTaskList().run(),
        )}
      />
      <span className="cos-toolbar-sep" aria-hidden />
      <ToolbarBtn
        label="“"
        title="Quote"
        active={editor.isActive("blockquote")}
        onMouseDown={action(() =>
          editor.chain().focus().toggleBlockquote().run(),
        )}
      />
      <ToolbarBtn
        label="{ }"
        title="Code block"
        active={editor.isActive("codeBlock")}
        onMouseDown={action(() =>
          editor.chain().focus().toggleCodeBlock().run(),
        )}
      />
      <ToolbarBtn
        label="link"
        title="Link"
        active={editor.isActive("link")}
        onMouseDown={action(() => {
          openLinkDialog();
        })}
      />
      <span className="cos-toolbar-sep" aria-hidden />
      <ToolbarBtn
        label="table"
        title="Insert 3×3 table"
        onMouseDown={action(() => {
          insertTable();
        })}
      />
      <span className="cos-toolbar-sep" aria-hidden />
      <ToolbarBtn
        label="copy md"
        title="Copy entire doc as markdown to clipboard"
        onMouseDown={action(() => {
          // Use the markdown extension's serializer so what lands on
          // the clipboard matches what gets written to disk on save.
          const md = editor.storage.markdown?.getMarkdown() ?? "";
          if (typeof md === "string" && md.length > 0) {
            navigator.clipboard?.writeText(md).catch(() => {
              // No fallback path — clipboard denial in WKWebView
              // is a config issue, not something the user can fix
              // mid-flight.
            });
          }
        })}
      />
    </div>
  );
}

/**
 * Walk outward from `pos` to find the start + end of the link mark
 * that contains it. Returns null when the position isn't inside a
 * link. Used by the toolbar's link-edit flow so a partial-cursor
 * edit replaces the URL on the entire span.
 */
function findLinkRange(
  editor: Editor,
  pos: number,
): { from: number; to: number; href: string } | null {
  const linkType = editor.schema.marks.link;
  if (!linkType) return null;
  const $pos = editor.state.doc.resolve(pos);
  const mark = $pos.marks().find((m) => m.type === linkType);
  // Cursor at the very edge of a link mark resolves with no marks at
  // the boundary — fall back to checking the mark just before.
  const found = mark
    ? mark
    : pos > 0
      ? editor.state.doc
          .resolve(pos - 1)
          .marks()
          .find((m) => m.type === linkType)
      : undefined;
  if (!found) return null;
  // Walk outward in both directions while the same mark is present.
  let from = pos;
  let to = pos;
  const doc = editor.state.doc;
  while (from > 0) {
    const before = doc.resolve(from - 1);
    if (before.marks().some((m) => m.eq(found))) from--;
    else break;
  }
  while (to < doc.content.size) {
    const after = doc.resolve(to);
    if (after.marks().some((m) => m.eq(found))) to++;
    else break;
  }
  const href = (found.attrs.href as string | undefined) ?? "";
  return { from, to, href };
}

export { findLinkRange };

function HeadingPicker({
  editor,
  action,
}: {
  editor: Editor;
  action: (
    fn: () => boolean | void,
  ) => React.MouseEventHandler<HTMLButtonElement>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const current = (() => {
    for (const level of [1, 2, 3] as const) {
      if (editor.isActive("heading", { level })) return `H${level}`;
    }
    return "¶";
  })();

  return (
    <div className="cos-toolbar-headingpicker" ref={ref}>
      <button
        type="button"
        className={`cos-toolbar-btn cos-toolbar-headingpicker-btn${
          current !== "¶" ? " is-active" : ""
        }`}
        title="Heading level"
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
      >
        {current} ▾
      </button>
      {open && (
        <div className="cos-toolbar-headingpicker-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className={`cos-toolbar-headingpicker-item${
              current === "¶" ? " is-active" : ""
            }`}
            onMouseDown={action(() => {
              setOpen(false);
              editor.chain().focus().setParagraph().run();
            })}
          >
            ¶ Paragraph
          </button>
          {[1, 2, 3].map((level) => (
            <button
              key={level}
              type="button"
              role="menuitem"
              className={`cos-toolbar-headingpicker-item${
                editor.isActive("heading", { level }) ? " is-active" : ""
              }`}
              onMouseDown={action(() => {
                setOpen(false);
                editor
                  .chain()
                  .focus()
                  .toggleHeading({ level: level as 1 | 2 | 3 })
                  .run();
              })}
            >
              {`H${level} Heading ${level}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolbarBtn({
  label,
  title,
  active,
  bold,
  italic,
  strike,
  disabled,
  onMouseDown,
}: {
  label: string;
  title?: string;
  active?: boolean;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  disabled?: boolean;
  onMouseDown: React.MouseEventHandler<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      className={`cos-toolbar-btn ${active ? "is-active" : ""}`}
      title={title ?? label}
      disabled={disabled}
      onMouseDown={onMouseDown}
      style={{
        fontWeight: bold ? 600 : undefined,
        fontStyle: italic ? "italic" : undefined,
        textDecoration: strike ? "line-through" : undefined,
      }}
    >
      {label}
    </button>
  );
}
