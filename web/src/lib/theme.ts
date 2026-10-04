// The look has two parts. Light or dark is the person's choice: inside a host
// it is the host's, read from the localStorage key the host names
// (Info.themeStorageKey); on its own Timeclock keeps one under its own key.
// The colors are the workspace's or the host's theme (Info.theme), derived
// from a few values and laid over Timeclock's own, which is in the CSS.
import { deriveTheme, applyTheme as setTokens, THEME_TOKENS } from '@parallelworks/ui/theme';
import { type Mode, schemeFor, surfaces, type Theme } from '@/lib/theme-seeds';

const OWN_KEY = 'timeclock-theme';
// The host's key, and the theme, remembered from the last load so the page
// is right before the first request answers.
const HOST_KEY_CACHE = 'timeclock-theme-host-key';
const THEME_CACHE = 'timeclock-theme-seeds';

export type ThemePreference = 'light' | 'dark' | 'system';

const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked: follow the system
  }
}

function put(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage blocked: it lasts until reload
  }
}

function storageKey(): string {
  return get(HOST_KEY_CACHE) || OWN_KEY;
}

function cachedTheme(): Theme {
  try {
    return JSON.parse(get(THEME_CACHE) ?? '{}') as Theme;
  } catch {
    return {};
  }
}

let theme: Theme = cachedTheme();
// While an admin edits the theme, the page shows the draft, in the mode being edited.
let preview: { theme: Theme; mode: Mode } | null = null;

export function readPreference(): ThemePreference {
  const v = get(storageKey());
  return v === 'light' || v === 'dark' ? v : 'system';
}

/** Light or dark, as the page now shows. */
export function currentMode(): Mode {
  if (preview) return preview.mode;
  const p = readPreference();
  return p === 'dark' || (p === 'system' && media.matches) ? 'dark' : 'light';
}

const hasScheme = (t: Theme, mode: Mode) => !!t[mode]?.interface?.accent;

/** Puts the look on <html>: the .dark class, color-scheme, and the theme's colors. */
export function applyTheme() {
  const mode = currentMode();
  const root = document.documentElement;
  root.classList.toggle('dark', mode === 'dark');
  root.style.colorScheme = mode;
  const active = preview?.theme ?? theme;
  if (hasScheme(active, mode)) {
    setTokens(root, deriveTheme(surfaces(schemeFor(active, mode), mode)));
  } else {
    // Timeclock's own colors are in the stylesheet.
    for (const token of THEME_TOKENS) root.style.removeProperty(token);
  }
  for (const listener of listeners) listener();
}

/** Calls `listener` whenever the look changes; returns how to stop. */
export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Remembers where the host keeps its choice, and applies it. */
export function adoptHostTheme(key: string | undefined) {
  put(HOST_KEY_CACHE, key || null);
  applyTheme();
}

/** Sets the workspace's or host's theme, as the server gave it. */
export function setTheme(next: Theme | undefined) {
  theme = next ?? {};
  put(THEME_CACHE, hasScheme(theme, 'light') || hasScheme(theme, 'dark') ? JSON.stringify(theme) : null);
  applyTheme();
}

/** Shows a draft theme in one mode without saving it; null goes back. */
export function previewTheme(draft: { theme: Theme; mode: Mode } | null) {
  preview = draft;
  applyTheme();
}

/** Sets the person's light, dark or system choice. */
export function setPreference(p: ThemePreference) {
  put(storageKey(), p);
  applyTheme();
}

media.addEventListener('change', applyTheme);
// Another tab, or the host's own pages, changed the choice.
window.addEventListener('storage', () => {
  theme = cachedTheme();
  applyTheme();
});
