import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AppProvider } from "./lib/store";
import { Boom } from "./ui/Boom";

/** Отдельный модуль ровно затем, чтобы api.ts импортировался ПОСЛЕ того, как
 *  адрес бота найден (см. main.tsx). */
export function mount() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Boom>
        <AppProvider>
          <App />
        </AppProvider>
      </Boom>
    </StrictMode>
  );
}
