/**
 * ScanProgress — наложение с живым ходом поиска монет.
 *
 * Скан длится от минуты до восьми, и по одному спиннеру нельзя понять, идёт
 * работа или всё зависло. Пока наложение открыто, раз в 2 секунды спрашиваем
 * дешёвый GET /api/scan/status и показываем фазу словами, сколько кандидатов
 * проверено из найденных, сколько сигналов уже есть, время, отбраковку по слоям
 * и последнюю строку о происходящем.
 *
 * Процент прогресса — честный: пока кандидаты не найдены, его нет вовсе (полоса
 * неопределённая), а не выдуманные числа. По завершении показываем итог и
 * причину, если сигналов ноль.
 *
 * Запуск POST /api/scan больше НЕ ждёт окончания: сервер уводит скан в фон и
 * отвечает сразу (202), а мы опрашиваем статус до running:false. Долгого
 * запроса нет — значит, обрыв связи на телефоне (блокировка экрана) не выглядит
 * как «сервер не отвечает». Ошибкой считаем только реальный отказ запуска
 * (HTTP 4xx/5xx или сеть), а не длительность ожидания. По завершении берём итог
 * из last_result и зовём onDone — лента на Главной перечитывается.
 */
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { scan, scanStatus, type ScanStatus } from "../lib/api";
import { Glass, Press, Sheet } from "./kit";
import { KV } from "./states";

/** Подписи слоёв отбраковки — те же слова, что и в фазах воронки. */
const LAYER_LABELS: Record<string, string> = {
  "1": "безопасность контракта",
  "2": "концентрация держателей",
  "3": "возраст и ликвидность",
  "4": "накопление",
  "5": "соцсети",
  budget: "лимит запросов",
  error: "сбои источников",
};

/** Прошедшее время в понятном виде: секунды или минуты с секундами. */
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} мин ${String(s).padStart(2, "0")} с` : `${s} с`;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ScanProgress({ open, onClose, onDone }: {
  open: boolean;
  onClose: () => void;
  /** Скан завершился — просьба перечитать данные (лента на Главной). */
  onDone: () => void;
}) {
  const [st, setSt] = useState<ScanStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    // Итог последнего скана показываем ровно один раз: onDone перечитывает ленту,
    // и повторные вызовы на каждом тике ей не нужны.
    let doneFired = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    setErr(null);
    setSt(null);
    setResolved(false);

    const tick = async () => {
      try {
        const s = await scanStatus();
        if (stopped) return;
        setSt(s);
        // Завершение: скан был запущен (или уже шёл) и перестал быть running.
        // last_result в этот момент уже заполнен сервером.
        if (!s.running && !doneFired) {
          doneFired = true;
          setResolved(true);
          onDone();
        }
      } catch (e) {
        if (!stopped) setErr(msg(e));
      }
    };

    // Запуск. Отвечает сразу — ждать нечего. Опрос статуса начинаем только после
    // успешного запуска: иначе первый тик мог бы прочитать итог ПРОШЛОГО скана и
    // показать «завершено» до того, как новый проход вообще начался.
    // onDone зовём даже если наложение уже закрыли — лента обязана обновиться.
    scan()
      .then(() => {
        if (stopped) return;
        void tick();
        timer = setInterval(() => void tick(), 2000);
      })
      .catch((e) => { if (!stopped) setErr(msg(e)); });

    return () => { stopped = true; if (timer) clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const running = st?.running ?? false;
  const total = st?.candidates_total ?? 0;
  const doneN = st?.candidates_done ?? 0;
  // Процент — только когда известны кандидаты. Иначе честная неопределённая полоса.
  const pct = total > 0 && st ? Math.round((doneN / total) * 100) : null;
  const done = resolved && st !== null && !st.running;
  // Найдено берём из итога последнего скана (last_result) — это тот же ScanResult,
  // что раньше приходил в синхронном ответе; счётчик на случай его отсутствия.
  const found = st?.last_result?.found ?? st?.signals_found ?? 0;
  const layers = st
    ? Object.entries(st.by_layer)
        .filter(([k, v]) => k in LAYER_LABELS && typeof v === "number" && v > 0)
        .sort((a, b) => b[1] - a[1])
    : [];

  const heading = err && !st
    ? "Не удалось запустить поиск"
    : st
      ? st.stage
      : "запускаю скан…";
  const sub = err ?? (st?.last_note || (done ? "поиск завершён" : "обращаюсь к источникам…"));

  return (
    <Sheet open={open} onClose={onClose} title="Поиск монет" tall>
      <div className="pb-4">
        {/* ── Полоса прогресса ─────────────────────────────────────────── */}
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--label-3)" }}>
          {pct !== null ? (
            <div className="h-full rounded-full transition-[width] duration-500"
                 style={{ width: `${pct}%`, background: "var(--tint)" }} />
          ) : (running || !st) && !err ? (
            <motion.div className="h-full rounded-full"
                        style={{ width: "32%", background: "var(--tint)" }}
                        animate={{ x: ["-110%", "330%"] }}
                        transition={{ duration: 1.3, repeat: Infinity, ease: "easeInOut" }} />
          ) : null}
        </div>

        {/* ── Фаза словами и последняя строка ──────────────────────────── */}
        <div className="mt-3 text-[17px] font-semibold leading-tight">{heading}</div>
        <div className="text-[13px] mt-0.5 leading-snug" style={{ color: "var(--label-2)" }}>{sub}</div>
        {err && (
          <p className="text-[13px] mt-2 leading-snug" style={{ color: "var(--orange)" }}>{err}</p>
        )}

        {/* ── Счётчики ─────────────────────────────────────────────────── */}
        {st && (
          <Glass flat className="mt-3 px-4 py-1 overflow-hidden">
            <KV label="Проверено кандидатов" value={total > 0 ? `${doneN} из ${total}` : "—"} mono />
            <KV label="Найдено сигналов" value={String(st.signals_found)} mono />
            <KV label="Прошло времени" value={fmtElapsed(st.elapsed_ms)} mono />
            {st.budget_total > 0 && (
              <KV label="Запросов к источникам" value={`${st.budget_used} из ${st.budget_total}`} mono />
            )}
          </Glass>
        )}

        {/* ── Отбраковка по слоям (компактно) ──────────────────────────── */}
        {layers.length > 0 && (
          <>
            <div className="mt-4 mb-1.5 text-[13px] uppercase tracking-wide font-medium"
                 style={{ color: "var(--label-2)" }}>Отбраковано по слоям</div>
            <Glass flat className="px-4 py-1 overflow-hidden">
              {layers.map(([k, v]) => (
                <KV key={k} label={LAYER_LABELS[k]} value={String(v)} mono />
              ))}
            </Glass>
          </>
        )}

        {/* ── Итог ─────────────────────────────────────────────────────── */}
        {done && (
          <div className="mt-4">
            <p className="text-[15px] leading-snug">
              {found > 0
                ? `Найдено ${found}, проверено ${st?.candidates_done ?? 0} кандидатов.`
                : `Сигналов нет: проверено ${st?.candidates_done ?? 0} кандидатов.`}
            </p>
            {found === 0 && (
              <p className="text-[13px] mt-1 leading-snug" style={{ color: "var(--label-2)" }}>
                {layers.length > 0
                  ? `Больше всего срезал слой «${LAYER_LABELS[layers[0][0]]}» — ${layers[0][1]} монет.`
                  : "Ни один кандидат не попал в окно стратегии — источники не дали подходящих монет."}
              </p>
            )}
            <Press onClick={onClose} feel="press" className="mt-3 block">
              <Glass flat className="py-3 text-center text-[15px] font-semibold">Закрыть</Glass>
            </Press>
          </div>
        )}
      </div>
    </Sheet>
  );
}
