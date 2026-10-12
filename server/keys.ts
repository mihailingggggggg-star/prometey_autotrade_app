/**
 * keys.ts — работа с ключами внешних сервисов и секретом кошелька.
 *
 * Инварианты безопасности (§4, §11 плана):
 *  · в API, БД и логах нет значений — только {set, preview, updated_ts};
 *  · .env всегда chmod 600;
 *  · секрет кошелька пишется в .env ТОЛЬКО зашифрованным (AES-256-GCM),
 *    ключ шифрования — data/.secret_key (создаётся при первом использовании).
 *
 * Публичный адрес кошелька в V1 выводится как base58(sha256(secret)): без
 * зависимости для ed25519 полноценный адрес не получить, а демо-контуру нужен
 * «красивый» публичный идентификатор вместо маски. Это НЕ боевой адрес.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { dataDir, getEnv, writeEnvKeys, ApiError } from "./config.ts";
import { getDb, nowSec, audit } from "./db.ts";
import type { KeysStatus, KeysUpdate, KeyStatus } from "../shared/types.ts";

/** Соответствие полей API и переменных .env. */
const ENV_KEYS: Record<keyof Omit<KeysUpdate, "wallet_secret">, string> = {
  telegram_bot_token: "TELEGRAM_BOT_TOKEN",
  telegram_chat_id: "TELEGRAM_CHAT_ID",
  helius_api_key: "HELIUS_API_KEY",
  gemini_api_key: "GEMINI_API_KEY",
};

const WALLET_ENV = "WALLET_SECRET";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/* ─────────────── маскирование ─────────────── */

/** Маска ключа: «первые 4 … последние 2». Короткие значения маскируем целиком. */
export function maskValue(v: string): string {
  const s = String(v);
  if (s.length === 0) return "";
  if (s.length <= 6) return `${s[0] ?? ""}…${s[s.length - 1] ?? ""}`;
  return `${s.slice(0, 4)}…${s.slice(-2)}`;
}

/* ─────────────── base58 и «публичный адрес» ─────────────── */

function base58(buf: Buffer): string {
  let n = BigInt("0x" + buf.toString("hex"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  let zeros = 0;
  for (const b of buf) {
    if (b === 0) zeros++;
    else break;
  }
  return "1".repeat(zeros) + s;
}

/** Публичный адрес-заглушка из секрета (детерминирован, неразборчив без секрета). */
export function addressFor(secret: string): string {
  return base58(createHash("sha256").update(secret).digest());
}

/* ─────────────── шифрование секрета ─────────────── */

function secretKeyPath(): string {
  return process.env.SECRET_KEY_PATH
    ? resolve(process.env.SECRET_KEY_PATH)
    : join(dataDir(), ".secret_key");
}

function getSecretKey(): Buffer {
  const p = secretKeyPath();
  if (existsSync(p)) {
    const k = readFileSync(p);
    if (k.length === 32) return k;
  }
  mkdirSync(dirname(p), { recursive: true });
  const k = randomBytes(32);
  writeFileSync(p, k, { mode: 0o600 });
  chmodSync(p, 0o600);
  return k;
}

/** Формат "v1:iv:tag:ciphertext" (все части base64). GCM даёт и шифр, и аутентичность. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getSecretKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(blob: string): string {
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return blob; // не наш формат — вернём как есть
  const [, ivB64, tagB64, ctB64] = parts;
  try {
    const decipher = createDecipheriv("aes-256-gcm", getSecretKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new ApiError("wallet_decrypt_failed", 500, "не удалось расшифровать секрет кошелька");
  }
}

/* ─────────────── keys_meta ─────────────── */

function upsertMeta(name: string, isSet: boolean, preview: string): void {
  getDb()
    .prepare(
      "INSERT INTO keys_meta(key_name, is_set, updated_ts, preview) VALUES(?,?,?,?) " +
        "ON CONFLICT(key_name) DO UPDATE SET is_set=excluded.is_set, updated_ts=excluded.updated_ts, preview=excluded.preview",
    )
    .run(name, isSet ? 1 : 0, nowSec(), preview);
}

function metaUpdatedTs(name: string): number {
  const row = getDb().prepare("SELECT updated_ts FROM keys_meta WHERE key_name=?").get(name) as
    | { updated_ts: number }
    | undefined;
  return row ? row.updated_ts : 0;
}

/* ─────────────── статус и запись ─────────────── */

export function getKeysStatus(): KeysStatus {
  const one = (field: keyof typeof ENV_KEYS): KeyStatus => {
    const val = getEnv(ENV_KEYS[field]);
    const set = val.length > 0;
    return { set, preview: set ? maskValue(val) : "", updated_ts: metaUpdatedTs(field) };
  };
  const raw = getEnv(WALLET_ENV);
  let walletSet = raw.length > 0;
  let address = "";
  if (walletSet) {
    try {
      address = addressFor(decryptSecret(raw));
    } catch {
      // Повреждённый data/.secret_key не должен валить /api/keys/status и
      // /api/health (живой сервер выглядел бы мёртвым). Значение ключа в лог
      // не пишем — только факт и подсказку.
      walletSet = false;
      console.error("[keys] не удалось расшифровать секрет кошелька — проверьте data/.secret_key");
    }
  }
  return {
    telegram_bot_token: one("telegram_bot_token"),
    telegram_chat_id: one("telegram_chat_id"),
    helius_api_key: one("helius_api_key"),
    gemini_api_key: one("gemini_api_key"),
    wallet: {
      set: walletSet,
      preview: address, // у кошелька вместо маски — публичный адрес
      updated_ts: metaUpdatedTs("wallet"),
      address,
    },
  };
}

export function setKeys(update: KeysUpdate): KeysStatus {
  const entries: Record<string, string> = {};
  const touched: string[] = [];
  const metas: { name: string; preview: string }[] = [];

  for (const field of Object.keys(ENV_KEYS) as (keyof typeof ENV_KEYS)[]) {
    const v = update[field];
    if (v === undefined || v === null) continue;
    const val = String(v).trim();
    if (!val.length) continue;
    entries[ENV_KEYS[field]] = val;
    metas.push({ name: field, preview: maskValue(val) });
    touched.push(field);
  }

  if (update.wallet_secret !== undefined && update.wallet_secret !== null) {
    const secret = String(update.wallet_secret).trim();
    if (secret.length) {
      entries[WALLET_ENV] = encryptSecret(secret);
      metas.push({ name: "wallet", preview: addressFor(secret) });
      touched.push("wallet");
    }
  }

  // Сначала пишем .env (здесь отвергаются значения с переводом строки), и лишь
  // потом фиксируем мету — иначе keys_meta сказала бы «set», а значение не легло.
  if (Object.keys(entries).length) writeEnvKeys(entries);
  for (const m of metas) upsertMeta(m.name, true, m.preview);
  if (touched.length) audit("keys.update", { touched }, "user"); // только имена, без значений
  return getKeysStatus();
}
