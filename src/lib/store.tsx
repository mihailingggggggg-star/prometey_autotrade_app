import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import * as M from "./mock";
import { useFeed, useTickers } from "./useMarket";
import type { Feed } from "./market";
import * as API from "./api";
import { hasApi, type ApiMe, type ApiPosition, type ApiTrade } from "./api";
import { useServer, type Link } from "./useServer";

export type Stage = "auth" | "onboarding" | "app";

export type Settings = {
  enabled: boolean;
  riskUsd: number;
  maxOpen: number;
  allowLong: boolean;
  allowShort: boolean;
  whaleOnly: boolean;
  leverageMode: "max" | "fixed";
  leverage: number;
  limitTtlMin: number;
  tpMode: "single" | "ladder";
  tpR: number;
  beR: number | null;
};

type Ctx = {
  stage: Stage; setStage: (s: Stage) => void;
  user: { name: string; email: string; phone: string };
  setUser: (u: Partial<Ctx["user"]>) => void;

  balance: number;          // свободные средства на счёте бота
  inPositions: number;      // заблокировано в позициях
  deposit: number;          // депозит на бирже (для проверки риска)
  owed: number;             // комиссия к оплате за неделю
  blocked: boolean;         // сделки заблокированы из-за долга
  payOwed: () => void;
  topUp: (v: number) => void;

  sub: { active: boolean; until: number | null; plan: string | null };
  buyPlan: (id: string) => void;

  api: { connected: boolean; key: string; secret: string };
  connectApi: (key: string, secret: string) => void;
  disconnectApi: () => void;

  settings: Settings; setSettings: (p: Partial<Settings>) => void;

  positions: M.Position[];
  closePosition: (id: string) => void;
  closeAllPositions: () => void;
  /** Возврат — удалось ли. Интерфейс показывает новый уровень СРАЗУ, не
   *  дожидаясь сервера, и ему нужно знать, когда откатить показанное обратно. */
  updateLevels: (id: string, tp: number, sl: number) => Promise<boolean>;
  /** Перенести цену неисполненной лимитки (у открытой позиции входа уже нет). */
  moveEntry: (id: string, entry: number) => Promise<boolean>;
  feed: Feed;               // связь с рынком: live / connecting / offline
  marketReady: boolean;     // пришла ли настоящая цена хотя бы по одной монете
  mode: "demo" | "live";    // счёт бота: демо или реальные деньги
  /** Текущая схема выхода словами — так же, как её печатает панель бота. */
  scheme: { long: string; short: string } | null;
  link: Link;               // связь с ботом: off (демо) / ok / denied / down
  demo: boolean;            // данные показываются учебные, а не со счёта
  me: ApiMe | null;         // профиль с сервера
  /** Пройдена ли регистрация. Отдельно от `me.phoneOk`, потому что СТАРЫЙ бот
   *  такого поля не отдаёт вовсе: интерфейс на Pages обновляется мгновенно, а
   *  сервер — руками, и между этими моментами человек не должен оказаться
   *  заперт на экране регистрации, которую нечем пройти. */
  registered: boolean;
  /** Права приходят С СЕРВЕРА и не выводятся из роли на клиенте: решение о
   *  том, кому что можно, принимается в одном месте — там, где деньги. */
  can: { control: boolean; topupFree: boolean; demo: boolean };
  /** Действие ушло на сервер и вернулось. Текст ошибки показываем как есть:
   *  «не получилось» без причины заставляет гадать. */
  act: (name: string, run: () => Promise<unknown>) => Promise<boolean>;
  setMode: (m: "demo" | "live") => void;
  setScheme: (side: "long" | "short",
              scheme: { legs: { r: number; pct: number }[]; be_r: number | null } | null) => void;
  saveProfile: (email: string, phone: string) => Promise<boolean>;
  busy: string;             // какое действие сейчас выполняется
  refresh: () => void;      // перечитать состояние с сервера
  linkKeys: () => Promise<boolean>;
  error: string;            // последняя ошибка действия
  clearError: () => void;

  trades: M.Trade[];
  signals: M.Signal[];
  payments: M.Payment[];
  riskAlert: boolean;       // риск > 5% депозита
};

/* Ряды бота → модели экранов. Отдельными функциями, а не «типы совпадают,
   сойдёт»: у сервера полей больше, часть из них (slPlan, hits, entryType)
   экранам не нужна, а be приходит null вместо отсутствия. */
function toPosition(p: ApiPosition, mark: number): M.Position {
  return {
    id: p.id, symbol: p.symbol, side: p.side, lev: p.lev,
    entry: p.entry, mark: mark || p.mark || p.entry,
    sl: p.sl, tp: p.tp, tps: p.tps, be: p.be ?? undefined,
    size: p.size, risk: p.risk, openedAt: p.openedAt, scheme: p.scheme,
    status: p.status, entryType: p.entryType, upl: p.upl, source: p.source,
    /* Номинал пересчитываем по ЖИВОЙ цене из потока Bybit: серверный считался
       на момент опроса, а цена с тех пор ушла. Маржа — как пришла: она
       заморожена на бирже и от тика не меняется. */
    notional: (p.size || 0) * (mark || p.mark || p.entry) || p.notional,
    margin: p.margin, marginFrom: p.marginFrom,
  };
}

function toTrade(t: ApiTrade): M.Trade {
  return {
    id: t.id, symbol: t.symbol, side: t.side, entry: t.entry, exit: t.exit,
    pnl: t.pnl, r: t.r, reason: t.reason, closedAt: t.closedAt || 0,
    heldMin: t.heldMin, fee: t.fee, mfe: t.mfe, mae: t.mae, scheme: t.scheme,
    source: t.source,
  };
}

const C = createContext<Ctx | null>(null);
export const useApp = () => {
  const v = useContext(C);
  if (!v) throw new Error("useApp вне провайдера");
  return v;
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<Stage>("auth");
  const [user, setUserRaw] = useState({ name: "", email: "", phone: "" });
  const [localBalance, setBalance] = useState(38.4);
  const [localOwed, setOwed] = useState(4.31);
  const [sub, setSub] = useState<Ctx["sub"]>({ active: true, until: Date.now() + 61 * 864e5, plan: "3 месяца" });
  const [api, setApi] = useState({ connected: true, key: "kQ7f••••••••••••3xZa", secret: "••••••••••••••••" });
  const [closed, setClosed] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, { tp: number; sl: number }>>({});
  const [entries, setEntries] = useState<Record<string, number>>({});
  const server = useServer();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  /* Одна обёртка на все действия: блокировка кнопки, разбор ошибки и
     немедленная дозагрузка состояния. Последнее важнее прочего — сервер мог
     применить не то, что мы просили (проверка диапазонов), и верить своему
     представлению о результате нельзя. */
  const act = async (name: string, run: () => Promise<unknown>) => {
    setBusy(name); setError("");
    try {
      await run();
      server.reload();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy("");
    }
  };
  const [settings, setSettingsRaw] = useState<Settings>({
    enabled: true, riskUsd: 10, maxOpen: 3, allowLong: true, allowShort: true,
    whaleOnly: false, leverageMode: "max", leverage: 20, limitTtlMin: 240,
    tpMode: "single", tpR: 1.5, beR: 1,
  });



  /* ── Живой рынок ───────────────────────────────────────────────────────────
     Цена приходит с биржи (тикеры Bybit по WS), а не выдумывается таймером.
     Позиция собирается ВОКРУГ этой цены: вход отматывается назад на заданное
     число R, стоп и цель раскладываются от входа. Поэтому PnL шевелится от
     настоящих тиков и остаётся правдоподобным по величине.

     Якорь ставится ОДИН раз — первой пришедшей ценой. Пересобирай мы вход на
     каждом тике, цена всегда стояла бы ровно на месте входа и PnL навсегда
     замер бы на нуле: сделка обязана иметь прошлое. */
  const feed = useFeed();
  const demo = !hasApi || server.link === "denied";

  /* Демо-режим: позиции собираются вокруг живой цены (см. mock.buildPosition).
     Боевой режим: позиции приходят от бота как есть — с настоящим входом,
     стопом, ступенями и размером, а живая цена по-прежнему берётся с биржи
     напрямую, а не опросом сервера. */
  const specs = useMemo(
    () => (demo ? M.posSpecs.filter((x) => !closed.includes(x.id)) : []), [demo, closed]);

  const symbols = useMemo(
    () => (demo ? specs.map((x) => x.symbol) : server.positions.map((p) => p.symbol)),
    [demo, specs, server.positions]);
  const ticks = useTickers(symbols);
  const [anchors, setAnchors] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!demo) return;
    setAnchors((a) => {
      const add: Record<string, number> = {};
      specs.forEach((x) => {
        const px = ticks[x.symbol]?.last;
        if (px && !a[x.id]) add[x.id] = px;
      });
      return Object.keys(add).length ? { ...a, ...add } : a;
    });
  }, [demo, ticks, specs]);

  const marketReady = symbols.some((sym) => !!ticks[sym]?.last);

  const positions = useMemo(() => {
    if (!demo) {
      // Бот отдаёт marks с биржи раз в несколько секунд, а вебсокет — каждый
      // тик. Берём вебсокетную, серверная остаётся запасной.
      return server.positions.map((p) => toPosition(p, ticks[p.symbol]?.last || 0));
    }
    return specs.map((x) => {
      const base = M.buildPosition(x, anchors[x.id] || x.fallback);
      const mark = ticks[x.symbol]?.last || base.mark;
      const ov = overrides[x.id];
      const notional = base.size * mark;
      return { ...base, mark, notional, margin: notional / base.lev, marginFrom: "расчёт",
               ...(entries[x.id] ? { entry: entries[x.id] } : {}),
               ...(ov ? { tp: ov.tp, sl: ov.sl } : {}) };
    });
  }, [demo, server.positions, specs, anchors, ticks, overrides, entries]);

  const trades = useMemo(
    () => (demo ? M.trades : server.trades.map(toTrade)), [demo, server.trades]);

  /* Лента сигналов и платежи тоже приходят из БД бота. Раньше их изображали
     списки в коде — то есть у денег не было ни истории, ни источника правды,
     а «последние сигналы» не имели отношения к тому, что бот торговал. */
  const signals = useMemo<M.Signal[]>(() => demo ? M.signals : server.signals.map((s) => ({
    id: s.id, symbol: s.symbol, side: s.side, score: s.score, at: s.at,
    status: s.status as M.Signal["status"],
    phase: s.source === "algo" ? "алгос"
         : s.whale ? "кит" : s.entryType === "limit" ? "лимитка" : "по рынку",
  })), [demo, server.signals]);

  const payments = useMemo<M.Payment[]>(() => demo ? M.payments : server.payments.map((p) => ({
    id: p.id, at: p.at, kind: p.kind as M.Payment["kind"], amount: p.amount,
    note: p.note, status: p.status as M.Payment["status"],
  })), [demo, server.payments]);

  const inPositions = useMemo(
    () => positions.reduce((s, p) => s + (p.size * p.entry) / p.lev, 0), [positions]);

  /* Депозит — настоящий капитал счёта, когда бот на связи. От него считается
     предупреждение «риск больше 5%», и на выдуманном числе оно было бы
     бессмысленным. */
  const deposit = server.state?.exchange ? server.state.equity : 1042.8;

  /* Настройки бота показываем ЕГО, а не свои: экран, показывающий риск $10,
     когда в боте стоит $25, опаснее экрана без настроек вовсе. Локальное
     состояние остаётся для демо-режима. */
  const shown: Settings = server.state
    ? { ...settings, enabled: server.state.enabled,
        riskUsd: server.state.settings.riskUsd,
        maxOpen: server.state.settings.maxOpen,
        leverage: server.state.settings.leverage,
        leverageMode: server.state.settings.leverageMode,
        limitTtlMin: server.state.settings.limitTtlMin }
    : settings;

  /* Деньги СЕРВИСА (комиссионный счёт) живут в профиле на сервере. Локальное
     состояние остаётся только для демо-режима, где сервера нет вовсе. */
  const balance = server.me ? (server.me.balance ?? 0) : localBalance;
  const owed = server.me ? (server.me.owed ?? 0) : localOwed;

  const blocked = owed > balance;
  const riskAlert = shown.riskUsd > deposit * 0.05;

  const value: Ctx = {
    stage, setStage,
    user, setUser: (u) => setUserRaw((p) => ({ ...p, ...u })),
    balance, inPositions, deposit, owed, blocked,
    payOwed: () => { setBalance((b) => +(b - owed).toFixed(2)); setOwed(0); },
    /* Пополнение «из воздуха» — привилегия владельца, она для отладки и показа.
       Обычный путь пополнения — перевод USDT, и подтверждает его человек. */
    topUp: (v) => {
      if (demo || !server.me?.can.topupFree) return void setBalance((b) => +(b + v).toFixed(2));
      void act("topup", () => API.topUp(v));
    },
    /* Подписка тоже лежит в БД бота. Показывать локальную заглушку рядом с
       настоящим балансом значит обещать человеку тариф, которого у него нет. */
    sub: server.me
      ? { active: Boolean(server.me.subUntil && server.me.subUntil > Date.now()),
          until: server.me.subUntil ?? null, plan: server.me.subPlan || null }
      : sub,
    buyPlan: (id) => {
      const p = M.PLANS.find((x) => x.id === id);
      if (!p) return;
      setSub({ active: true, plan: p.label, until: Date.now() + p.months * 30 * 864e5 });
    },
    /* Ключи: их состояние знает сервер. Читаем ОСТОРОЖНО, через ?. — сервер
       может оказаться старее интерфейса: Pages обновляется мгновенно, а бот
       руками. Раньше на таком сервере приложение падало целиком, и человек
       видел белый экран вместо недостающего поля. */
    api: server.me
      ? { connected: Boolean(server.me.api?.connected),
          key: server.me.api?.tail ? `••••••••••••${server.me.api.tail}` : "",
          secret: "••••••••••••••••" }
      : api,
    connectApi: (key, secret) =>
      setApi({ connected: true, key: key.slice(0, 4) + "••••••••••••" + key.slice(-4), secret: "••••••••••••••••" }),
    disconnectApi: () => setApi({ connected: false, key: "", secret: "" }),
    settings: shown,
    setSettings: (p) => {
      if (demo) return void setSettingsRaw((s) => ({ ...s, ...p }));
      // Названия полей у бота свои (risk_usd, а не riskUsd): переводим здесь,
      // в одном месте, а не в каждом экране.
      const patch: API.SettingsPatch = {};
      if (p.riskUsd !== undefined) patch.risk_usd = p.riskUsd;
      if (p.maxOpen !== undefined) patch.max_open = p.maxOpen;
      if (p.leverage !== undefined) patch.leverage = p.leverage;
      if (p.leverageMode !== undefined) patch.leverage_mode = p.leverageMode;
      if (p.limitTtlMin !== undefined) patch.limit_ttl_min = p.limitTtlMin;
      if (p.enabled !== undefined) return void act("enabled", () => API.putEnabled(p.enabled!));
      if (Object.keys(patch).length) void act("settings", () => API.putSettings(patch));
    },
    positions, feed, marketReady, link: server.link, demo,
    mode: server.state?.mode ?? "demo",
    scheme: server.state?.scheme ?? null,
    me: server.me,
    registered: server.me
      ? ("phoneOk" in server.me ? Boolean(server.me.phoneOk) : true)
      : false,
    can: server.me?.can
      ? { control: Boolean(server.me.can.control),
          topupFree: Boolean(server.me.can.topupFree),
          demo: Boolean(server.me.can.demo) }
      // Демо-режим: показываем всё, иначе прототип нечем смотреть.
      : { control: demo, topupFree: demo, demo: demo },
    act, busy, error, clearError: () => setError(""),
    refresh: () => server.reload(),
    linkKeys: () => demo ? Promise.resolve(true) : act("keys", () => API.linkKeys()),
    setMode: (m) => { if (!demo) void act("mode", () => API.putMode(m)); },
    setScheme: (side, scheme) => { if (!demo) void act("scheme", () => API.putScheme(side, scheme)); },
    saveProfile: async (email, phone) => {
      setUserRaw((p) => ({ ...p, email, phone }));
      if (demo) return true;
      return act("profile", () => API.putProfile(email, phone));
    },
    closePosition: (id) => {
      if (demo) return void setClosed((c) => [...c, id]);
      void act("close:" + id, () => API.closePosition(id));
    },
    /* Одной командой серверу, а не перебором на клиенте: перебор рвётся
       посередине при первой же ошибке сети, и часть позиций остаётся открытой
       ровно тогда, когда их закрывают — когда что-то идёт не так. */
    closeAllPositions: () => {
      if (demo) return void setClosed((c) => [...c, ...specs.map((x) => x.id)]);
      void act("close_all", () => API.closeAll());
    },
    updateLevels: async (id, tp, sl) => {
      if (demo) { setOverrides((o) => ({ ...o, [id]: { tp, sl } })); return true; }
      return act("levels:" + id, () => API.setLevels(id, tp, sl));
    },
    /* Перенос входа — ТОЛЬКО у лимитки, и только через сервер: там пересчитается
       размер под прежний риск и проверится, что ордер не пересёк рынок. */
    moveEntry: async (id, entry) => {
      if (demo) { setEntries((o) => ({ ...o, [id]: entry })); return true; }
      return act("entry:" + id, () => API.moveEntry(id, entry));
    },
    trades, signals, payments, riskAlert,
  };
  return <C.Provider value={value}>{children}</C.Provider>;
}

/** PnL позиции в долларах и в R — одна формула на весь интерфейс.
 *
 *  У НЕПРОЛИВШЕЙСЯ ЛИМИТКИ PnL НЕ СУЩЕСТВУЕТ. Это ордер, а не позиция: монет
 *  на счёте нет, терять и зарабатывать нечем. Считая его как позицию, мы
 *  брали цену сигнала за цену входа и показывали движение рынка как свой
 *  результат — сделки, которой не было. Отсюда же и «−$4.20» на ряду, по
 *  которому не куплено ни одной монеты. */
export function posPnl(p: M.Position) {
  if (p.status === "pending") return { usd: 0, r: 0, pct: 0, pending: true as const };
  const d = p.side === "long" ? p.mark - p.entry : p.entry - p.mark;
  const rDist = Math.abs(p.entry - p.sl);
  return { usd: d * p.size, r: rDist ? d / rDist : 0, pct: (d / p.entry) * 100 * p.lev,
           pending: false as const };
}

/** В рынке ли позиция. Отдельной функцией, потому что вопрос «сколько у меня
 *  открыто» задаётся в трёх местах и везде должен отвечать одинаково. */
export const isOpen = (p: M.Position) => p.status !== "pending";
