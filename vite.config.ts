import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * base — куда приложение публикуется.
 *
 * По умолчанию КОРЕНЬ: на сервере демо-контур отдаёт интерфейс сам, вместе с
 * API, и живёт в корне адреса. Подкаталог GitHub Pages задаётся переменной
 * сборки в workflow. Раньше здесь стоял подкаталог Pages по умолчанию, и это
 * дало ровно ту поломку, которую видно глазами: собранный index.html ссылался
 * на /prometey_autotrade_app/assets/…, сервер отдавал 404, JavaScript не
 * загружался — и человек видел чёрный экран без единого сообщения об ошибке.
 * Молчаливо неверный путь страшнее явной ошибки, поэтому подкаталог Pages
 * теперь НЕ значение по умолчанию, а то, что надо задать явно.
 */
const BUILD = new Date().toISOString().slice(0, 16).replace("T", " ");

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD) },
  base: process.env.VITE_BASE || "/",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5178,
    host: true,
    /* В разработке клиент ходит в собственный origin: Vite проксирует /api на
       локальный сервер демо-контура. Так нет ни CORS, ни адреса API в коде, и
       сборка одна и та же для локального запуска и для туннеля. */
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET || "http://127.0.0.1:8790",
        changeOrigin: true,
      },
    },
  },
});
