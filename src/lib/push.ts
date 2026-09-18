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
export async function setKind(kind: PushKind, on: boolean): Promise<PushPrefs> {
  const prefs = { ...readPrefs(), [kind]: on };

  if (!on) {
    savePrefs(prefs);
    await sync(prefs);
    return prefs;
  }
  if (!available()) return readPrefs();

  /* Разрешение спрашиваем ровно здесь — в ответ на осознанное включение. */
  if (Notification.permission === "default") {
    const res = await Notification.requestPermission();
    if (res !== "granted") return readPrefs();
  }
  if (Notification.permission !== "granted") return readPrefs();

  const ok = await subscribe(prefs);
  if (!ok) return readPrefs();
  savePrefs(prefs);
  return prefs;
}

/** Завести (или обновить) подписку устройства и отправить её боту. */
async function subscribe(prefs: PushPrefs): Promise<boolean> {
  const reg = await register();
  if (!reg) return false;
  const key = await API.pushKey().catch(() => "");
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
