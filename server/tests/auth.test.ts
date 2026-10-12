/**
 * auth.test.ts — ключ доступа к API (server/index.ts).
 *
 * Проверяем ровно то, ради чего ключ перенесён с обратного прокси внутрь
 * приложения: при пустом API_TOKEN всё открыто как раньше; при заданном —
 * /api/* требуют заголовок X-Api-Token (неверный/отсутствующий → 401 с кодом
 * unauthorized), а статика и /api/health остаются открытыми, иначе ярлык PWA
 * получал бы 401 на HTML/иконку. Отдельно — секрет не утекает ни в ответы, ни
 * в перехваченный вывод.
 *
 * Окружение изолировано _setup.ts (временные DB_PATH/ENV_PATH). API_TOKEN
 * ставится и снимается вокруг каждого теста: он читается на каждый запрос, и
 * «утечка» значения сломала бы соседние тесты в общем процессе.
 */
import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createServerApp } from "../index.ts";

const TOKEN = "SECRET_API_TOKEN_do_not_leak_9f3a";
const OTHER = "WRONG_API_TOKEN_1111111111";

/** Фиктивный «dist»: только то, что нужно, чтобы отдать ярлыку статику. */
function fakeSite(): { root: string; dist: string } {
  const root = mkdtempSync(join(tmpdir(), "prometey-auth-"));
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>AUTH_INDEX</title>");
  writeFileSync(join(dist, "icon-192.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { root, dist };
}

async function withServer(staticDir: string, fn: (base: string) => Promise<void>): Promise<void> {
  const prev = process.env.STATIC_DIR;
  process.env.STATIC_DIR = staticDir;
  const server: Server = createServerApp();
  if (prev === undefined) delete process.env.STATIC_DIR;
  else process.env.STATIC_DIR = prev;

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** Поставить API_TOKEN на время теста и вернуть окружение как было. */
async function withToken(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.API_TOKEN;
  if (value === undefined) delete process.env.API_TOKEN;
  else process.env.API_TOKEN = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.API_TOKEN;
    else process.env.API_TOKEN = prev;
  }
}

async function json(base: string, path: string, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { headers });
  return { status: res.status, text: await res.text() };
}

test("ключ: без API_TOKEN эндпоинты открыты, как раньше", async () => {
  const { root, dist } = fakeSite();
  try {
    await withToken(undefined, () =>
      withServer(dist, async (base) => {
        const res = await json(base, "/api/signals");
        assert.equal(res.status, 200, "без ключа сервер работает открыто");
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ключ: с API_TOKEN без заголовка — 401 и код unauthorized", async () => {
  const { root, dist } = fakeSite();
  try {
    await withToken(TOKEN, () =>
      withServer(dist, async (base) => {
        const res = await json(base, "/api/signals");
        assert.equal(res.status, 401);
        const body = JSON.parse(res.text);
        assert.equal(body.error.code, "unauthorized");
        assert.equal(body.error.message, "нужен ключ доступа к демо-контуру");
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ключ: неверный ключ — 401, верный — 200", async () => {
  const { root, dist } = fakeSite();
  try {
    await withToken(TOKEN, () =>
      withServer(dist, async (base) => {
        const bad = await json(base, "/api/signals", { "X-Api-Token": OTHER });
        assert.equal(bad.status, 401);

        const good = await json(base, "/api/signals", { "X-Api-Token": TOKEN });
        assert.equal(good.status, 200);
        assert.ok(Array.isArray(JSON.parse(good.text)));
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ключ: статика и /api/health открыты без ключа", async () => {
  const { root, dist } = fakeSite();
  try {
    await withToken(TOKEN, () =>
      withServer(dist, async (base) => {
        const page = await fetch(base + "/");
        assert.equal(page.status, 200, "HTML ярлыка обязан отдаваться без ключа");
        assert.match(page.headers.get("content-type") ?? "", /text\/html/);
        assert.match(await page.text(), /AUTH_INDEX/);

        const icon = await fetch(base + "/icon-192.png");
        assert.equal(icon.status, 200, "иконка ярлыка обязана отдаваться без ключа");
        assert.match(icon.headers.get("content-type") ?? "", /image\/png/);

        const health = await json(base, "/api/health");
        assert.equal(health.status, 200, "/api/health открыт для мониторинга");
        assert.equal(JSON.parse(health.text).ok, true);
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ключ: секрет не попадает в ответы и в перехваченный вывод", async () => {
  const { root, dist } = fakeSite();
  const logs: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  try {
    await withToken(TOKEN, () =>
      withServer(dist, async (base) => {
        console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
        console.error = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
        console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
        try {
          const noKey = await json(base, "/api/signals");
          const wrongKey = await json(base, "/api/signals", { "X-Api-Token": OTHER });
          assert.equal(noKey.status, 401);
          assert.equal(wrongKey.status, 401);
          assert.ok(!noKey.text.includes(TOKEN), "ключ не должен быть в теле ответа");
          assert.ok(!wrongKey.text.includes(TOKEN), "ключ не должен быть в теле ответа");
        } finally {
          console.log = orig.log;
          console.error = orig.error;
          console.warn = orig.warn;
        }

        // Факт отказа записан в журнал — но БЕЗ значения ключа.
        const auditRes = await json(base, "/api/audit?limit=50", { "X-Api-Token": TOKEN });
        assert.equal(auditRes.status, 200);
        const entries = JSON.parse(auditRes.text) as { action: string; payload: unknown }[];
        const unauthorized = entries.filter((e) => e.action === "api.unauthorized");
        assert.ok(unauthorized.length >= 2, "отказы по ключу должны попадать в audit");
        assert.ok(
          !JSON.stringify(unauthorized).includes(TOKEN),
          "значения ключа в audit быть не должно",
        );
      }),
    );
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
    rmSync(root, { recursive: true, force: true });
  }

  assert.ok(
    !logs.join("\n").includes(TOKEN),
    "ключ не должен попадать в логи",
  );
});
