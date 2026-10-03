import { createContext, useContext } from 'react';
import type { Me } from '@/lib/queries';

const SessionContext = createContext<Me | null>(null);

export const SessionProvider = SessionContext.Provider;

/** The caller, how payroll runs, and their running clock. The shell loads it before any page renders. */
export function useSession(): Me {
  const me = useContext(SessionContext);
  if (!me) throw new Error('useSession outside the shell');
  return me;
}
