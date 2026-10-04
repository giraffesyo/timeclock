// A whole look comes from a few values: for light and for dark, an accent, a
// background and a contrast, and optionally the same for the sidebar.
// @parallelworks/ui derives every color from them. This file has no browser
// code: the build uses it for the default theme's CSS, and the app at runtime.
import { contrastRatio, type SurfaceSeeds, type ThemeSeed, type ThemeVariables } from '@parallelworks/ui/theme';

export type Mode = 'light' | 'dark';

/** A look in one mode: the page's seed, and the sidebar's when it has its own. */
export interface Scheme {
  interface: ThemeSeed;
  sidebar?: ThemeSeed;
}

/** A look for light and for dark. A missing scheme is Timeclock's own. */
export interface Theme {
  light?: Scheme;
  dark?: Scheme;
}

/** Timeclock's own look: indigo on white beside a cool gray sidebar, and the same on near-black. */
export const DEFAULT_THEME: Required<Theme> = {
  light: {
    interface: { accent: '#4b50d9', background: '#ffffff' },
    sidebar: { accent: '#4b50d9', background: '#f3f4f7' },
  },
  dark: {
    interface: { accent: '#7c83f7', background: '#17181d' },
    sidebar: { accent: '#7c83f7', background: '#0e0f13' },
  },
};

/** Whether a scheme was given: the API sends a scheme with empty colors for none. */
const given = (s?: Scheme): s is Scheme => !!s?.interface?.accent && !!s.interface.background;

const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
/** A color some of the way toward black. */
function shade(hex: string, amount: number): string {
  const part = (i: number) =>
    Math.round(channel(hex, i) * (1 - amount))
      .toString(16)
      .padStart(2, '0');
  return `#${part(0)}${part(1)}${part(2)}`;
}

/** The scheme a theme has for a mode, or Timeclock's own. */
export function schemeFor(theme: Theme | undefined, mode: Mode): Scheme {
  const scheme = theme?.[mode];
  return given(scheme) ? scheme : DEFAULT_THEME[mode];
}

/**
 * What a scheme is derived from. Without a sidebar of its own, the sidebar is
 * the page's background a little deeper, so the page still reads as a sheet
 * laid on it.
 */
export function surfaces(scheme: Scheme, mode: Mode): SurfaceSeeds {
  const sidebar = scheme.sidebar?.background
    ? scheme.sidebar
    : { ...scheme.interface, background: shade(scheme.interface.background, mode === 'dark' ? 0.4 : 0.045) };
  return { interface: scheme.interface, sidebar };
}

// Text pairs that must stay WCAG AA.
const textPairs: [keyof ThemeVariables, keyof ThemeVariables][] = [
  ['--theme-app', '--theme-app-bg'],
  ['--theme-panel', '--theme-panel-bg'],
  ['--theme-muted-text-color', '--theme-app-bg'],
  ['--theme-muted-text-color', '--theme-panel-bg'],
  ['--theme-muted-text-color', '--theme-hover'],
  ['--theme-accent-text', '--theme-accent'],
  ['--theme-element-text', '--theme-element'],
  ['--theme-link', '--theme-panel-bg'],
  ['--theme-sidebar-text', '--theme-bg'],
];

/** The text pairs of a derived theme that fall below 4.5:1, as "token on token (ratio)". */
export function contrastFailures(vars: ThemeVariables): string[] {
  return textPairs
    .map(([fg, bg]) => ({ fg, bg, ratio: contrastRatio(vars[fg], vars[bg]) }))
    .filter((p) => p.ratio < 4.5)
    .map((p) => `${p.fg.replace('--theme-', '')} on ${p.bg.replace('--theme-', '')} (${p.ratio.toFixed(1)}:1)`);
}
