// markdown-it-task-lists ships no types. We only use it as a plugin
// passed to markdown-it's `.use()`, so a minimal PluginWithOptions
// declaration is enough.
declare module "markdown-it-task-lists" {
  import type { PluginWithOptions } from "markdown-it";
  const taskLists: PluginWithOptions<{
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  }>;
  export default taskLists;
}
