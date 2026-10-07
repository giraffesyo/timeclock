import type { Plugin } from 'vite';
import { contrastFailures, DEFAULT_THEME, look, type Mode } from './src/lib/theme-seeds.ts';

const id = 'virtual:timeclock-theme.css';
const resolved = `\0${id}`;

// Timeclock's own theme, as CSS, so the page is right before any script
// runs. A workspace's or a host's theme is applied over it at runtime
// (src/lib/theme.ts). A default that isn't WCAG AA fails the build.
function block(mode: Mode): string {
  const vars = look(DEFAULT_THEME[mode], mode);
  const failures = contrastFailures(vars);
  if (failures.length > 0) {
    throw new Error(`timeclock theme (${mode}) is below 4.5:1: ${failures.join(', ')}`);
  }
  return Object.entries(vars)
    .map(([token, value]) => `  ${token}: ${value};`)
    .join('\n');
}

/**
 * Serves `virtual:timeclock-theme.css`: the --theme-* tokens for light, and
 * for dark under the .dark class lib/theme.ts puts on <html>.
 */
export function timeclockTheme(): Plugin {
  return {
    name: 'timeclock-theme',
    resolveId: (source) => (source === id ? resolved : undefined),
    load(loadId) {
      if (loadId !== resolved) return;
      return [`:root {\n${block('light')}\n}`, `:root.dark {\n${block('dark')}\n}`].join('\n');
    },
  };
}
