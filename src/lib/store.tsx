import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import * as M from "./mock";
import { useFeed, useTickers } from "./useMarket";
import type { Feed } from "./market";
import { hasApi, type ApiPosition, type ApiTrade } from "./api";
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
  updateLevels: (id: string, tp: number, sl: number) => void;
  feed: Feed;               // связь с рынком: live / connecting / offline
  marketReady: boolean;     // пришла ли настоящая цена хотя бы по одной монете
  link: Link;               // связь с ботом: off (демо) / ok / denied / down
  demo: boolean;            // данные показываются учебные, а не со счёта

  trades: M.Trade[];
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
    status: p.status,
  };
}

function toTrade(t: ApiTrade): M.Trade {
  return {
    id: t.id, symbol: t.symbol, side: t.side, entry: t.entry, exit: t.exit,
    pnl: t.pnl, r: t.r, reason: t.reason, closedAt: t.closedAt || 0,
    heldMin: t.heldMin, fee: t.fee, mfe: t.mfe, mae: t.mae, scheme: t.scheme,
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
  const [balance, setBalance] = useState(38.4);
  const [owed, setOwed] = useState(4.31);
  const [sub, setSub] = useState<Ctx["sub"]>({ active: true, until: Date.now() + 61 * 864e5, plan: "3 месяца" });
  const [api, setApi] = useState({ connected: true, key: "kQ7f••••••••••••3xZa", secret: "••••••••••••••••" });
  const [closed, setClosed] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, { tp: number; sl: number }>>({});
  const server = useServer();
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
      return { ...base, mark, ...(ov ? { tp: ov.tp, sl: ov.sl } : {}) };
    });
  }, [demo, server.positions, specs, anchors, ticks, overrides]);

  const trades = useMemo(
    () => (demo ? M.trades : server.trades.map(toTrade)), [demo, server.trades]);

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

  const blocked = owed > balance;
  const riskAlert = shown.riskUsd > deposit * 0.05;

  const value: Ctx = {
    stage, setStage,
    user, setUser: (u) => setUserRaw((p) => ({ ...p, ...u })),
    balance, inPositions, deposit, owed, blocked,
    payOwed: () => { setBalance((b) => +(b - owed).toFixed(2)); setOwed(0); },
    topUp: (v) => setBalance((b) => +(b + v).toFixed(2)),
    sub, buyPlan: (id) => {
      const p = M.PLANS.find((x) => x.id === id);
      if (!p) return;
      setSub({ active: true, plan: p.label, until: Date.now() + p.months * 30 * 864e5 });
    },
    api,
    connectApi: (key, secret) =>
      setApi({ connected: true, key: key.slice(0, 4) + "••••••••••••" + key.slice(-4), secret: "••••••••••••••••" }),
    disconnectApi: () => setApi({ connected: false, key: "", secret: "" }),
    settings: shown, setSettings: (p) => setSettingsRaw((s) => ({ ...s, ...p })),
    positions, feed, marketReady, link: server.link, demo,
    closePosition: (id) => setClosed((c) => [...c, id]),
    updateLevels: (id, tp, sl) => setOverrides((o) => ({ ...o, [id]: { tp, sl } })),
    trades, riskAlert,
  };
  return <C.Provider value={value}>{children}</C.Provider>;
}

/** PnL позиции в долларах и в R — одна формула на весь интерфейс. */
export function posPnl(p: M.Position) {
  const d = p.side === "long" ? p.mark - p.entry : p.entry - p.mark;
  const rDist = Math.abs(p.entry - p.sl);
  return { usd: d * p.size, r: rDist ? d / rDist : 0, pct: (d / p.entry) * 100 * p.lev };
}
