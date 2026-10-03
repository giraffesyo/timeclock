// The app follows the person's light, dark or system choice. Inside a host
// that choice is the host's, read from the localStorage key the host names
// (Info.themeStorageKey); on its own Timeclock keeps one under its own key.

const OWN_KEY = 'timeclock-theme';
// The host's key, remembered from the last load so the theme is right before
// the first request answers.
const HOST_KEY_CACHE = 'timeclock-theme-host-key';

export type ThemePreference = 'light' | 'dark' | 'system';

const media = window.matchMedia('(prefers-color-scheme: dark)');

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked: follow the system
  }
}

function storageKey(): string {
  return get(HOST_KEY_CACHE) || OWN_KEY;
}

export function readPreference(): ThemePreference {
  const v = get(storageKey());
  return v === 'light' || v === 'dark' ? v : 'system';
}

/** Puts the preference on <html>: the .dark class and color-scheme. */
export function applyTheme() {
  const p = readPreference();
  const dark = p === 'dark' || (p === 'system' && media.matches);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
}

/** Remembers where the host keeps its choice, and applies it. */
export function adoptHostTheme(key: string | undefined) {
  try {
    if (key) localStorage.setItem(HOST_KEY_CACHE, key);
    else localStorage.removeItem(HOST_KEY_CACHE);
  } catch {
    // storage blocked: nothing to remember
  }
  applyTheme();
}

/** Sets Timeclock's own choice, when no host owns it. */
export function setPreference(p: ThemePreference) {
  try {
    localStorage.setItem(storageKey(), p);
  } catch {
    // storage blocked: the choice lasts until reload
  }
  applyTheme();
}

media.addEventListener('change', applyTheme);
// Another tab, or the host's own pages, changed the choice.
window.addEventListener('storage', applyTheme);
