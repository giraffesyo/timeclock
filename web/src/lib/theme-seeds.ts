// A whole look comes from a few values: for light and for dark, an accent, a
// background and a contrast, and optionally the same for the sidebar.
// @parallelworks/ui derives every color from them. This file has no browser
// code: the build uses it for the default theme's CSS, and the app at runtime.
import {
  contrastRatio,
  deriveTheme,
  isDarkColor,
  type SurfaceSeeds,
  type ThemeSeed,
  type ThemeVariables,
} from '@parallelworks/ui/theme';

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
/** A color some of the way toward another, as CSS's color-mix in srgb. */
function mix(from: string, to: string, amount: number): string {
  const part = (i: number) =>
    Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * amount)
      .toString(16)
      .padStart(2, '0');
  return `#${part(0)}${part(1)}${part(2)}`;
}
/** A color some of the way toward black. */
const shade = (hex: string, amount: number) => mix(hex, '#000000', amount);

/**
 * How much of the sidebar's accent washes the current section's item; the
 * shell's CSS (--sidebar-wash in index.css) uses the same.
 */
const SIDEBAR_WASH = 0.14;

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

/**
 * Every color of a scheme: @parallelworks/ui's, and the sidebar's accent,
 * which marks the current section. The accent is moved toward black or white
 * until it stands out from its wash, as the library does for links.
 */
export type Look = ThemeVariables & { '--sidebar-accent': string };

const washOf = (vars: ThemeVariables, accent: string) => mix(vars['--theme-bg'], accent, SIDEBAR_WASH);

export function look(scheme: Scheme, mode: Mode): Look {
  const seeds = surfaces(scheme, mode);
  const vars = deriveTheme(seeds);
  const accent = seeds.sidebar?.accent ?? seeds.interface.accent;
  const pole = isDarkColor(vars['--theme-bg']) ? '#ffffff' : '#000000';
  let marked = accent;
  for (let t = 0.05; t <= 1 && contrastRatio(marked, washOf(vars, marked)) < 3; t += 0.05) {
    marked = mix(accent, pole, t);
  }
  return { ...vars, '--sidebar-accent': marked };
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

const name = (token: string) => token.replace('--theme-', '');

/**
 * The text pairs of a look that fall below 4.5:1, as "token on token
 * (ratio)", the current section's among them.
 */
export function contrastFailures(vars: Look): string[] {
  const pairs = [
    ...textPairs.map(([fg, bg]) => ({ fg: name(fg), bg: name(bg), ratio: contrastRatio(vars[fg], vars[bg]) })),
    {
      fg: name('--theme-sidebar-text'),
      bg: 'sidebar-wash',
      ratio: contrastRatio(vars['--theme-sidebar-text'], washOf(vars, vars['--sidebar-accent'])),
    },
  ];
  return pairs.filter((p) => p.ratio < 4.5).map((p) => `${p.fg} on ${p.bg} (${p.ratio.toFixed(1)}:1)`);
}
