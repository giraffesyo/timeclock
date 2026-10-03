import type { Plugin } from 'vite';

// sonner and react-tooltip inject their CSS as <style> elements at runtime,
// which the server's CSP (no inline styles) refuses. main.tsx imports their
// stylesheets instead, and this turns the injection off. A library upgrade
// that changes the injection fails the build here rather than shipping
// unstyled toasts or tooltips.
const patches: { file: RegExp; from: string; to: string }[] = [
  {
    file: /\/sonner\/dist\/index\.mjs$/,
    from: '\n__insertCSS("',
    to: '\n(() => {})("',
  },
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

/** Turns off the runtime style injection of sonner and react-tooltip. */
export function noInlineStyles(): Plugin {
  return { name: 'no-inline-styles', enforce: 'pre', transform };
}

/** The same, for Vite's dependency pre-bundling in development. */
export const noInlineStylesDeps = { name: 'no-inline-styles', transform };
