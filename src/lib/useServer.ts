/**
 * Опрос бота. Состояние и позиции — часто, журнал — редко: он меняется только
 * когда сделка закрывается, а весит больше всего.
 *
 * Живая ЦЕНА позиций сюда не входит вовсе: она приходит прямо с биржи по
 * вебсокету (useMarket). Гонять тики через сервер значило бы добавить к ним
 * задержку опроса и нагрузить бота работой, которую браузер делает сам.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getMe, getPayments, getPositions, getSignals, getState, getTrades,
         hasApi, type ApiMe, type ApiPayment, type ApiPosition, type ApiSignal,
         type ApiState, type ApiTrade } from "./api";

const STATE_MS = 5000;
const TRADES_MS = 60000;

export type Link = "off" | "loading" | "ok" | "denied" | "down";

export type Server = {
  link: Link;
  me: ApiMe | null;
  state: ApiState | null;
  positions: ApiPosition[];
  trades: ApiTrade[];
  signals: ApiSignal[];
  payments: ApiPayment[];
  reload: () => void;
};

export function useServer(): Server {
  const [link, setLink] = useState<Link>(hasApi ? "loading" : "off");
  const [me, setMe] = useState<ApiMe | null>(null);
  const [state, setState] = useState<ApiState | null>(null);
  const [positions, setPositions] = useState<ApiPosition[]>([]);
  const [trades, setTrades] = useState<ApiTrade[]>([]);
  const [signals, setSignals] = useState<ApiSignal[]>([]);
  const [payments, setPayments] = useState<ApiPayment[]>([]);
  const denied = useRef(false);

  const pull = useCallback(async (withTrades: boolean) => {
    if (!hasApi || denied.current) return;
    try {
      const [m, s, p, sig] = await Promise.all([getMe(), getState(), getPositions(),
                                                getSignals()]);
      setMe(m);
      setState(s);
      setPositions(p.positions);
      setSignals(sig.signals);
      if (withTrades) {
        const [t, pay] = await Promise.all([getTrades(0), getPayments()]);
        setTrades(t.trades);
        setPayments(pay.payments);
      }
      setLink("ok");
    } catch (e) {
      // Отказ в доступе — состояние постоянное: повторять его каждые пять
      // секунд бессмысленно и только жжёт батарею. Сетевой сбой — временный,
      // его продолжаем перепроверять.
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        denied.current = true;
        setLink("denied");
      } else setLink("down");
    }
  }, []);

  useEffect(() => {
    if (!hasApi) return;
    pull(true);
    const a = setInterval(() => pull(false), STATE_MS);
    const b = setInterval(() => pull(true), TRADES_MS);
    // Вкладку свернули — опрос останавливаем: обновлять невидимый экран не для
    // кого, а вернувшись, мы всё равно тянем свежее.
    const vis = () => { if (document.visibilityState === "visible") pull(true); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(a); clearInterval(b); document.removeEventListener("visibilitychange", vis); };
  }, [pull]);

  return { link, me, state, positions, trades, signals, payments,
           reload: () => pull(true) };
}
