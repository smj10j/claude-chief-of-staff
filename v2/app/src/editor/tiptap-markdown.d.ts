// tiptap-markdown 0.9 ships without an augmentation, so the Storage key isn't
// typed. Declare it ourselves — we only touch getMarkdown().

import "@tiptap/core";

declare module "@tiptap/core" {
  interface Storage {
    markdown?: {
      getMarkdown(): string;
    };
  }
}
