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
 * Рамка телефона на широком экране (см. `html.desk` в theme.css).
 *
 * Признак не только ширина: `pointer: coarse` означает палец. Телефон в
 * альбомной ориентации шире 520px, и по одной ширине он попадал в «настольную»
 * рамку — рамка отнимала полезную высоту у настоящего устройства и выглядела
 * как чужой интерфейс. Рамка нужна ровно на настольном экране с мышью.
 */
function frame() {
  const finger = window.matchMedia("(pointer: coarse)").matches;
  document.documentElement.classList.toggle("desk", window.innerWidth >= 520 && !finger);
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
