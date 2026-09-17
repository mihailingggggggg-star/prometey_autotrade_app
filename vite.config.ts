import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * base — подкаталог GitHub Pages: страница живёт по адресу
 * https://<аккаунт>.github.io/<репозиторий>/, и без него все пути к ассетам
 * ведут в корень домена, то есть в 404. Имя вынесено в переменную: переедет
 * репозиторий — правится одно место, а не конфиг сборки.
 */
export default defineConfig({
  base: process.env.VITE_BASE || "/prometey_autotrade/",
  plugins: [react(), tailwindcss()],
  server: { port: 5178, host: true },
});
