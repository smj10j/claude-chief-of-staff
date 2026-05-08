// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { BlockMarkdown, InlineMarkdown } from "./inlineMarkdown";

describe("InlineMarkdown", () => {
  it("renders plain text untouched", () => {
    const { container } = render(<InlineMarkdown text="just plain words" />);
    expect(container.textContent).toBe("just plain words");
  });

  it("renders **bold** as <strong>", () => {
    const { container } = render(<InlineMarkdown text="hello **world**" />);
    expect(container.querySelector("strong")?.textContent).toBe("world");
    expect(container.textContent).toBe("hello world");
  });

  it("renders *italic* as <em>", () => {
    const { container } = render(<InlineMarkdown text="hello *there*" />);
    expect(container.querySelector("em")?.textContent).toBe("there");
  });

  it("renders `code` as <code>", () => {
    const { container } = render(<InlineMarkdown text="run `cos status`" />);
    expect(container.querySelector("code")?.textContent).toBe("cos status");
  });

  it("collapses [title](url) to title only", () => {
    const { container } = render(
      <InlineMarkdown text="see [the docs](https://example.com)" />,
    );
    expect(container.textContent).toBe("see the docs");
    expect(container.querySelector("a")).toBeNull();
  });

  it("handles unmatched markers as plain text", () => {
    const { container } = render(<InlineMarkdown text="unmatched **bold" />);
    expect(container.textContent).toBe("unmatched **bold");
  });
});

describe("BlockMarkdown", () => {
  it("returns null for empty text", () => {
    const { container } = render(<BlockMarkdown text="" />);
    expect(container.querySelector(".cos-block-md")).toBeNull();
  });

  it("groups adjacent bullet lines into a single <ul>", () => {
    const { container } = render(
      <BlockMarkdown text={`- one\n- two\n- three`} />,
    );
    const lists = container.querySelectorAll("ul");
    expect(lists.length).toBe(1);
    expect(lists[0].querySelectorAll("li").length).toBe(3);
  });

  it("groups adjacent numbered lines into a single <ol>", () => {
    const { container } = render(
      <BlockMarkdown text={`1. first\n2. second`} />,
    );
    const lists = container.querySelectorAll("ol");
    expect(lists.length).toBe(1);
    expect(lists[0].querySelectorAll("li").length).toBe(2);
  });

  it("breaks list grouping on a blank line between items", () => {
    const { container } = render(
      <BlockMarkdown text={`- one\n- two\n\n- three`} />,
    );
    expect(container.querySelectorAll("ul").length).toBe(2);
  });

  it("renders headings with descending levels", () => {
    const { container } = render(
      <BlockMarkdown text={`# h1\n## h2\n### h3`} />,
    );
    expect(container.querySelector(".cos-block-md-h1")?.textContent).toBe("h1");
    expect(container.querySelector(".cos-block-md-h2")?.textContent).toBe("h2");
    expect(container.querySelector(".cos-block-md-h3")?.textContent).toBe("h3");
  });

  it("renders paragraphs and runs each through InlineMarkdown", () => {
    const { container } = render(
      <BlockMarkdown text={`This is **bold** and *italic*.`} />,
    );
    const p = container.querySelector("p");
    expect(p?.querySelector("strong")?.textContent).toBe("bold");
    expect(p?.querySelector("em")?.textContent).toBe("italic");
  });

  it("flushes the open list before a heading or paragraph", () => {
    const { container } = render(
      <BlockMarkdown text={`- one\n- two\n# heading\n- three`} />,
    );
    // Two ul groups (one before the heading, one after) and one h.
    expect(container.querySelectorAll("ul").length).toBe(2);
    expect(container.querySelectorAll(".cos-block-md-h1").length).toBe(1);
  });
});
