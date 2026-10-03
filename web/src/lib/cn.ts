import { type ClassValue, clsx } from 'clsx';

/** Joins class names, skipping falsy ones. */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}
