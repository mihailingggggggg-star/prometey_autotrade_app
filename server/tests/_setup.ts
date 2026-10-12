/**
 * tests/_setup.ts — изоляция окружения тестов.
 *
 * Тесты НЕ должны трогать рабочие data/demo.db и .env: здесь под каждый прогон
 * создаётся временный каталог, и туда переадресуются DB_PATH, ENV_PATH и путь
 * к ключу шифрования. Файл не называется *.test.ts, поэтому сам тестом не считается.
 *
 * При запуске через index.ts (когда Node разворачивает каталог) env ставится один
 * раз на общий процесс; при запуске файла отдельно — у каждого процесса свой temp.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureClock, metaGet, metaSet, getDb } from "../db.ts";

const dir = mkdtempSync(join(tmpdir(), "prometey-test-"));
if (!process.env.DB_PATH) process.env.DB_PATH = join(dir, "test.db");
if (!process.env.ENV_PATH) process.env.ENV_PATH = join(dir, ".env");
if (!process.env.SECRET_KEY_PATH) process.env.SECRET_KEY_PATH = join(dir, ".secret_key");
if (!process.env.DATA_MODE) process.env.DATA_MODE = "mock";

/**
 * Откатить виртуальные часы к старту мира. Нужно потому, что при запуске через
 * агрегатор все тесты делят один процесс и одни часы: разогнав их в одном тесте,
 * мы бы получили «уже разогнанный» мир в следующем. Сброс даёт каждому тесту
 * свежий демо-мир.
 */
export function resetWorld(): void {
  ensureClock();
  metaSet("virtual_ts", metaGet("world_start") as string);
  // Изоляция сделок между тестами: при агрегаторе все файлы делят одну БД, а
  // антидубль входа запрещает вторую открытую позицию по монете — без очистки
  // следующий тест упёрся бы в 409. Живые сигналы/депозиты не трогаем.
  getDb().exec("DELETE FROM fills; DELETE FROM positions; DELETE FROM alerts;");
}

export const TEST_DIR = dir;
