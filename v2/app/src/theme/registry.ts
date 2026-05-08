/**
 * Theme registry — PRD-v2-115 §7.8.
 *
 * Each theme is a single CSS file binding semantic tokens to a palette.
 * Adding a new theme is a new entry here + a new CSS import in main.tsx.
 * Tokens themselves (spacing, type scale, motion) are theme-agnostic and
 * live in tokens.css.
 *
 * The picker in Settings → Appearance reads this list. Selection
 * persists to localStorage under THEME_STORAGE_KEY.
 */

export type ThemeMood = "dark" | "light" | "playful" | "serious" | "calming" | "accessibility";

export type ThemeDef = {
  id: string;
  /** Display name shown in the picker. */
  label: string;
  /** Short one-line description for tooltips and the picker. */
  description: string;
  /** light / dark for system-default matching. */
  scheme: "light" | "dark";
  /** Mood category — drives picker grouping if we add it later. */
  mood: ThemeMood;
};

export const THEMES: ThemeDef[] = [
  {
    id: "graphite",
    label: "Graphite",
    description: "Default dark — focused, professional",
    scheme: "dark",
    mood: "dark",
  },
  {
    id: "midnight",
    label: "Midnight",
    description: "Calm dark — Loona-inspired, lavender on deep navy-violet",
    scheme: "dark",
    mood: "calming",
  },
  {
    id: "paper",
    label: "Paper",
    description: "Default light — editorial, ivory, terra-cotta",
    scheme: "light",
    mood: "light",
  },
  {
    id: "coral",
    label: "Coral",
    description: "Bold light — vibrant coral, deep navy, saturated teal",
    scheme: "light",
    mood: "playful",
  },
  {
    id: "linen",
    label: "Linen",
    description: "Softened light — dusty beige + paprika + indigo + olive",
    scheme: "light",
    mood: "light",
  },
  {
    id: "mist",
    label: "Mist",
    description: "Sea-glass light — soft blue-green canvas, vivid teal accent",
    scheme: "light",
    mood: "calming",
  },
  {
    id: "parchment",
    label: "Parchment",
    description: "Warm tan light — aged-paper khaki, walnut accent",
    scheme: "light",
    mood: "serious",
  },
  {
    id: "terminal",
    label: "Terminal",
    description: "High-contrast dark — phosphor green on true black",
    scheme: "dark",
    mood: "playful",
  },
  {
    id: "sunrise",
    label: "Sunrise",
    description: "Warm light — cream, dawn, gold",
    scheme: "light",
    mood: "playful",
  },
  {
    id: "slate",
    label: "Slate",
    description: "Cool dark — navy, low-saturation, corporate-neutral",
    scheme: "dark",
    mood: "serious",
  },
  {
    id: "calm",
    label: "Calm",
    description: "Sage + muted teal — low-stim, meditative",
    scheme: "dark",
    mood: "calming",
  },
  {
    id: "daltonic",
    label: "Daltonic",
    description: "Color-blind safe — blue/orange/yellow only, shape-paired",
    scheme: "dark",
    mood: "accessibility",
  },
];

export const DEFAULT_THEME_ID = "graphite";
export const THEME_STORAGE_KEY = "cos.theme.v1";

/* Text-scale multiplier — applied to every font-size token in tokens.css */
/* via calc(). Slider in Settings → Appearance writes this value. */
export const TEXT_SCALE_STORAGE_KEY = "cos.text-scale.v1";
export const DEFAULT_TEXT_SCALE = 1;
export const MIN_TEXT_SCALE = 0.85;
export const MAX_TEXT_SCALE = 1.3;
export const TEXT_SCALE_STEP = 0.05;

/** Read the persisted theme id, or fall back to the default. Safe to
 *  call before React mount so the index.html flash-of-wrong-theme
 *  is avoided. */
export function readTheme(): string {
  if (typeof window === "undefined") return DEFAULT_THEME_ID;
  try {
    const id = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (id && THEMES.some((t) => t.id === id)) return id;
  } catch {
    // ignore
  }
  return DEFAULT_THEME_ID;
}

export function writeTheme(id: string): void {
  if (typeof window === "undefined") return;
  if (!THEMES.some((t) => t.id === id)) return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // ignore — quota / private mode
  }
}

export function applyTheme(id: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = id;
}

/** Read the persisted text-scale multiplier; clamps to the safe range. */
export function readTextScale(): number {
  if (typeof window === "undefined") return DEFAULT_TEXT_SCALE;
  try {
    const raw = window.localStorage.getItem(TEXT_SCALE_STORAGE_KEY);
    if (!raw) return DEFAULT_TEXT_SCALE;
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) return DEFAULT_TEXT_SCALE;
    return clampTextScale(value);
  } catch {
    return DEFAULT_TEXT_SCALE;
  }
}

export function writeTextScale(value: number): void {
  if (typeof window === "undefined") return;
  const clamped = clampTextScale(value);
  try {
    window.localStorage.setItem(TEXT_SCALE_STORAGE_KEY, String(clamped));
  } catch {
    // ignore — quota / private mode
  }
}

/** Apply the multiplier as `--cos-text-scale` on documentElement so every
 *  font-size token in tokens.css picks it up via calc(). */
export function applyTextScale(value: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    "--cos-text-scale",
    String(clampTextScale(value)),
  );
}

export function clampTextScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TEXT_SCALE;
  if (value < MIN_TEXT_SCALE) return MIN_TEXT_SCALE;
  if (value > MAX_TEXT_SCALE) return MAX_TEXT_SCALE;
  // Snap to the nearest step so the slider reads cleanly.
  return Math.round(value / TEXT_SCALE_STEP) * TEXT_SCALE_STEP;
}

// ===== B7-CP27: custom accent color override ===============================

const ACCENT_OVERRIDE_KEY = "cos.accent-override.v1";
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Validate a hex color string. Accepts #rgb and #rrggbb (case-
 *  insensitive). Returns the lowercased canonical form when valid;
 *  null when not. */
export function normalizeAccentHex(input: string): string | null {
  const trimmed = input.trim();
  if (!HEX_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/** Read the user's accent override (or null when unset / invalid). */
export function readAccentOverride(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACCENT_OVERRIDE_KEY);
    if (!raw) return null;
    return normalizeAccentHex(raw);
  } catch {
    return null;
  }
}

/** Persist the user's accent override (or remove when null). */
export function writeAccentOverride(hex: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (hex === null) {
      window.localStorage.removeItem(ACCENT_OVERRIDE_KEY);
    } else {
      const normalized = normalizeAccentHex(hex);
      if (normalized) {
        window.localStorage.setItem(ACCENT_OVERRIDE_KEY, normalized);
      }
    }
  } catch {
    // ignore — quota / private mode
  }
}

/** Apply (or clear) the override on documentElement so any rule
 *  using --cos-accent picks it up. Pure DOM mutation; no read of
 *  localStorage so the bootstrap path can call this with whatever
 *  value it just read once. */
export function applyAccentOverride(hex: string | null): void {
  if (typeof document === "undefined") return;
  if (hex === null) {
    document.documentElement.style.removeProperty("--cos-accent");
  } else {
    const normalized = normalizeAccentHex(hex);
    if (normalized) {
      document.documentElement.style.setProperty(
        "--cos-accent",
        normalized,
      );
    }
  }
}
