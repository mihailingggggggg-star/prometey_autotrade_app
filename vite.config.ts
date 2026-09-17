import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * base — подкаталог GitHub Pages: страница живёт по адресу
 * https://<аккаунт>.github.io/<репозиторий>/, и без него все пути к ассетам
 * ведут в корень домена, то есть в 404. Имя вынесено в переменную: переедет
 * репозиторий — правится одно место, а не конфиг сборки.
 */
/* Отметка сборки видна в кабинете. Без неё «у меня нет кнопки» неотличимо от
   «у меня открыта вчерашняя версия из кэша», а кэш вебвью Telegram живёт
   своей жизнью. */
const BUILD = new Date().toISOString().slice(0, 16).replace("T", " ");

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD) },
  base: process.env.VITE_BASE || "/prometey_autotrade_app/",
  plugins: [react(), tailwindcss()],
  server: { port: 5178, host: true },
});
