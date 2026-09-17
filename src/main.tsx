import "./theme.css";
import { bootApi } from "./lib/boot";
import { inTelegram, initTelegram } from "./lib/tg";

initTelegram();

/**
 * Рамка телефона на широком экране. Внутри Telegram её нет никогда: там окно и
 * так шириной с устройство, а рамка съела бы полезную высоту.
 * Порог 520px — по нему же проходит граница «это уже не телефон».
 */
function frame() {
  const desk = !inTelegram && window.innerWidth >= 520;
  document.documentElement.classList.toggle("desk", desk);
}
frame();
window.addEventListener("resize", frame);

/**
 * Приложение поднимается ПОСЛЕ того, как выяснен адрес бота.
 *
 * Иначе нельзя: api.ts читает адрес в момент импорта, а половина приложения
 * решает по нему, показывать настоящий счёт или демонстрацию. Сначала
 * `bootApi()` (ссылка → память → сборка → файл рядом с приложением), и только
 * потом динамический импорт — он и тянет за собой api.ts.
 */
void bootApi()
  .then(() => import("./mount"))
  .then((m) => m.mount());
