import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import { App } from "./App";
import { AppProvider } from "./lib/store";
import { Boom } from "./ui/Boom";
import { inTelegram, initTelegram } from "./lib/tg";

initTelegram();

/**
 * Рамка телефона на широком экране. Внутри Telegram её нет никогда: там окно и
 * так шириной с устройство, а рамка съела бы полезную высоту.
 * Порог 520px — по нему же проходит граница «это уже не телефон».
 */
function frame() {
  const desk = !inTelegram && window.innerWidth >= 520;
  document.documentElement.classList.toggle("desk", desk);
}
frame();
window.addEventListener("resize", frame);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boom>
      <AppProvider>
        <App />
      </AppProvider>
    </Boom>
  </StrictMode>
);
