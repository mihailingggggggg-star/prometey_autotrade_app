import { useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  ChevronRight, Pause, Play, Plus, ShieldAlert, TrendingUp, TrendingDown,
  Radio, Newspaper, Cpu, Globe, OctagonX, WifiOff, ServerCrash, FlaskConical, Lock,
} from "lucide-react";
import { Aurora, Glass, GroupLabel, Modal, Press, Segmented, Sheet, Title, Row, tone } from "../ui/kit";
import { useApp, posPnl, isOpen } from "../lib/store";
import * as M from "../lib/mock";
import { useTickers } from "../lib/useMarket";
import { haptic, inTelegram } from "../lib/tg";
import { apiRemembered, hasApi, hasSession } from "../lib/api";
import { AddToHomeCard, homeCardHidden } from "./AddToHome";
import { ConnectCard } from "./Connect";
import type { Ticker } from "../lib/market";

import { money, pct, price, ago, plural, rr } from "../lib/format";
import type { Tab } from "../nav/TabBar";

type Period = "d" | "w" | "m" | "all";
const PERIODS: { id: Period; label: string; days: number }[] = [
  { id: "d", label: "Сегодня", days: 1 },
  { id: "w", label: "Неделя", days: 7 },
  { id: "m", label: "Месяц", days: 30 },
  { id: "all", label: "Всё время", days: 3650 },
];

export function Home({ onTab }: { onTab: (t: Tab) => void }) {
  const { trades, positions, signals, mode, scheme, settings, setSettings, topUp, balance, feed, link, demo, can, busy } = useApp();
  // Подписка живёт на уровне экрана, а не в каждой карточке: шесть карточек
  // подняли бы шесть одинаковых подписок на один и тот же тикер.
  // Монеты для потока котировок берём из ЖИВОЙ ленты, а не из списка в коде.
  // Открыты вне Telegram и без билета — данные взять неоткуда, и сказать об
  // этом надо прямо: человек пришёл сюда за своим счётом.
  const webNoKey = !inTelegram && !hasSession();
  const sigSymbols = useMemo(() => [...new Set(signals.map((s) => s.symbol))], [signals]);
  const sigTicks = useTickers(sigSymbols);
  const [period, setPeriod] = useState<Period>("w");
  const [detail, setDetail] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [showAddHome, setShowAddHome] = useState(!homeCardHidden());
  const { closeAllPositions } = useApp();

  const stat = useMemo(() => {
    const days = PERIODS.find((p) => p.id === period)!.days;
    const from = Date.now() - days * 864e5;
    const rows = trades.filter((t) => t.closedAt >= from);
    const wins = rows.filter((r) => r.pnl > 0);
    const loss = rows.filter((r) => r.pnl < 0);
    const gross = wins.reduce((s, r) => s + r.pnl, 0);
    const lost = Math.abs(loss.reduce((s, r) => s + r.pnl, 0));
    const fee = rows.reduce((s, r) => s + r.fee, 0);
    const vol = rows.reduce((s, r) => s + Math.abs(r.entry * 1) * 0 + 250, 0);
    return {
      n: rows.length, wins: wins.length, loss: loss.length,
      net: +(gross - lost).toFixed(2), gross: +gross.toFixed(2), lost: +lost.toFixed(2),
      fee: +fee.toFixed(2), vol, r: +rows.reduce((s, x) => s + x.r, 0).toFixed(2),
      wr: rows.length ? Math.round((wins.length / (wins.length + loss.length)) * 100) : 0,
    };
  }, [trades, period]);

  // «В рынке» — только реально открытые. Непролившаяся лимитка позицией не
  // является: считая её, мы обещали бы плавающий результат по сделке, которой
  // ещё нет.
  const live = positions.filter(isOpen);
  const waiting = positions.length - live.length;
  const floating = live.reduce((s, p) => s + posPnl(p).usd, 0);

  return (
    <div className="pb-2">
      <Title sub="Автотрейд · Bybit">Главная</Title>

      {/* ── Финансовый результат ───────────────────────────────────────────── */}
      <div className="px-4" data-coach="pnl">
        <Press onClick={() => setDetail(true)} className="block w-full" scale={0.975} feel="press">
          <Glass className="p-5 overflow-hidden">
            <Aurora />
            {/* Контент поднят над сиянием: z-10 на обёртке, а не на каждой строке. */}
            <div className="relative z-10">
            <div className="flex items-start justify-between gap-3">
              <span className="text-[13px] font-medium uppercase tracking-wide"
                    style={{ color: "var(--label-2)" }}>Результат</span>
              <span className="flex items-center gap-1 text-[13px]" style={{ color: "var(--label-2)" }}>
                подробнее <ChevronRight size={14} />
              </span>
            </div>

            <motion.div key={stat.net} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                        className="num-hero mt-2" style={{ color: tone(stat.net) }}>
              {money(stat.net, true)}
            </motion.div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[14px]"
                 style={{ color: "var(--label-2)" }}>
              <span style={{ color: tone(stat.r) }}>{rr(stat.r)}</span>
              <span>·</span>
              <span>{stat.n} {plural(stat.n, "сделка", "сделки", "сделок")}</span>
              <span>·</span>
              <span>винрейт {stat.wr}%</span>
            </div>

            {(live.length > 0 || waiting > 0) && (
              <div className="mt-3 pt-3 flex items-center justify-between hairline-t">
                <span className="text-[14px]" style={{ color: "var(--label-2)" }}>
                  В рынке сейчас: {live.length}
                  {waiting > 0 && (
                    <span style={{ color: "var(--orange)" }}>
                      {" "}· {waiting} {plural(waiting, "лимитка", "лимитки", "лимиток")} ждёт
                    </span>
                  )}
                </span>
                <span className="text-[15px] font-semibold" style={{ color: tone(floating) }}>
                  {money(floating, true)}
                </span>
              </div>
            )}
            </div>
          </Glass>
        </Press>

        <div className="mt-3">
          <Segmented value={period} onChange={setPeriod}
                     options={PERIODS.map((p) => ({ id: p.id, label: p.label }))} />
        </div>
      </div>

      {/* ── Быстрые действия ───────────────────────────────────────────────── */}
      <GroupLabel>Быстрые действия</GroupLabel>
      <div className="px-4 grid grid-cols-3 gap-2.5" data-coach="quick">
        <QuickAction
          icon={settings.enabled ? <Pause size={19} /> : <Play size={19} />}
          label={settings.enabled ? "Пауза" : "Запустить"} locked={!can.control}
          disabled={busy === "enabled"}
          tint={settings.enabled ? "var(--orange)" : "var(--green)"}
          onClick={() => setSettings({ enabled: !settings.enabled })} />
        <QuickAction icon={<OctagonX size={19} />} label="Закрыть всё" tint="var(--red)" locked={!can.control}
                     onClick={() => setConfirmAll(true)} disabled={!positions.length} />
        <QuickAction icon={<Plus size={19} />} label="Пополнить" tint="var(--tint)"
                     onClick={() => topUp(50)} />
      </div>

      {/* Три РАЗНЫХ состояния, и путать их нельзя: демо — данные учебные;
          denied — бот жив, но доступ не ваш; down — бот не отвечает, и цифры
          на экране последние известные, а не текущие. */}
      {/* Вне Telegram и без подключения показывать плашку «демо» мало — надо
          дать способ это исправить, не возвращаясь в мессенджер. */}
      {demo && !inTelegram && !hasApi && <ConnectCard />}

      {demo && (hasApi || inTelegram) && (
        <div className="px-4 mt-3">
          <Glass flat className="p-3.5 flex items-center gap-3">
            <FlaskConical size={20} style={{ color: "var(--tint)" }} />
            {/* Три разные причины демо-режима, и лечатся они по-разному.
                Общая фраза «показаны учебные данные» оставляла человека гадать,
                что именно сломалось. */}
            <div className="text-[14px] leading-snug">
              {link === "denied"
                ? "Бот не признал вас владельцем счёта — показаны учебные данные."
                : webNoKey
                  ? "Приложение открыто без ключа доступа, поэтому данные учебные. "
                    + "Откройте мини-апп в Telegram и добавьте ярлык заново — ссылка обновится."
                  : "Демонстрация на учебных данных. Цены монет настоящие, сделки — нет."}
            </div>
          </Glass>
        </div>
      )}

      {/* Вошли, данные настоящие — но счёт не ваш, и потому всё по нулям.
          Без этой строки человек видит пустой экран и читает его как поломку
          или как «демо-версию»: ровно та жалоба, с которой это и нашлось. */}
      {!demo && link === "ok" && !can.control && (
        <div className="px-4 mt-3">
          <Glass flat className="p-3.5 flex items-start gap-3">
            <Lock size={20} className="mt-0.5 shrink-0" style={{ color: "var(--label-2)" }} />
            <div className="text-[14px] leading-snug">
              Вы вошли как пользователь — торговый счёт принадлежит владельцу,
              поэтому позиций и истории здесь нет.
              <div className="text-[12px] mt-1" style={{ color: "var(--label-2)" }}>
                Доступ к счёту открывается по подтверждённому номеру телефона.
                Кабинет → «Проверка связи» покажет, что именно не так.
              </div>
            </div>
          </Glass>
        </div>
      )}

      {link === "down" && (
        <div className="px-4 mt-3">
          <Glass flat className="p-3.5 flex items-start gap-3">
            <ServerCrash size={20} className="mt-0.5 shrink-0" style={{ color: "var(--orange)" }} />
            <div className="text-[14px] leading-snug">
              Бот не отвечает.
              {apiRemembered ? (
                /* Публичный адрес бота живёт до перезапуска тоннеля. Ярлык,
                   сохранённый вчера, сегодня может смотреть в пустоту — и это
                   надо сказать прямо, а не оставлять человека с «не
                   отвечает». */
                <span> Возможно, сменился его адрес: откройте мини-апп
                  в Telegram и добавьте ярлык заново — ссылка обновится.</span>
              ) : <span> Показано последнее известное состояние счёта.</span>}
            </div>
          </Glass>
        </div>
      )}

      {/* Связь с биржей потеряна — говорим об этом прямо. Молча показывать
          последнюю известную цену как текущую нельзя: человек примет решение
          по числу, которого на рынке уже нет. */}
      {feed === "offline" && (
        <div className="px-4 mt-3">
          <Glass flat className="p-3.5 flex items-center gap-3">
            <WifiOff size={20} style={{ color: "var(--orange)" }} />
            <div className="text-[14px] leading-snug">
              Нет связи с биржей — цены на экране могли устареть. Переподключаемся.
            </div>
          </Glass>
        </div>
      )}

      {/* Пауза приёма — состояние ЧУЖОГО счёта для того, кто им не управляет:
          показывать её как свою значит объяснять человеку, почему у него нет
          сделок, причиной, к которой он не имеет отношения. */}
      {!settings.enabled && can.control && (
        <div className="px-4 mt-3">
          <Glass flat className="p-3.5 flex items-center gap-3">
            <ShieldAlert size={20} style={{ color: "var(--orange)" }} />
            <div className="text-[14px] leading-snug">
              Приём сигналов на паузе. Открытые позиции продолжают вестись.
            </div>
          </Glass>
        </div>
      )}

      {/* Приглашение вынести приложение на рабочий стол. Показывается ПОСЛЕ
          онбординга и убирается навсегда, как только человек им занялся. */}
      {showAddHome && <AddToHomeCard onDone={() => setShowAddHome(false)} />}

      {/* ── Последние сигналы ──────────────────────────────────────────────── */}
      <GroupLabel>Последние сигналы</GroupLabel>
      <div className="scroll flex gap-2.5 px-4 pb-1" style={{ overflowX: "auto" }} data-coach="signals">
        {signals.length
          ? signals.map((s) => <SignalCard key={s.id} s={s} tk={sigTicks[s.symbol]} />)
          : (
            /* Пусто — это нормальное состояние, а не ошибка: бот ждёт сигнал.
               Молчаливая пустая полоса читалась бы как поломка. */
            <Glass flat className="p-4 w-full text-center">
              <div className="text-[14px]" style={{ color: "var(--label-2)" }}>
                Сигналов пока нет — бот ждёт скринер
              </div>
            </Glass>
          )}
      </div>

      {/* ── Сводка по счёту ────────────────────────────────────────────────
          Раньше здесь лежала лента выдуманных новостей. Новостей у нас нет и
          брать их неоткуда, а место занимала имитация. Показываем то, что
          система про себя знает: режим счёта, схему выхода, риск. */}
      <GroupLabel>Сводка</GroupLabel>
      <div className="px-4 space-y-2.5">
        <Glass flat className="p-3.5 flex items-start gap-3">
          <span className="flex items-center justify-center w-8 h-8 rounded-[9px] shrink-0"
                style={{ background: "var(--label-3)" }}><Cpu size={16} /></span>
          <div className="min-w-0">
            <div className="text-[15px] leading-snug">
              Счёт {mode === "live" ? "боевой — торгуем реальными деньгами"
                                    : "демо — сделки настоящие, деньги виртуальные"}
            </div>
            <div className="text-[12px] mt-1" style={{ color: "var(--label-2)" }}>
              риск ${settings.riskUsd} на сделку{scheme?.long ? ` · выход: ${scheme.long}` : ""}
            </div>
          </div>
        </Glass>
        <Glass flat className="p-3.5 flex items-start gap-3">
          <span className="flex items-center justify-center w-8 h-8 rounded-[9px] shrink-0"
                style={{ background: "var(--label-3)" }}><Radio size={16} /></span>
          <div className="min-w-0">
            <div className="text-[15px] leading-snug">
              {settings.enabled ? "Приём сигналов включён" : "Приём сигналов на паузе"}
            </div>
            <div className="text-[12px] mt-1" style={{ color: "var(--label-2)" }}>
              открытых позиций: {live.length}
              {waiting > 0 ? ` · лимиток в ожидании: ${waiting}` : ""}
            </div>
          </div>
        </Glass>
      </div>

      <div className="px-4 mt-4">
        <Press onClick={() => onTab("trades")} className="block w-full">
          <Glass flat className="p-3.5 flex items-center justify-between">
            <span className="text-[15px]">Вся история сделок</span>
            <ChevronRight size={18} style={{ color: "var(--label-2)" }} />
          </Glass>
        </Press>
      </div>

      {/* ── Шторка с разбивкой ─────────────────────────────────────────────── */}
      <Sheet open={detail} onClose={() => setDetail(false)} title="Разбивка результата">
        <div className="pb-2">
          <div className="num-hero mb-1" style={{ color: tone(stat.net) }}>{money(stat.net, true)}</div>
          <div className="text-[14px] mb-4" style={{ color: "var(--label-2)" }}>
            {PERIODS.find((p) => p.id === period)!.label.toLowerCase()} · {stat.n} {plural(stat.n, "сделка", "сделки", "сделок")}
          </div>
          <Glass flat className="overflow-hidden">
            <Row title="Прибыль по выигрышам" right={<b style={{ color: "var(--green)" }}>{money(stat.gross, true)}</b>} />
            <Row title="Убыток по проигрышам" right={<b style={{ color: "var(--red)" }}>−${stat.lost.toFixed(2)}</b>} />
            <Row title="Чистыми" right={<b style={{ color: tone(stat.net) }}>{money(stat.net, true)}</b>} />
            <Row title="Комиссии биржи" note="уже вычтены из результата"
                 right={<>уплачено ${stat.fee.toFixed(2)}</>} />
            <Row title="Оборот торгов" right={<>${stat.vol.toLocaleString("ru-RU")}</>} />
            <Row title="Успешных / убыточных"
                 right={<><span style={{ color: "var(--green)" }}>{stat.wins}</span> / <span style={{ color: "var(--red)" }}>{stat.loss}</span></>} />
            <Row last title="Свободно на счёте бота" right={<>${balance.toFixed(2)}</>} />
          </Glass>
          <p className="text-[13px] mt-3 leading-snug" style={{ color: "var(--label-2)" }}>
            Комиссия сервиса считается только с прибыльного PnL и выставляется раз в неделю.
            Открытые позиции в расчёт не входят — у них ещё нет результата.
          </p>
        </div>
      </Sheet>

      <Modal open={confirmAll} onClose={() => setConfirmAll(false)}>
        <div className="text-center">
          <div className="mx-auto mb-3 flex items-center justify-center w-12 h-12 rounded-full"
               style={{ background: "color-mix(in srgb, var(--red) 18%, transparent)" }}>
            <OctagonX size={24} style={{ color: "var(--red)" }} />
          </div>
          <h3 className="text-[19px] font-bold">Закрыть все позиции?</h3>
          <p className="text-[14px] mt-1.5 leading-snug" style={{ color: "var(--label-2)" }}>
            {positions.length} {plural(positions.length, "позиция", "позиции", "позиций")} закроются по рынку
            прямо сейчас. Плавающий результат {money(floating, true)} зафиксируется.
          </p>
          <div className="flex gap-2.5 mt-5">
            <Press onClick={() => setConfirmAll(false)} className="flex-1">
              <div className="glass glass-flat py-3 text-center text-[16px] font-medium">Отмена</div>
            </Press>
            <Press feel="heavy" className="flex-1"
                   onClick={() => { closeAllPositions(); setConfirmAll(false); }}>
              <div className="py-3 rounded-[16px] text-center text-[16px] font-semibold text-white"
                   style={{ background: "var(--red)" }}>Закрыть всё</div>
            </Press>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** locked — действие существует у бота, но мини-апп его не выполняет: API
 *  работает только на чтение. Кнопка остаётся видимой (человек должен знать,
 *  что такое действие есть) и объясняет, где его искать. Молча ничего не
 *  делающая кнопка была бы хуже отсутствующей. */
function QuickAction({ icon, label, tint, onClick, disabled, locked }: {
  icon: React.ReactNode; label: string; tint: string; onClick: () => void;
  disabled?: boolean; locked?: boolean;
}) {
  const [hint, setHint] = useState(false);
  return (
    <>
      <Press onClick={() => (locked ? (haptic.warn(), setHint(true)) : onClick())}
             disabled={disabled} feel="press" className="block">
        <Glass flat className="py-3.5 flex flex-col items-center gap-1.5 relative">
          <span style={{ color: locked ? "var(--label-2)" : tint }}>{icon}</span>
          <span className="text-[12px] font-medium leading-none">{label}</span>
          {locked && (
            <Lock size={11} className="absolute top-2 right-2" style={{ color: "var(--label-3)" }} />
          )}
        </Glass>
      </Press>
      <Modal open={hint} onClose={() => setHint(false)}>
        <div className="text-center">
          <div className="mx-auto mb-3 flex items-center justify-center w-12 h-12 rounded-full"
               style={{ background: "var(--label-3)" }}>
            <Lock size={22} style={{ color: "var(--label-2)" }} />
          </div>
          <h3 className="text-[19px] font-bold">Доступно владельцу счёта</h3>
          <p className="text-[14px] mt-1.5 leading-snug" style={{ color: "var(--label-2)" }}>
            «{label}» управляет торговым счётом бота. Вы видите его состояние, но
            распоряжаться им может только владелец.
          </p>
          <Press onClick={() => setHint(false)} className="block w-full mt-5">
            <div className="py-3 rounded-[16px] text-center text-[16px] font-semibold text-white"
                 style={{ background: "var(--tint-grad)" }}>Понятно</div>
          </Press>
        </div>
      </Modal>
    </>
  );
}

function SignalCard({ s, tk }: { s: M.Signal; tk?: Ticker }) {
  const up = s.side === "long";
  return (
    <Glass flat className="p-3.5 shrink-0" >
      <div className="flex items-center gap-2">
        <span className="flex items-center justify-center w-6 h-6 rounded-full"
              style={{ background: `color-mix(in srgb, ${up ? "var(--green)" : "var(--red)"} 18%, transparent)` }}>
          {up ? <TrendingUp size={14} style={{ color: "var(--green)" }} />
              : <TrendingDown size={14} style={{ color: "var(--red)" }} />}
        </span>
        <span className="text-[15px] font-semibold tracking-tight">{s.symbol.replace("USDT", "")}</span>
      </div>
      {/* Цена монеты сейчас — настоящая, с той же биржи, где стоит позиция. */}
      <div className="flex items-baseline gap-1.5 mt-1.5">
        <span className="text-[13px] font-semibold tabular-nums">{tk ? price(tk.last) : "—"}</span>
        {tk && (
          <span className="text-[11px] font-semibold"
                style={{ color: tk.pct24h >= 0 ? "var(--green)" : "var(--red)" }}>{pct(tk.pct24h)}</span>
        )}
      </div>
      <div className="text-[12px] mt-1" style={{ color: "var(--label-2)" }}>{s.phase}</div>
      <div className="flex items-center gap-1.5 mt-2">
        <span className="px-1.5 py-0.5 rounded-md text-[11px] font-semibold"
              style={{ background: "var(--label-3)" }}>{s.score}</span>
        <span className="flex items-center gap-1 text-[11px]" style={{ color: "var(--label-2)" }}>
          <Radio size={10} /> {s.status}
        </span>
      </div>
      <div className="text-[11px] mt-1.5" style={{ color: "var(--label-3)" }}>{ago(s.at)}</div>
    </Glass>
  );
}
