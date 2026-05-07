/**
 * HTML source instrumentation for live-preview ↔ source bidirectional
 * scroll sync.
 *
 * `instrumentHtmlForPreview(source)` returns the source with two changes:
 *
 *   1. Every opening tag gets a `data-cos-src-line="N"` attribute, where
 *      N is the 1-based source line of the `<` that opened the tag.
 *      Close tags, comments, doctype, and processing instructions are
 *      left alone.
 *
 *   2. A small bridge script is injected before `</body>` (or appended
 *      to the source if no closing body tag is present). The script:
 *        - On click, walks up from the deepest hit element to the
 *          nearest `data-cos-src-line` and posts the line back to the
 *          parent window.
 *        - On `cos-html-scroll-to-line` postMessage, scrolls the
 *          element with the largest line ≤ requested line into view.
 *
 * The instrumentation runs every time the preview re-renders (debounced
 * to ~200ms in HtmlEditor) and is O(n) over source size — well under
 * the layout budget for the strategy guide's ~50KB.
 *
 * The function is tolerant of malformed HTML: a stray `<` is copied
 * through, unmatched quotes don't break tokenization beyond the current
 * tag, and `<script>` / `<style>` bodies are treated as raw text so we
 * don't accidentally inject attributes into JS or CSS.
 */
export function instrumentHtmlForPreview(source: string): string {
  return injectBridge(annotateOpeningTags(source));
}

const BODY_CLOSE_RE = /<\/body\s*>/i;
const SCRIPT_CLOSE_RE = /<\/script\s*>/i;
const STYLE_CLOSE_RE = /<\/style\s*>/i;

type ParserState = {
  source: string;
  out: string[];
  i: number;
  line: number;
};

function annotateOpeningTags(source: string): string {
  const s: ParserState = { source, out: [], i: 0, line: 1 };
  const n = source.length;

  while (s.i < n) {
    const c = source[s.i];

    if (c === "\n") {
      s.out.push("\n");
      s.line++;
      s.i++;
      continue;
    }

    if (c !== "<") {
      s.out.push(c);
      s.i++;
      continue;
    }

    const next = source[s.i + 1];

    // `<!-- ... -->` comment — copy through.
    if (source.startsWith("<!--", s.i)) {
      const end = source.indexOf("-->", s.i + 4);
      copyThrough(s, end < 0 ? n : end + 3);
      continue;
    }

    // `<!DOCTYPE` / CDATA / etc — copy to next `>`.
    if (next === "!") {
      const end = source.indexOf(">", s.i);
      copyThrough(s, end < 0 ? n : end + 1);
      continue;
    }

    // `<? ... ?>` processing instruction.
    if (next === "?") {
      const end = source.indexOf("?>", s.i);
      copyThrough(s, end < 0 ? n : end + 2);
      continue;
    }

    // `</...>` close tag — copy through, no instrumentation.
    if (next === "/") {
      const end = source.indexOf(">", s.i);
      copyThrough(s, end < 0 ? n : end + 1);
      continue;
    }

    // Stray `<` (unfollowed by a tag-name start char). Emit and move on.
    if (!next || !isTagNameStart(next)) {
      s.out.push("<");
      s.i++;
      continue;
    }

    // ── opening tag ────────────────────────────────────────────────
    const tagStartLine = s.line;
    let j = s.i + 1;
    while (j < n && isTagNameChar(source[j])) j++;
    const tagName = source.slice(s.i + 1, j);
    s.out.push("<", tagName, ` data-cos-src-line="${tagStartLine}"`);
    s.i = j;

    // Copy the rest of the opening tag, respecting quotes so a `>`
    // inside an attribute value doesn't terminate early.
    let inQuote: '"' | "'" | "" = "";
    while (s.i < n) {
      const ch = source[s.i];
      if (ch === "\n") s.line++;
      s.out.push(ch);
      if (inQuote) {
        if (ch === inQuote) inQuote = "";
      } else if (ch === '"' || ch === "'") {
        inQuote = ch;
      } else if (ch === ">") {
        s.i++;
        break;
      }
      s.i++;
    }

    // Raw-text elements: contents of <script> and <style> aren't HTML.
    // Copy through to the matching close tag without tokenizing.
    const lower = tagName.toLowerCase();
    if (lower === "script" || lower === "style") {
      const closeRe = lower === "script" ? SCRIPT_CLOSE_RE : STYLE_CLOSE_RE;
      const rest = source.slice(s.i);
      const m = closeRe.exec(rest);
      const stop = m ? s.i + m.index : n;
      copyThrough(s, stop);
    }
  }

  return s.out.join("");
}

/** Copy source[s.i .. stop) onto the output array, advancing line
 *  count over any embedded newlines. Mutates `s` in place. */
function copyThrough(s: ParserState, stop: number): void {
  const chunk = s.source.slice(s.i, stop);
  s.out.push(chunk);
  for (let k = 0; k < chunk.length; k++) {
    if (chunk.charCodeAt(k) === 10) s.line++;
  }
  s.i = stop;
}

function isTagNameStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function isTagNameChar(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "-" ||
    ch === ":"
  );
}

/** Bridge script injected into the iframe. Kept minimal and not using
 *  ES modules so it works in any sandbox=allow-scripts iframe. The
 *  flash style is its own injected <style> rather than inline-style
 *  mutation so we don't stomp on the user's element styles, and is
 *  scoped behind `.cos-flash` so the user's CSS rules can win on
 *  collision (we use highly specific properties — outline + box-
 *  shadow + animation — that are unlikely to fight typical layout). */
const BRIDGE_SCRIPT = `<script>(function(){
  var sty = document.createElement('style');
  sty.textContent = '@keyframes cosFlash{0%{box-shadow:0 0 0 4px rgba(99,102,241,.55)}100%{box-shadow:0 0 0 4px rgba(99,102,241,0)}}.cos-flash{outline:2px solid rgba(99,102,241,.9);outline-offset:2px;animation:cosFlash 1.2s ease-out;border-radius:3px}';
  (document.head || document.documentElement).appendChild(sty);
  var flashed = null, flashTimer = 0;
  function flash(el){
    if(!el) return;
    if(flashed && flashed !== el) flashed.classList.remove('cos-flash');
    if(flashTimer) clearTimeout(flashTimer);
    flashed = el;
    el.classList.add('cos-flash');
    flashTimer = setTimeout(function(){ el.classList.remove('cos-flash'); flashed = null; }, 1200);
  }
  function findLine(el){
    while(el && el !== document.documentElement){
      var L = el.getAttribute && el.getAttribute('data-cos-src-line');
      if(L) return parseInt(L,10);
      el = el.parentElement;
    }
    return null;
  }
  document.addEventListener('click', function(e){
    var line = findLine(e.target);
    if(line != null){
      try { parent.postMessage({type:'cos-html-click', line:line}, '*'); } catch(_){}
    }
  }, true);
  window.addEventListener('message', function(e){
    if(!e.data || e.data.type !== 'cos-html-scroll-to-line') return;
    var target = e.data.line;
    var nodes = document.querySelectorAll('[data-cos-src-line]');
    var best = null, bestLine = -1;
    for(var i=0; i<nodes.length; i++){
      var L = parseInt(nodes[i].getAttribute('data-cos-src-line'),10);
      if(L <= target && L > bestLine){ bestLine = L; best = nodes[i]; }
    }
    if(best){ best.scrollIntoView({behavior:'smooth', block:'center'}); flash(best); }
  });
})();</script>`;

function injectBridge(html: string): string {
  const m = BODY_CLOSE_RE.exec(html);
  if (m) {
    return html.slice(0, m.index) + BRIDGE_SCRIPT + html.slice(m.index);
  }
  return html + BRIDGE_SCRIPT;
}
