import { createFileRoute, redirect } from '@tanstack/react-router';

/** History became a Reports tab: old links still land on it. */
export const Route = createFileRoute('/history')({
  beforeLoad: () => {
    throw redirect({ to: '/reports', search: { tab: 'history' }, replace: true });
  },
});
