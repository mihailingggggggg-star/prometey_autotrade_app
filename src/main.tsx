import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import { App } from "./App";

/**
 * Точка входа — и только она.
 *
 * Прежняя цепочка `bootApi()` → `initTelegram()` → `mount()` убрана вместе с
 * фьючерсным контуром: демо-контур Solana — обычное веб-приложение без
 * Telegram, а адрес API берётся из api.ts (localStorage `solana.api` или
 * текущий origin через прокси Vite). Поднимать нечего — сразу рендер.
 */

/**
 * Рамка телефона на широком экране (см. `html.desk` в theme.css). Внутри
 * реального телефона её нет никогда: там окно и так шириной с устройство, а
 * рамка съела бы полезную высоту. Порог 520px — по нему же проходит граница
 * «это уже не телефон».
 */
function frame() {
  document.documentElement.classList.toggle("desk", window.innerWidth >= 520);
}
frame();
window.addEventListener("resize", frame);

const host = document.getElementById("root");
if (!host) throw new Error("не найден #root — проверьте index.html");

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
