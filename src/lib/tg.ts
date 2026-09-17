/**
 * Мост к Telegram. В браузере на локалхосте WebApp-объекта нет — тогда работаем
 * в «режиме превью»: тема берётся системная, хаптика молчит. Это нужно, чтобы
 * интерфейс можно было смотреть и править без прогона через Telegram.
 */
type TG = {
  ready(): void; expand(): void;
  colorScheme: "light" | "dark";
  themeParams: Record<string, string>;
  onEvent(e: string, cb: () => void): void;
  HapticFeedback?: {
    impactOccurred(s: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
    notificationOccurred(t: "error" | "success" | "warning"): void;
    selectionChanged(): void;
  };
  /** Подписанная строка авторизации. Именно она уезжает боту в заголовке —
   *  initDataUnsafe подписи не несёт и доверять ему нельзя. */
  initData?: string;
  initDataUnsafe?: { user?: { first_name?: string; username?: string; id?: number } };
  setHeaderColor?(c: string): void;
  disableVerticalSwipes?(): void;
};

export const tg: TG | undefined = (window as any).Telegram?.WebApp;
export const inTelegram = Boolean(tg?.initDataUnsafe?.user || tg?.themeParams?.bg_color);

/**
 * Тема ОДНА — тёмная, и она не следует ни за Telegram, ни за системой
 * (решение владельца 17.09.2026). Поэтому здесь не «применить тему», а
 * «настоять на своей»: светлое оформление Telegram красит свою шапку в белый,
 * и над чёрным экраном повисала бы чужая полоса.
 */
export function applyTheme() {
  document.documentElement.dataset.theme = "dark";
  document.documentElement.style.colorScheme = "dark";
  tg?.setHeaderColor?.("#000000");
}

export function initTelegram() {
  applyTheme();
  if (!tg) return;
  tg.ready(); tg.expand();
  tg.disableVerticalSwipes?.();
  // Человек переключил оформление Telegram — своё возвращаем обратно.
  tg.onEvent("themeChanged", applyTheme);
}

/** Хаптика: у iOS она часть языка интерфейса, без неё нажатие «ватное». */
export const haptic = {
  tap: () => tg?.HapticFeedback?.impactOccurred("light"),
  press: () => tg?.HapticFeedback?.impactOccurred("medium"),
  heavy: () => tg?.HapticFeedback?.impactOccurred("rigid"),
  select: () => tg?.HapticFeedback?.selectionChanged(),
  ok: () => tg?.HapticFeedback?.notificationOccurred("success"),
  warn: () => tg?.HapticFeedback?.notificationOccurred("warning"),
  err: () => tg?.HapticFeedback?.notificationOccurred("error"),
};

export const tgUser = tg?.initDataUnsafe?.user;
