import type { Plugin } from 'vite';

// react-tooltip injects its CSS as <style> elements at runtime, which the
// server's CSP (no inline styles) refuses. main.tsx imports its stylesheet
// instead, and this turns the injection off. A library upgrade that changes
// the injection fails the build here rather than shipping unstyled tooltips.
const patches: { file: RegExp; from: string; to: string }[] = [
  {
    file: /\/react-tooltip\/dist\/react-tooltip\.min\.mjs$/,
    from: '"undefined"!=typeof process&&process.env&&process.env.REACT_TOOLTIP_DISABLE_CORE_STYLES',
    to: 'true',
  },
  {
    file: /\/react-tooltip\/dist\/react-tooltip\.min\.mjs$/,
    from: '"undefined"!=typeof process&&process.env&&process.env.REACT_TOOLTIP_DISABLE_BASE_STYLES',
    to: 'true',
  },
];

function transform(code: string, id: string) {
  const path = id.split('?')[0] ?? id;
  const applicable = patches.filter((p) => p.file.test(path));
  if (applicable.length === 0) return null;
  let out = code;
  for (const p of applicable) {
    if (!out.includes(p.from)) {
      throw new Error(`no-inline-styles: ${path} no longer contains ${JSON.stringify(p.from)}; update vite-csp.ts`);
    }
    out = out.replace(p.from, p.to);
  }
  return { code: out, map: null };
}

/** Turns off react-tooltip's runtime style injection. */
export function noInlineStyles(): Plugin {
  return { name: 'no-inline-styles', enforce: 'pre', transform };
}

/** The same, for Vite's dependency pre-bundling in development. */
export const noInlineStylesDeps = { name: 'no-inline-styles', transform };
