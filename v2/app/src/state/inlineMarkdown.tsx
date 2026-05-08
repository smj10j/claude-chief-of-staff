import { type ReactNode } from "react";

/**
 * Tiny inline-markdown renderer for short user-facing strings — task
 * notes, priority cards, etc. Handles `**bold**`, `*italic*`,
 * `` `code` ``, and `[title](url)`. Markdown links collapse to just
 * the title (clicking the parent surface usually owns navigation).
 *
 * Pure component — not a markdown spec implementation. If a string
 * needs full block markdown it should use a Tiptap-based view
 * instead.
 */
export function InlineMarkdown({ text }: { text: string }) {
  type Pattern = {
    regex: RegExp;
    render: (m: RegExpExecArray, key: string) => ReactNode;
  };
  const patterns: Pattern[] = [
    {
      regex: /\[([^\]]+)\]\(([^)]+)\)/y,
      render: (m, key) => <span key={key}>{m[1]}</span>,
    },
    {
      regex: /\*\*([^*]+)\*\*/y,
      render: (m, key) => <strong key={key}>{m[1]}</strong>,
    },
    {
      regex: /`([^`]+)`/y,
      render: (m, key) => <code key={key}>{m[1]}</code>,
    },
    {
      regex: /\*([^*\s][^*]*[^*\s]|[^*\s])\*/y,
      render: (m, key) => <em key={key}>{m[1]}</em>,
    },
  ];

  const out: ReactNode[] = [];
  let buf = "";
  let i = 0;
  while (i < text.length) {
    let matched = false;
    for (const p of patterns) {
      p.regex.lastIndex = i;
      const m = p.regex.exec(text);
      if (m && m.index === i) {
        if (buf) {
          out.push(buf);
          buf = "";
        }
        out.push(p.render(m, `md-${i}`));
        i = p.regex.lastIndex;
        matched = true;
        break;
      }
    }
    if (!matched) {
      buf += text[i];
      i++;
    }
  }
  if (buf) out.push(buf);
  return <>{out}</>;
}

/**
 * Block-aware lightweight markdown renderer. Walks line-by-line and
 * groups adjacent bullet / numbered-list lines into <ul>/<ol>; treats
 * leading `#` as a heading; otherwise paragraph. Each text run goes
 * through InlineMarkdown for emphasis / links / inline code.
 *
 * Intended for short user-authored notes (task notes, briefing
 * bullets) where loading Tiptap would be overkill. Anything more
 * structured (tables, code fences, blockquotes inside a list) should
 * use the full editor view instead.
 */
export function BlockMarkdown({ text }: { text: string }) {
  if (!text || text.trim().length === 0) return null;
  const lines = text.split(/\r?\n/);
  const out: ReactNode[] = [];
  let buffer: { kind: "ul" | "ol"; items: string[] } | null = null;

  function flushList() {
    if (!buffer) return;
    const Tag = buffer.kind;
    out.push(
      <Tag key={`list-${out.length}`} className="cos-block-md-list">
        {buffer.items.map((item, idx) => (
          <li key={idx}>
            <InlineMarkdown text={item} />
          </li>
        ))}
      </Tag>,
    );
    buffer = null;
  }

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim().length === 0) {
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushList();
      const level = heading[1].length as 1 | 2 | 3;
      const HeadingTag = (
        ["h3", "h4", "h5"] as const
      )[level - 1]; // start at h3 so notes nest cleanly under page chrome
      out.push(
        <HeadingTag
          key={`h-${out.length}`}
          className={`cos-block-md-h${level}`}
        >
          <InlineMarkdown text={heading[2]} />
        </HeadingTag>,
      );
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!buffer || buffer.kind !== "ul") {
        flushList();
        buffer = { kind: "ul", items: [] };
      }
      buffer.items.push(bullet[1]);
      continue;
    }
    const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (ordered) {
      if (!buffer || buffer.kind !== "ol") {
        flushList();
        buffer = { kind: "ol", items: [] };
      }
      buffer.items.push(ordered[1]);
      continue;
    }
    flushList();
    out.push(
      <p key={`p-${out.length}`} className="cos-block-md-p">
        <InlineMarkdown text={line} />
      </p>,
    );
  }
  flushList();
  return <div className="cos-block-md">{out}</div>;
}
