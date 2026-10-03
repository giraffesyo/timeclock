// Imported first by main.tsx, so the theme is on <html> before React paints.
// A module rather than an inline script, which the CSP doesn't allow.
import { applyTheme } from '@/lib/theme';

applyTheme();
