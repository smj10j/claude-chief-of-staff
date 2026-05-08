# Example plugin

Reference template. The `manifest.toml` next to this README declares the minimum
shape the plugin runtime expects today (B7-CP21/CP22).

## What's here

- `manifest.toml` — name + version + description + a sample capabilities list.
  See the comments inside for the field reference.

## What's not here yet

Everything else. The loader, the host hooks, the actual extension entry point —
all of those land in subsequent PRD-104 checkpoints. Today the runtime only
reads the manifest and surfaces it in **Settings → Plugins** so users can see
what a plugin will need before it runs.

## How to use this as a starter

1. Open **Settings → Plugins → open folder** in the app to reveal the
   per-user plugin directory.
2. Copy this directory there (rename `example` to your plugin's slug).
3. Edit `manifest.toml` — set `name`, `version`, and the `capabilities`
   you'll actually use.
4. Hit **refresh** in the Plugins panel; the row should appear with your
   declared capabilities as chips.

If a chip shows in the warning tone, the runtime doesn't recognize that
capability — either it's a typo or it's a forward-looking string for a
loader feature that hasn't landed yet.
