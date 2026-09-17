/**
 * Вход по биометрии для ВЕБ-версии (Face ID / отпечаток).
 *
 * Что это на самом деле: ЗАМОК НА УСТРОЙСТВЕ, а не второй фактор на сервере.
 * Ключ доступа лежит в этом браузере; биометрия решает, отдать ли его тому,
 * кто сейчас держит телефон в руках. От чужого человека с разблокированным
 * телефоном защищает, от кражи самого ключа — нет, и обещать обратное нельзя.
 *
 * Техника — WebAuthn с платформенным аутентификатором: на iOS это Face ID или
 * Touch ID, на Android — отпечаток или лицо. Никакого своего окна с отпечатком
 * мы не рисуем: показывает его система, и правильно, что нашему коду палец
 * никто не доверяет.
 */

const KEY = "prometey.bio.credential";

const enc = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const dec = (s: string) => {
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

const rnd = () => crypto.getRandomValues(new Uint8Array(32));

/** Умеет ли устройство встроенную биометрию. Именно ВСТРОЕННУЮ: ключи-брелоки
 *  и прочие внешние ключи нам не подходят — замок должен открываться тем же
 *  жестом, что и сам телефон. */
export async function bioSupported(): Promise<boolean> {
  if (!window.PublicKeyCredential || !window.isSecureContext) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export const bioEnabled = () => {
  try { return Boolean(localStorage.getItem(KEY)); } catch { return false; }
};

/** Завести замок. Возвращает причину отказа или пусто при успехе. */
export async function enableBio(userId: number, name: string): Promise<string> {
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: rnd(),
        rp: { name: "PROMETHEUS", id: location.hostname },
        user: { id: new TextEncoder().encode(String(userId || "local")),
                name: name || "трейдер", displayName: name || "трейдер" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
          residentKey: "preferred",
        },
        timeout: 60000,
        attestation: "none",
      },
    }) as PublicKeyCredential | null;
    if (!cred) return "система не вернула ключ";
    localStorage.setItem(KEY, enc(cred.rawId));
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/* ── Предложить замок сразу после входа ──────────────────────────────────────
   Биометрия, живущая только в глубине кабинета, не включается никогда: про
   неё надо знать заранее. Предлагаем ровно один раз — в тот момент, когда
   человек только что ввёл код и ценность «больше не вводить» очевидна.
   Отметка ставится ДО перезагрузки страницы, поэтому и живёт в localStorage. */

const ASK = "prometey.bio.ask";

export function wantBioAsk() {
  try { localStorage.setItem(ASK, "1"); } catch { /* приватное окно */ }
}

export function bioAsk(): boolean {
  try { return localStorage.getItem(ASK) === "1"; } catch { return false; }
}

/** Спросили — и больше не спрашиваем: навязчивое окно при каждом запуске
 *  раздражает сильнее, чем помогает. Включить можно в кабинете. */
export function clearBioAsk() {
  try { localStorage.removeItem(ASK); } catch { /* приватное окно */ }
}

export function disableBio() {
  try { localStorage.removeItem(KEY); } catch { /* приватное окно */ }
}

/** Спросить биометрию. true — открыли. */
export async function unlock(): Promise<boolean> {
  let id = "";
  try { id = localStorage.getItem(KEY) || ""; } catch { return true; }
  if (!id) return true;
  try {
    const got = await navigator.credentials.get({
      publicKey: {
        challenge: rnd(),
        allowCredentials: [{ type: "public-key", id: dec(id) }],
        userVerification: "required",
        timeout: 60000,
      },
    });
    return Boolean(got);
  } catch {
    return false;
  }
}
