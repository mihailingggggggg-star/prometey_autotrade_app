/**
 * scripts/dev.mjs — поднимает одной командой и сервер демо-контура, и Vite.
 *
 * Зачем: демо-контур живёт из двух процессов (данные на сервере, интерфейс в
 * браузере), и запускать их двумя терминалами — лишний повод забыть сервер и
 * потом полчаса искать, почему лента пустая. Порт занят — сервер сам об этом
 * скажет, а Vite продолжит работать и покажет ошибку связи.
 */
import { spawn } from "node:child_process";

const procs = [];
function run(name, cmd, args) {
  const p = spawn(cmd, args, { stdio: "inherit", env: process.env });
  procs.push(p);
  p.on("exit", (code) => {
    // Упал один — гасим второй, иначе останется висеть в фоне и займёт порт.
    if (code !== 0 && code !== null) {
      console.error(`[dev] ${name} завершился с кодом ${code} — останавливаю остальных`);
      shutdown(code);
    }
  });
  return p;
}

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("server", process.execPath, ["server/index.ts"]);
run("vite", "npx", ["vite", "--host"]);
