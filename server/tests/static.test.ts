/**
 * static.test.ts — раздача собранного интерфейса тем же сервером (server/index.ts).
 *
 * Проверяем: /api/health жив при включённой статике; GET / отдаёт index.html без
 * кэша; SPA-фолбэк для путей без расширения и 404 для путей с расширением; MIME и
 * длинный кэш ассетов; главное — обход пути (/..%2f…, /%2e%2e…, /../, симлинк
 * наружу) НЕ отдаёт файлы за пределами корня статики; без собранного dist сервер
 * поднимается и API отвечает.
 *
 * Все тесты работают на временном каталоге с фиктивным index.html — реальная
 * сборка (npm run build) не нужна. STATIC_DIR читается на момент createServerApp,
 * поэтому env восстанавливается сразу после создания сервера.
 */
import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createServerApp } from "../index.ts";

const INDEX_HTML = "<!doctype html><meta charset=utf-8><title>PROMETEY_INDEX</title>";
const SECRET = "TOP_SECRET_VALUE_DO_NOT_SERVE";

/** Фиктивный «dist» + секрет рядом (ВНЕ корня) — для проверки обхода пути. */
function fakeSite(): { root: string; dist: string } {
  const root = mkdtempSync(join(tmpdir(), "prometey-site-"));
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), INDEX_HTML);
  writeFileSync(join(dist, "assets", "app-abc123.js"), "console.log('APP')");
  writeFileSync(join(root, "secret.txt"), SECRET);
  return { root, dist };
}

async function withServer(staticDir: string, fn: (base: string) => Promise<void>): Promise<void> {
  const prev = process.env.STATIC_DIR;
  process.env.STATIC_DIR = staticDir;
  const server: Server = createServerApp(); // читает STATIC_DIR здесь и сейчас
  if (prev === undefined) delete process.env.STATIC_DIR;
  else process.env.STATIC_DIR = prev;

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections?.(); // не ждём keep-alive от fetch
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("статика: /api/health отвечает при включённой статике", async () => {
  const { root, dist } = fakeSite();
  try {
    await withServer(dist, async (base) => {
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).ok, true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("статика: GET / и HEAD / отдают index.html без кэша", async () => {
  const { root, dist } = fakeSite();
  try {
    await withServer(dist, async (base) => {
      const res = await fetch(`${base}/`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
      assert.equal(res.headers.get("cache-control"), "no-cache");
      assert.match(await res.text(), /PROMETEY_INDEX/);

      const head = await fetch(`${base}/`, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.ok(Number(head.headers.get("content-length")) > 0);
      assert.equal(await head.text(), "");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("статика: SPA-фолбэк без расширения, 404 с расширением, MIME и кэш ассетов", async () => {
  const { root, dist } = fakeSite();
  try {
    await withServer(dist, async (base) => {
      // /positions — неизвестный путь без расширения → index.html
      const spa = await fetch(`${base}/positions`);
      assert.equal(spa.status, 200);
      assert.match(spa.headers.get("content-type") ?? "", /text\/html/);
      assert.match(await spa.text(), /PROMETEY_INDEX/);

      // /nope.js — путь с расширением и без файла → 404, а не index.html
      assert.equal((await fetch(`${base}/nope.js`)).status, 404);

      // Хэшированный ассет: js-MIME и длинный кэш
      const asset = await fetch(`${base}/assets/app-abc123.js`);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get("content-type") ?? "", /javascript/);
      assert.match(asset.headers.get("cache-control") ?? "", /max-age=31536000/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("статика: обход пути и симлинк наружу не отдают файлы вне корня", async () => {
  const { root, dist } = fakeSite();
  try {
    await withServer(dist, async (base) => {
      // Симлинк внутри dist, ведущий наружу: realpath должен отсечь.
      symlinkSync(join(root, "secret.txt"), join(dist, "leak.txt"));

      const attacks = [
        "/..%2fsecret.txt",
        "/%2e%2e%2fsecret.txt",
        "/../secret.txt",
        "/..%2f..%2f..%2fetc%2fpasswd",
        "/static/..%2f..%2fsecret.txt",
        "/leak.txt",
      ];
      for (const p of attacks) {
        const res = await fetch(`${base}${p}`);
        const text = await res.text();
        assert.notEqual(res.status, 200, `${p} не должен отдаваться со статусом 200`);
        assert.ok(!text.includes(SECRET), `${p} не должен раскрывать содержимое файла вне корня`);
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("статика: без собранного dist сервер поднимается и API отвечает", async () => {
  const missing = join(tmpdir(), `prometey-nodist-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await withServer(missing, async (base) => {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    // Статики нет — неизвестный путь остаётся 404, как раньше.
    assert.equal((await fetch(`${base}/positions`)).status, 404);
  });
});
