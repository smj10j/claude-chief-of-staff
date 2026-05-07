// Undo round-trip artifacts that tiptap-markdown + prosemirror-markdown add on
// serialize. Two sources:
//
//   1. tiptap-markdown's Text node calls `escapeHTML` on every text node, which
//      turns `<` and `>` into `&lt;` / `&gt;` (and leaves `&` alone, producing
//      stray `&amp;` when users type literal `&`). This is a library bug —
//      it has no reason to HTML-encode markdown text.
//   2. prosemirror-markdown's default `esc()` escapes `~ [ ] * _` and at line
//      start also `# - >` as a precaution, regardless of whether the char
//      actually triggers markdown syntax. In practice these escapes are
//      unnecessary noise in prose.
//
// We cannot easily override #1 (the Text extension is baked into tiptap-markdown's
// bundle) and overriding #2 is risky. Post-processing is simpler and exact.
//
// Fenced code blocks are left untouched.

const FENCE_RE = /^\s*```/;

export function sanitizeMarkdown(input: string): string {
  const lines = input.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    out.push(
      line
        .replace(/&gt;/g, ">")
        .replace(/&lt;/g, "<")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/\\([~[\]#*_-])/g, "$1"),
    );
  }
  return out.join("\n");
}
