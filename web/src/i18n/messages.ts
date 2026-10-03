import type en from './locales/en';

export type Messages = typeof en;

declare module 'use-intl' {
  interface AppConfig {
    Messages: Messages;
  }
}
