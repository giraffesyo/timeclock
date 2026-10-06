import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/integrations')({
  beforeLoad: () => {
    throw redirect({ to: '/settings', search: { tab: 'integrations' }, replace: true });
  },
});
