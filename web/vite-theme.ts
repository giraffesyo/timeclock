import { contrastRatio, deriveTheme, type ThemeSeed, type ThemeVariables } from '@parallelworks/ui/theme';
import type { Plugin } from 'vite';

// Timeclock's theme on @parallelworks/ui's contract: an indigo accent over
// near-white and near-black.
const seeds: Record<'light' | 'dark', ThemeSeed> = {
  light: { accent: '#474fd4', background: '#f9fafc' },
  dark: { accent: '#727cf7', background: '#111218' },
};

const id = 'virtual:timeclock-theme.css';
const resolved = `\0${id}`;

// Text pairs that must stay WCAG AA. A seed change that breaks one fails the build.
const textPairs: [keyof ThemeVariables, keyof ThemeVariables][] = [
  ['--theme-app', '--theme-app-bg'],
  ['--theme-panel', '--theme-panel-bg'],
  ['--theme-muted-text-color', '--theme-app-bg'],
  ['--theme-muted-text-color', '--theme-panel-bg'],
  ['--theme-muted-text-color', '--theme-hover'],
  ['--theme-accent-text', '--theme-accent'],
  ['--theme-element-text', '--theme-element'],
  ['--theme-link', '--theme-panel-bg'],
];

function block(scheme: keyof typeof seeds): string {
  const vars = deriveTheme(seeds[scheme]);
  for (const [fg, bg] of textPairs) {
    const ratio = contrastRatio(vars[fg], vars[bg]);
    if (ratio < 4.5) {
      throw new Error(`timeclock theme (${scheme}): ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below 4.5:1`);
    }
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
