/**
 * Служебный поток приложения. Он здесь ровно ради уведомлений: без него
 * браузер не отдаёт push вообще — ни на Android, ни на iOS (там push работает
 * только у ярлыка, вынесенного на рабочий стол).
 *
 * Кэша тут намеренно НЕТ. Приложение показывает состояние торгового счёта, и
 * отдать из кэша вчерашний баланс хуже, чем не отдать ничего: человек примет
 * решение по числу, которого уже нет. Поэтому обработчика fetch нет вовсе —
 * все запросы идут в сеть, как без служебного потока.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }
  const title = d.title || "PROMETHEUS";
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || "",
    /* Иконка приложения — та же, что на рабочем столе: уведомление должно
       читаться как пришедшее от знакомого значка, а не от безымянной вкладки. */
    icon: d.icon || "./icon-192.png",
    badge: "./icon-192.png",
    tag: d.tag || undefined,
    /* Одна монета не должна множить уведомления: новое по той же сделке
       заменяет прежнее, а не ложится стопкой. */
    renotify: Boolean(d.tag),
    data: { url: d.url || "./" },
    vibrate: d.kind === "system" ? [30, 40, 30] : [24],
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    /* Уже открытое окно — поднимаем его, а не плодим второе: у приложения
       есть живые подписки на биржу, и второе окно открыло бы их заново. */
    for (const c of all) if ("focus" in c) return c.focus();
    return self.clients.openWindow(url);
  })());
});
