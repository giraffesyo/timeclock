import './theme-init';
import './index.css';
import 'virtual:timeclock-theme.css';
// Their runtime style injection is off (vite-csp.ts); the CSP allows files.
import 'react-tooltip/dist/react-tooltip.css';
import 'sonner/dist/styles.css';
import { defaultLocale, defaultMessages, loadMessages, locales } from 'virtual:i18n';
import { detectLocale } from '@parallelworks/i18n';
import { LocaleProvider } from '@parallelworks/i18n/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n/messages';
import { basePath } from '@/lib/base';
import { routeTree } from './routeTree.gen';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: 1,
    },
  },
});

const router = createRouter({
  routeTree,
  basepath: basePath || '/',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

const locale = detectLocale(locales, { fallback: defaultLocale, injected: document.documentElement.lang });
const messages = locale === defaultLocale ? defaultMessages : await loadMessages(locale).catch(() => defaultMessages);

createRoot(root).render(
  <StrictMode>
    <LocaleProvider initial={{ locale, messages }} load={loadMessages} fallbackLocale={defaultLocale}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </LocaleProvider>
  </StrictMode>,
);
