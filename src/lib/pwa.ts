/**
 * Установка на рабочий стол — БЕЗ Telegram.
 *
 * Ярлык должен открывать самостоятельное веб-приложение, а не мини-апп внутри
 * мессенджера. Отсюда два требования, и оба неочевидны:
 *
 * 1. НУЖЕН МАНИФЕСТ. Без него iOS делает не приложение, а закладку: она
 *    открывается в Safari со всей его обвязкой, а не на весь экран.
 *
 * 2. МАНИФЕСТ НУЖЕН ПЕРСОНАЛЬНЫЙ. Статический `start_url` запускал бы
 *    приложение по голому адресу — без билета доступа и без адреса API. Такой
 *    ярлык открывался бы каждый раз на демо-данных, то есть выглядел бы
 *    сломанным. Поэтому манифест собирается в момент установки и содержит
 *    ПОЛНЫЙ адрес текущей сессии, а ссылку на него подменяем на лету.
 */

const BASE = import.meta.env.BASE_URL || "/";

export const standalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  // iOS до сих пор сообщает об этом своим нестандартным способом.
  (navigator as unknown as { standalone?: boolean }).standalone === true;

let blobUrl = "";

/** Подменить манифест персональным. Зовётся перед тем, как человек добавляет
 *  ярлык: в этот момент в адресе уже есть и билет, и адрес API. */
export function personalizeManifest(startUrl: string = location.href) {
  const doc = {
    name: "PROMETHEUS · автотрейд",
    short_name: "PROMETHEUS",
    start_url: startUrl,
    scope: BASE,
    display: "standalone",
    orientation: "portrait",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      { src: BASE + "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: BASE + "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: BASE + "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!link) return;
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = URL.createObjectURL(new Blob([JSON.stringify(doc)], { type: "application/manifest+json" }));
  link.href = blobUrl;
}

/* Android: браузер сам предлагает установку событием beforeinstallprompt, и
   его надо перехватить — иначе предложение исчезнет, не показавшись. */
type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
let deferred: InstallPrompt | null = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferred = e as InstallPrompt;
});

export const canInstall = () => deferred !== null;

/** Системное окно установки. true — человек согласился. */
export async function install(): Promise<boolean> {
  if (!deferred) return false;
  personalizeManifest();
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  return outcome === "accepted";
}
