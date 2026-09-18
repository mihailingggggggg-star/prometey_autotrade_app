/**
 * swipe.ts — жесты «вправо-влево» по экрану.
 *
 * Два разных жеста, и путать их нельзя:
 *   • на КОРНЕВЫХ вкладках свайп листает вкладки — как в любом приложении со
 *     вкладками;
 *   • на ГЛУБОКОМ экране свайп вправо означает «назад», и листать там нечего.
 *
 * Сделано на pointer-событиях, а не через drag у motion, по одной причине: на
 * экране есть места, где горизонтальный жест ПРИНАДЛЕЖИТ содержимому — график
 * (протяжка времени), ряды с горизонтальной прокруткой, ручки уровней. Такие
 * места помечены `data-noswipe`, и жест, начавшийся внутри, мы не трогаем
 * вовсе. С drag-обёрткой это решалось бы гонкой обработчиков.
 *
 * Порог двойной: и по расстоянию, и по НАПРАВЛЕНИЮ (горизонтали должно быть
 * вдвое больше вертикали). Иначе вкладка переключалась бы во время обычной
 * прокрутки списка — самый раздражающий вид ложного жеста.
 */

import { useRef } from "react";

const MIN_X = 56;          // короче — это промах, а не жест
const RATIO = 1.8;         // во сколько раз горизонтали больше вертикали

type Opts = { onLeft?: () => void; onRight?: () => void; enabled?: boolean };

export function useSwipe({ onLeft, onRight, enabled = true }: Opts) {
  const from = useRef<{ x: number; y: number; ok: boolean } | null>(null);

  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (!enabled || e.pointerType === "mouse") { from.current = null; return; }
      const inside = (e.target as HTMLElement)?.closest?.("[data-noswipe]");
      from.current = { x: e.clientX, y: e.clientY, ok: !inside };
    },
    onPointerUp: (e: React.PointerEvent) => {
      const f = from.current;
      from.current = null;
      if (!f?.ok) return;
      const dx = e.clientX - f.x, dy = e.clientY - f.y;
      if (Math.abs(dx) < MIN_X || Math.abs(dx) < Math.abs(dy) * RATIO) return;
      if (dx < 0) onLeft?.(); else onRight?.();
    },
    onPointerCancel: () => { from.current = null; },
  };
}
