// A whole look comes from a few values: for light and for dark, an accent, a
// background and a contrast, and optionally the same for the sidebar.
// @parallelworks/ui derives every color from them. This file has no browser
// code: the build uses it for the default theme's CSS, and the app at runtime.
import {
  contrastRatio,
  deriveTheme,
  isDarkColor,
  SIDEBAR_TOKENS,
  type ThemeVariables,
  type Scheme as UIScheme,
} from '@parallelworks/ui/theme';

export type Mode = 'light' | 'dark';

/** The few colors a surface is derived from, as a workspace stores them. */
export interface ThemeSeed {
  accent: string;
  background: string;
  /** How far text and borders sit from the background: 1 is normal, from 0.5 to 1.5. */
  contrast?: number;
}

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
/**
 * How much of the sidebar's text its muted text keeps, toward the sidebar's
 * background; the shell's CSS (--color-muted-foreground) uses the same.
 */
const SIDEBAR_MUTED = 0.66;

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
export function surfaces(scheme: Scheme, mode: Mode): Required<Scheme> {
  const sidebar = scheme.sidebar?.background
    ? scheme.sidebar
    : { ...scheme.interface, background: shade(scheme.interface.background, mode === 'dark' ? 0.4 : 0.045) };
  return { interface: scheme.interface, sidebar };
}

/**
 * A stored contrast on the library's scale, 0 to 100 with 30 its normal:
 * 0.5 is the least, 1 normal, and 1.5 the most.
 */
const scaled = (contrast: number) =>
  Math.round(contrast <= 1 ? (Math.max(contrast, 0.5) - 0.5) * 60 : 30 + (Math.min(contrast, 1.5) - 1) * 140);

/** A seed as @parallelworks/ui takes one: the background is its base. */
const seeded = (seed: ThemeSeed): UIScheme => ({
  interface: {
    base: seed.background,
    accent: seed.accent,
    contrast: seed.contrast ? scaled(seed.contrast) : undefined,
  },
});

/**
 * Every token of a scheme. The library's sidebar takes only a background and
 * an accent, so the sidebar's tokens come from its own seed, contrast and all,
 * as the page's would.
 */
function derive({ interface: page, sidebar }: Required<Scheme>): ThemeVariables {
  const vars = deriveTheme(seeded(page));
  const side = deriveTheme({
    ...seeded(sidebar),
    sidebar: { base: sidebar.background, accent: sidebar.accent },
  });
  for (const token of SIDEBAR_TOKENS) vars[token] = side[token];
  return vars;
}

/**
 * Every color of a scheme: @parallelworks/ui's, and the sidebar's accent,
 * which marks the current section. The accent is moved toward black or white
 * until it stands out from its wash, as the library does for links.
 */
export type Look = ThemeVariables & { '--sidebar-accent': string };

const washOf = (vars: ThemeVariables, accent: string) => mix(vars['--theme-sidebar-bg'], accent, SIDEBAR_WASH);
const sidebarMuted = (vars: ThemeVariables) =>
  mix(vars['--theme-sidebar-bg'], vars['--theme-sidebar-text'], SIDEBAR_MUTED);

export function look(scheme: Scheme, mode: Mode): Look {
  const seeds = surfaces(scheme, mode);
  const vars = derive(seeds);
  const accent = seeds.sidebar.accent;
  const pole = isDarkColor(vars['--theme-sidebar-bg']) ? '#ffffff' : '#000000';
  let marked = accent;
  for (let t = 0.05; t <= 1 && contrastRatio(marked, washOf(vars, marked)) < 3; t += 0.05) {
    marked = mix(accent, pole, t);
  }
  return { ...vars, '--sidebar-accent': marked };
}

// Text pairs that must stay WCAG AA.
const textPairs: [keyof ThemeVariables, keyof ThemeVariables][] = [
  ['--theme-app', '--theme-app-bg'],
  ['--theme-app', '--theme-panel-bg'],
  ['--theme-muted-text-color', '--theme-app-bg'],
  ['--theme-muted-text-color', '--theme-panel-bg'],
  ['--theme-muted-text-color', '--theme-hover'],
  ['--theme-accent-text', '--theme-accent'],
  ['--theme-link', '--theme-panel-bg'],
  ['--theme-sidebar-text', '--theme-sidebar-bg'],
];

const name = (token: string) => token.replace('--theme-', '');

/**
 * The text pairs of a look that fall below 4.5:1, as "token on token
 * (ratio)", the sidebar's muted text and the current section's among them.
 */
export function contrastFailures(vars: Look): string[] {
  const pairs = [
    ...textPairs.map(([fg, bg]) => ({ fg: name(fg), bg: name(bg), ratio: contrastRatio(vars[fg], vars[bg]) })),
    {
      fg: name('--theme-sidebar-text'),
      bg: 'sidebar-wash',
      ratio: contrastRatio(vars['--theme-sidebar-text'], washOf(vars, vars['--sidebar-accent'])),
    },
    {
      fg: 'sidebar-muted',
      bg: name('--theme-sidebar-bg'),
      ratio: contrastRatio(sidebarMuted(vars), vars['--theme-sidebar-bg']),
    },
  ];
  return pairs.filter((p) => p.ratio < 4.5).map((p) => `${p.fg} on ${p.bg} (${p.ratio.toFixed(1)}:1)`);
}
