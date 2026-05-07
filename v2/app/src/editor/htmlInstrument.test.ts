import { describe, it, expect } from "vitest";

import { instrumentHtmlForPreview } from "./htmlInstrument";

describe("instrumentHtmlForPreview", () => {
  it("annotates opening tags with their 1-based source line", () => {
    const src = `<div>\n<p>x</p>\n<span>y</span>`;
    const out = instrumentHtmlForPreview(src);
    expect(out).toContain(`<div data-cos-src-line="1"`);
    expect(out).toContain(`<p data-cos-src-line="2"`);
    expect(out).toContain(`<span data-cos-src-line="3"`);
  });

  it("does not annotate close tags, comments, or doctype", () => {
    const src = `<!DOCTYPE html>\n<!-- hello -->\n<div></div>`;
    const out = instrumentHtmlForPreview(src);
    // close tag stays bare
    expect(out).toContain(`</div>`);
    expect(out).not.toContain(`</div data-cos-src-line`);
    // doctype/comment unchanged
    expect(out).toContain(`<!DOCTYPE html>`);
    expect(out).toContain(`<!-- hello -->`);
  });

  it("treats <script> body as raw text", () => {
    const src = `<script>\nvar x = '<div>';\nif (a < b) {}\n</script>`;
    const out = instrumentHtmlForPreview(src);
    // <script> tag itself is annotated.
    expect(out).toContain(`<script data-cos-src-line="1"`);
    // The fake `<div>` inside the JS string must NOT be annotated.
    expect(out).not.toContain(`<div data-cos-src-line`);
  });

  it("treats <style> body as raw text", () => {
    const src = `<style>\n.x{}/* <div> */\n</style>`;
    const out = instrumentHtmlForPreview(src);
    expect(out).toContain(`<style data-cos-src-line="1"`);
    expect(out).not.toContain(`<div data-cos-src-line`);
  });

  it("respects quoted attribute values containing >", () => {
    const src = `<div title="a>b">x</div>`;
    const out = instrumentHtmlForPreview(src);
    // The full opening tag should remain intact, not truncated at the
    // `>` inside the title attribute.
    expect(out).toContain(`<div data-cos-src-line="1" title="a>b">`);
    expect(out).toContain(`x</div>`);
  });

  it("counts line numbers correctly across multi-line attribute values", () => {
    const src = `<div\n  class="a"\n  title="b">\n<p>after</p>`;
    const out = instrumentHtmlForPreview(src);
    expect(out).toContain(`<div data-cos-src-line="1"`);
    // <p> on line 4: line 1 = <div, lines 2-3 = continuation, line 4 = <p>
    expect(out).toContain(`<p data-cos-src-line="4"`);
  });

  it("injects the bridge script before </body> when present", () => {
    const src = `<html><body><p>x</p></body></html>`;
    const out = instrumentHtmlForPreview(src);
    const scriptIdx = out.indexOf("data-cos-src-line");
    const bridgeIdx = out.indexOf("cos-html-click");
    const closeBody = out.indexOf("</body>");
    expect(scriptIdx).toBeGreaterThanOrEqual(0);
    expect(bridgeIdx).toBeGreaterThanOrEqual(0);
    expect(closeBody).toBeGreaterThan(bridgeIdx);
  });

  it("appends the bridge script when no </body> is present", () => {
    const src = `<div>x</div>`;
    const out = instrumentHtmlForPreview(src);
    expect(out).toContain("cos-html-click");
    expect(out.endsWith("</script>")).toBe(true);
  });

  it("leaves a stray < intact and continues parsing", () => {
    const src = `if a < b then <div>ok</div>`;
    const out = instrumentHtmlForPreview(src);
    // The `< b` shouldn't break tokenization of the following <div>.
    expect(out).toContain(`if a < b then`);
    expect(out).toContain(`<div data-cos-src-line="1"`);
  });
});
