/**
 * Хук опроса сервера.
 *
 * Данные обновляются сами: в mock-режиме время ускорено (каждый цикл двигает
 * мир на `tick_minutes`), поэтому цена, PnL и алерты меняются без действий
 * человека. Без опроса экран показывал бы застывший кадр и выглядел бы
 * сломанным.
 *
 * Три правила, ради которых хук и существует:
 *   1. Один интервал на экран, а не по «setInterval в каждом компоненте».
 *   2. При размонтировании опрос ОСТАНАВЛИВАЕТСЯ и результат «в полёте»
 *      игнорируется — иначе состояние уходило бы в уже удалённый компонент.
 *   3. Ручной refresh не гасит уже показанные данные: во время обновления
 *      экран не должен мигать пустотой.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface PollResult<T> {
  data: T | null;
  error: string | null;
  /** true только на первой загрузке — повторные опросы идут «в тишине». */
  loading: boolean;
  /** Немедленный опрос вручную (кнопка «Обновить»). */
  refresh: () => void;
}

export function useApi<T>(
  fetcher: () => Promise<T>,
  /** 0 — опрос выключен, грузим один раз. */
  intervalMs = 0,
  /** Зависимости запроса (например, id монеты или таймфрейм). */
  deps: readonly unknown[] = [],
): PollResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Свежий fetcher без перезапуска эффекта: замыкание могло устареть, а
  // пересоздавать интервал на каждый рендер нельзя.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Последний запуск текущего цикла — для ручного refresh. Хранится в ref, а
  // не в состоянии: это не данные, а действие.
  const runRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Флаг ОТМЕНЫ живёт в замыкании ЭТОГО запуска эффекта, а не в общем ref.
    // Иначе при смене зависимостей (другая монета) ответ по СТАРОМУ запросу,
    // пришедший уже после старта нового, считался бы «живым» и затёр бы
    // свежие данные старыми.
    let cancelled = false;

    const runOnce = async () => {
      try {
        const next = await fetcherRef.current();
        if (cancelled) return;
        setData(next);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    runRef.current = () => { setLoading(true); void runOnce(); };

    setLoading(true);
    void runOnce();

    let timer: ReturnType<typeof setInterval> | undefined;
    if (intervalMs > 0) timer = setInterval(() => void runOnce(), intervalMs);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);

  const refresh = useCallback(() => { runRef.current?.(); }, []);

  return { data, error, loading, refresh };
}
