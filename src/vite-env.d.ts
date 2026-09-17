/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Адрес API бота на случай сборки под фиксированный адрес. Обычно пусто:
   *  адрес приходит параметром ?api= от самого бота. */
  readonly VITE_API_BASE?: string;
  /** Отладочный ключ — только для локальной разработки. */
  readonly VITE_DEV_TOKEN?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv }

/** Отметка времени сборки, подставляется Vite. */
declare const __BUILD__: string;
