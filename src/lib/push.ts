/**
 * Уведомления.
 *
 * Три независимых вида, и разделение не косметическое: у них разная цена
 * ошибки. «Позиции» — факт про ваши деньги, «системные» — про то, что бот
 * перестал работать, «информационные» — то, что можно и не читать. Свалив их
 * в один тумблер, мы заставили бы выключать важное ради тишины от новостей —
 * и человек выключил бы всё.
 *
 * ТЕХНИКА. Push в вебе устроен так: служебный поток (`sw.js`) + подписка
 * браузера, заверенная ключом сервера (VAPID). Подписка принадлежит
 * УСТРОЙСТВУ, а не счёту: отсюда и хранение на сервере по устройству, и
 * повторная отправка настроек при каждом изменении.
 *
 * iOS. Там push приходит ТОЛЬКО установленному ярлыку (PWA на рабочем столе)
 * и только начиная с iOS 16.4; во вкладке Safari и внутри Telegram этого API
 * нет вовсе. Поэтому `available()` проверяет не «разрешил ли человек», а
 * «возможно ли это здесь физически» — и экран говорит правду вместо того,
 * чтобы показывать тумблеры, которые ничего не включат.
 *
 * РАЗРЕШЕНИЕ спрашивается при ПЕРВОМ включении любого вида, а не на старте
 * приложения. Системный запрос даётся один раз: спросив его до того, как
 * человек чего-то захотел, мы почти гарантированно получаем отказ — и второго
 * шанса у нас уже не будет.
 */

import * as API from "./api";

export type PushKind = "system" | "positions" | "news";
export type PushPrefs = Record<PushKind, boolean>;

export const PUSH_OFF: PushPrefs = { system: false, positions: false, news: false };
const KEY = "prometey.push";

/** Возможны ли push в этой среде вообще. */
export function available(): boolean {
  return typeof window !== "undefined" &&
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Уже отказано насовсем? Тогда тумблер включить нельзя ничем, кроме настроек
 *  системы, и честнее так и сказать. */
export const denied = () =>
  available() && Notification.permission === "denied";

/**
 * ПОЧЕМУ уведомления не работают — четыре РАЗНЫЕ причины, и путать их нельзя:
 * человек идёт чинить не туда. «Телефон не дал разрешения» и «у бота нет
 * ключей отправки» требуют противоположных действий, а раньше обе показывались
 * одной строкой, которая винила телефон.
 *
 *   unsupported — окно не умеет push (Telegram-вебвью, Safari без ярлыка);
 *   denied      — система запретила насовсем, чинится только в настройках iOS;
 *   default     — ещё не спрашивали, тумблер спросит;
 *   no-server   — телефон готов, а у бота не настроены ключи (VAPID);
 *   ok          — всё на месте.
 */
export type PushStatus = "ok" | "unsupported" | "denied" | "default" | "no-server";

let _key: string | null = null;      // ключ сервера: спрашиваем один раз за сеанс

async function serverKey(force = false): Promise<string> {
  if (_key !== null && !force) return _key;
  _key = await API.pushKey().catch(() => "");
  return _key;
}

/** Состояние канала ЗДЕСЬ И СЕЙЧАС. Спрашивается заново при каждом открытии
 *  экрана и при возврате в приложение: разрешение меняют в настройках системы,
 *  не выходя из него, и застывший ответ врал бы ровно тому, кто уже всё
 *  починил. */
export async function probe(): Promise<PushStatus> {
  if (!available()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (!(await serverKey())) return "no-server";
  return Notification.permission === "granted" ? "ok" : "default";
}

export function readPrefs(): PushPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { system: !!v.system, positions: !!v.positions, news: !!v.news };
  } catch { return { ...PUSH_OFF }; }
}

function savePrefs(p: PushPrefs) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* приватное окно */ }
}

const BASE = import.meta.env.BASE_URL || "/";

async function register(): Promise<ServiceWorkerRegistration | null> {
  try { return await navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE }); }
  catch { return null; }
}

/** base64url из VAPID-ключа сервера — в формат, который просит браузер. */
function keyBytes(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/**
 * Включить или выключить вид уведомлений. Возвращает, что получилось на самом
 * деле: нажатие на тумблер и разрешение системы — разные события, и врать про
 * второе первым нельзя.
 */
export async function setKind(kind: PushKind, on: boolean):
    Promise<{ prefs: PushPrefs; reason: PushStatus }> {
  const prefs = { ...readPrefs(), [kind]: on };

  if (!on) {
    savePrefs(prefs);
    await sync(prefs);
    return { prefs, reason: "ok" };
  }
  if (!available()) return { prefs: readPrefs(), reason: "unsupported" };

  /* Разрешение спрашиваем ровно здесь — в ответ на осознанное включение. */
  if (Notification.permission === "default") {
    const res = await Notification.requestPermission();
    if (res !== "granted") return { prefs: readPrefs(), reason: "denied" };
  }
  if (Notification.permission !== "granted") {
    return { prefs: readPrefs(), reason: "denied" };
  }
  if (!(await serverKey(true))) {
    /* Телефон готов, а отправлять некому: у бота не прописаны ключи VAPID.
       ВЫБОР ЧЕЛОВЕКА ПРИ ЭТОМ СОХРАНЯЕМ. Раньше он молча откатывался, и
       тумблеры «сбрасывались» при каждом возвращении на экран — выглядело как
       сломанный интерфейс, хотя сломан был сервер. Подписку доберём сами,
       как только ключи появятся (см. ensure). */
    savePrefs(prefs);
    return { prefs, reason: "no-server" };
  }

  const ok = await subscribe(prefs);
  savePrefs(prefs);
  return { prefs, reason: ok ? "ok" : "no-server" };
}

/**
 * Восстановить подписку при запуске.
 *
 * Подписка живёт в браузере и может исчезнуть сама: система чистит её при
 * долгом простое, а сервер выбрасывает мёртвые адреса. Без этого шага человек
 * один раз включил уведомления и молча перестал их получать — причём тумблеры
 * показывали бы «включено», то есть интерфейс уверял бы в том, чего нет.
 * Сюда же попадает случай «включили, когда у бота ещё не было ключей».
 *
 * Тихая и дешёвая: без разрешения и без включённых видов не делает ничего.
 */
export async function ensure(): Promise<void> {
  const prefs = readPrefs();
  if (!Object.values(prefs).some(Boolean)) return;
  if (!available() || Notification.permission !== "granted") return;
  if (!(await serverKey(true))) return;
  await subscribe(prefs).catch(() => false);
}

/** Завести (или обновить) подписку устройства и отправить её боту. */
async function subscribe(prefs: PushPrefs): Promise<boolean> {
  const reg = await register();
  if (!reg) return false;
  const key = await serverKey();
  if (!key) return false;   // у бота не настроены ключи — включать нечего
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(key) as BufferSource,
      });
    } catch { return false; }
  }
  return API.pushSubscribe(sub.toJSON(), prefs).then(() => true).catch(() => false);
}

/** Отправить боту текущий набор видов (в том числе «всё выключено»). */
async function sync(prefs: PushPrefs) {
  if (!available()) return;
  const reg = await navigator.serviceWorker.getRegistration(BASE);
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await API.pushSubscribe(sub.toJSON(), prefs).catch(() => {});
}
