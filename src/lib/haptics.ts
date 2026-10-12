/**
 * Хаптика без Telegram.
 *
 * Раньше язык нажатия приходил из Telegram (`lib/tg`): WebApp.HapticFeedback.
 * Telegram-обвязка из демо-контура убрана вместе с фьючерсным контуром, но
 * хаптика — часть языка интерфейса: без неё нажатие «ватное». Поэтому набор
 * методов и подписи кнопок сохранены ровно теми же (`tap/press/heavy/select/
 * ok/warn/err`), а вместо Telegram используется Vibration API.
 *
 * В браузерах, где Vibration не поддержан (iOS Safari), вызовы ничего не
 * делают — это нормальное состояние, а не ошибка: хаптика здесь необязательна.
 */
const buzz = (pattern: number | number[]) => {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* не поддержано — молча */
  }
};

export const haptic = {
  tap: () => buzz(8),
  press: () => buzz(14),
  heavy: () => buzz(22),
  select: () => buzz(5),
  ok: () => buzz([10, 40, 10]),
  warn: () => buzz([14, 50, 14]),
  err: () => buzz([18, 60, 18, 60, 18]),
};
