import { fileURLToPath } from 'node:url';
import { i18n } from '@parallelworks/i18n/vite';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { noInlineStyles, noInlineStylesDeps } from './vite-csp.ts';
import { timeclockTheme } from './vite-theme.ts';

// The Go server is the one address in development too: it proxies the app
// from this dev server (TIMECLOCK_VITE_URL) until it embeds a build.
// Where the Go server listens in development (make dev).
const server = process.env.TIMECLOCK_SERVER_URL ?? 'http://localhost:8090';

export default defineConfig(({ command }) => ({
  // Relative asset URLs resolve against the <base href> the server injects,
  // so one build serves at / or under a host's path.
  base: './',
  plugins: [
    noInlineStyles(),
    // Must come before react(). Generates src/routeTree.gen.ts from src/routes/.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    timeclockTheme(),
    i18n({ dir: 'src/i18n/locales', defaultLocale: 'en' }),
  ],
  optimizeDeps: {
    rolldownOptions: { plugins: [noInlineStylesDeps] },
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // The Go server's development CSP accepts this nonce (spa.DevNonce), which
  // Vite puts on the scripts and styles it injects.
  ...(command === 'serve' && { html: { cspNonce: 'vite-dev' } }),
  server: {
    port: 5174,
    strictPort: true,
    // This address works too: the API and sign-in are passed on to the Go
    // server. Only the Go server's address applies its CSP, so develop there.
    proxy: {
      '/api': server,
      '/auth': server,
    },
  },
  build: {
    outDir: 'dist',
    // Only content-hashed output lives here, so the server caches it forever.
    assetsDir: '_build',
    emptyOutDir: true,
  },
}));
