/**
 * Профиль (§9.5): ключи, настройки скринера и демо-движка, демо-баланс и журнал
 * действий.
 *
 * Ключи. Значения НИКОГДА не приходят с сервера — только `set` и `preview`
 * (маска вида «abcd…12»). Поле «Сохранить» отправляет лишь то, что человек
 * реально ввёл: пустое поле означает «не трогать», а не «стереть». Так случайный
 * тап по «Сохранить» не затирает рабочий ключ.
 *
 * Настройки. Ползунок пишет на сервер только на ОТПУСКАНИИ пальца (см. Slider):
 * слать каждый пиксель перетяга — это десятки запросов на одно движение.
 * Локальная копия настроек даёт мгновенную реакцию интерфейса, а истина
 * по-прежнему на сервере (он валидирует диапазоны и пишет в audit).
 */
import { useEffect, useState } from "react";
import { ClipboardList, KeyRound, Save } from "lucide-react";
import {
  addDeposit, analyticsSummary, keysStatus, listAudit, getSettings, updateKeys, updateSettings,
  hasToken, probeAuth, setToken, UnauthorizedError,
} from "../lib/api";
import { useApi } from "../lib/useApi";
import type { KeysUpdate, Settings, SettingsPatch } from "../../shared/types";
import { Press, Title, Toggle } from "../ui/kit";
import { Slider } from "../ui/liquid";
import { ErrorBox, Loading, Panel } from "../ui/states";
import { dt, money } from "../lib/format";

export function Profile({ refreshKey }: { refreshKey: number }) {
  const keys = useApi(keysStatus, 0, [refreshKey]);
  const settings = useApi(getSettings, 0, [refreshKey]);
  const summary = useApi(analyticsSummary, 20000, [refreshKey]);
  const audit = useApi(() => listAudit(20), 20000, [refreshKey]);

  const [draft, setDraft] = useState<Settings | null>(null);
  useEffect(() => { setDraft(settings.data); }, [settings.data]);

  const [fields, setFields] = useState<KeysUpdate>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Ключ доступа к API: сам ключ не показываем — только признак «задан».
  const [apiKey, setApiKey] = useState("");
  const [apiKeySet, setApiKeySet] = useState(hasToken());
  const [apiBusy, setApiBusy] = useState(false);

  const patch = (p: SettingsPatch) => {
    if (!draft) return;
    const merged: Settings = {
      screener: { ...draft.screener, ...(p.screener ?? {}) },
      demo: { ...draft.demo, ...(p.demo ?? {}) },
      free_ride: { ...draft.free_ride, ...(p.free_ride ?? {}) },
    };
    // Цель 2 обязана быть СТРОГО выше триггера фиксации (сервер иначе отклоняет
    // сохранение). Чтобы ползунок «Триггер» не заходил в мёртвую зону, подтягиваем
    // цель 2 вверх здесь же — одним запросом, а не оставляем пользователя с отказом.
    let send: SettingsPatch = p;
    if (merged.free_ride.tp2_percent <= merged.free_ride.tp1_percent) {
      merged.free_ride.tp2_percent = Math.min(
        1000,
        Math.ceil((merged.free_ride.tp1_percent + 1) / 50) * 50, // следующий шаг ползунка цели 2
      );
      send = { ...p, free_ride: { ...(p.free_ride ?? {}), tp2_percent: merged.free_ride.tp2_percent } };
    }
    setDraft(merged);
    // Отказ сервера откатывает черновик к состоянию сервера: клиент не должен
    // показывать одно, пока сервер хранит другое. Текст ошибки — как есть.
    void updateSettings(send).catch((e) => {
      setNotice(e instanceof Error ? e.message : String(e));
      settings.refresh();
    });
  };

  const saveKeys = async () => {
    const body: KeysUpdate = {};
    (Object.keys(fields) as (keyof KeysUpdate)[]).forEach((k) => {
      const v = fields[k]?.trim();
      if (v) body[k] = v;                 // пустое — «не менять»
    });
    if (!Object.keys(body).length) { setNotice("нет новых значений для сохранения"); return; }
    setBusy(true);
    setNotice(null);
    try {
      await updateKeys(body);
      setFields({});
      keys.refresh();
      setNotice("Ключи сохранены");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const deposit = async () => {
    const monthly = draft?.demo.monthly_deposit ?? 500;
    try { await addDeposit(monthly); summary.refresh(); setNotice(`Пополнено на ${money(monthly).replace("+", "")}`); }
    catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
  };

  // Ключ проверяется ДО сохранения: неверный не осядет в хранилище, и опрос
  // тут же снова не поднимет экран «нужен ключ доступа».
  const saveApiKey = async () => {
    const v = apiKey.trim();
    if (!v) { setNotice("введите ключ доступа"); return; }
    setApiBusy(true);
    setNotice(null);
    try {
      await probeAuth(v);
      setToken(v);
      setApiKey("");
      setApiKeySet(true);
      setNotice("Ключ доступа сохранён");
    } catch (e) {
      setNotice(e instanceof UnauthorizedError
        ? "ключ не подошёл — проверьте значение"
        : e instanceof Error ? e.message : String(e));
    } finally {
      setApiBusy(false);
    }
  };

  const s = summary.data;

  return (
    <div className="pb-3">
      <Title sub="ключи, настройки и журнал">Профиль</Title>

      {notice && (
        <div className="mx-5 mb-2 text-[13px] leading-snug px-3 py-2 rounded-[12px]"
             style={{ background: "var(--bg-elev)", color: "var(--label-2)" }}>{notice}</div>
      )}

      {/* ── ДОСТУП К API ── */}
      <div className="px-3 mt-1">
        <Panel title="Доступ к API">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[14px]">Ключ доступа к демо-контуру</span>
            <span className="text-[12px] tabular-nums flex items-center gap-1"
                  style={{ color: apiKeySet ? "var(--green)" : "var(--label-3)" }}>
              {apiKeySet && <KeyRound size={12} />}
              {apiKeySet ? "ключ задан" : "ключ не задан"}
            </span>
          </div>
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                 type="password" autoComplete="off" spellCheck={false}
                 placeholder="введите новый ключ"
                 className="w-full px-3 py-2.5 rounded-[12px] text-[15px] outline-none"
                 style={{ background: "var(--bg-elev)", color: "var(--label)" }} />
          <Press onClick={saveApiKey} disabled={apiBusy} className="block w-full mt-2">
            <div className="flex items-center justify-center gap-2 py-2.5 rounded-[12px] text-[14px] font-semibold"
                 style={{ background: "var(--bg-elev)", opacity: apiBusy ? 0.6 : 1 }}>
              Сохранить ключ
            </div>
          </Press>
          <p className="text-[12px] mt-2 leading-snug" style={{ color: "var(--label-3)" }}>
            Ключ хранится только в этом устройстве и не показывается — виден лишь факт «задан».
          </p>
        </Panel>
      </div>

      {/* ── КЛЮЧИ ── */}
      <div className="px-3 mt-1">
        <Panel title="Ключи и кошелёк">
          {keys.loading && !keys.data && <Loading label="читаем статус ключей…" />}
          {keys.error && <ErrorBox text={keys.error} onRetry={keys.refresh} />}
          {keys.data && (
            <div className="flex flex-col gap-3">
              <KeyField label="Telegram bot token" status={keys.data.telegram_bot_token}
                        value={fields.telegram_bot_token ?? ""}
                        onChange={(v) => setFields((f) => ({ ...f, telegram_bot_token: v }))} />
              <KeyField label="Telegram chat id" status={keys.data.telegram_chat_id}
                        value={fields.telegram_chat_id ?? ""}
                        onChange={(v) => setFields((f) => ({ ...f, telegram_chat_id: v }))} />
              <KeyField label="Helius API key" status={keys.data.helius_api_key}
                        value={fields.helius_api_key ?? ""}
                        onChange={(v) => setFields((f) => ({ ...f, helius_api_key: v }))} />
              <KeyField label="Gemini API key" status={keys.data.gemini_api_key}
                        value={fields.gemini_api_key ?? ""}
                        onChange={(v) => setFields((f) => ({ ...f, gemini_api_key: v }))} />
              <KeyField label="Секрет кошелька" status={keys.data.wallet}
                        hint={keys.data.wallet.address ? `адрес: ${keys.data.wallet.address}` : undefined}
                        value={fields.wallet_secret ?? ""}
                        onChange={(v) => setFields((f) => ({ ...f, wallet_secret: v }))} />

              <Press onClick={saveKeys} disabled={busy} className="block w-full mt-1">
                <div className="flex items-center justify-center gap-2 py-3 rounded-[14px] text-[15px] font-semibold text-white"
                     style={{ background: "var(--tint-grad)", opacity: busy ? 0.6 : 1 }}>
                  <Save size={16} /> Сохранить
                </div>
              </Press>
              <p className="text-[12px] leading-snug" style={{ color: "var(--label-3)" }}>
                Секреты хранятся в .env на сервере и наружу не отдаются — здесь
                видны только маска и отметка «задано».
              </p>
            </div>
          )}
        </Panel>
      </div>

      {/* ── ДЕМО-БАЛАНС ── */}
      <div className="px-3 mt-3">
        <Panel title="Демо-баланс">
          {s ? (
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <div className="text-[26px] font-bold tabular-nums leading-none">
                  {money(s.balance).replace("+", "")}
                </div>
                <div className="text-[12px] mt-1" style={{ color: "var(--label-3)" }}>
                  внесено {money(s.deposited).replace("+", "")} · издержки {money(s.costs_usd).replace("+", "")}
                </div>
              </div>
              <Press onClick={deposit}>
                <div className="px-4 py-2.5 rounded-[12px] text-[14px] font-semibold"
                     style={{ background: "var(--bg-elev)" }}>Пополнить</div>
              </Press>
            </div>
          ) : (
            <Loading label="считаем баланс…" />
          )}
        </Panel>
      </div>

      {/* ── НАСТРОЙКИ СКРИНЕРА ── */}
      <div className="px-3 mt-3">
        <Panel title="Скринер">
          {settings.loading && !draft && <Loading label="читаем настройки…" />}
          {settings.error && <ErrorBox text={settings.error} onRetry={settings.refresh} />}
          {draft && (
            <>
              <Group label="Возраст и ликвидность" open>
                <SliderRow label="Возраст, от" value={draft.screener.age_min} min={0} max={365} step={1}
                           suffix=" дн" onCommit={(v) => patch({ screener: { age_min: v } })} />
                <SliderRow label="Возраст, до" value={draft.screener.age_max} min={1} max={730} step={1}
                           suffix=" дн" onCommit={(v) => patch({ screener: { age_max: v } })} />
                <SliderRow label="Ликвидность, от" value={draft.screener.liq_min} min={0} max={500000} step={1000}
                           fmt={(v) => "$" + v.toLocaleString("ru-RU")} onCommit={(v) => patch({ screener: { liq_min: v } })} />
                <SliderRow label="Ликвидность, до" value={draft.screener.liq_max} min={0} max={2000000} step={5000}
                           fmt={(v) => "$" + v.toLocaleString("ru-RU")} onCommit={(v) => patch({ screener: { liq_max: v } })} />
              </Group>

              <Group label="Концентрация и накопление">
                <SliderRow label="Топ-10 холдеров, не более" value={draft.screener.top10_max} min={1} max={100} step={1}
                           suffix="%" onCommit={(v) => patch({ screener: { top10_max: v } })} />
                <SliderRow label="Коридор накопления, дней" value={draft.screener.range_days} min={1} max={90} step={1}
                           suffix=" дн" onCommit={(v) => patch({ screener: { range_days: v } })} />
                <SliderRow label="Ширина коридора" value={draft.screener.range_pct} min={1} max={100} step={1}
                           suffix="%" onCommit={(v) => patch({ screener: { range_pct: v } })} />
                <SliderRow label="Падение от ATH, от" value={draft.screener.drawdown_min} min={0} max={100} step={1}
                           suffix="%" onCommit={(v) => patch({ screener: { drawdown_min: v } })} />
                <SliderRow label="Падение от ATH, до" value={draft.screener.drawdown_max} min={0} max={100} step={1}
                           suffix="%" onCommit={(v) => patch({ screener: { drawdown_max: v } })} />
                <SliderRow label="Рост холдеров за 7д" value={draft.screener.holders_growth_min} min={0} max={100} step={0.5}
                           suffix="%" onCommit={(v) => patch({ screener: { holders_growth_min: v } })} />
                <SliderRow label="Уникальных мейкеров" value={draft.screener.maker_min} min={0} max={1000} step={10}
                           onCommit={(v) => patch({ screener: { maker_min: v } })} />
                <ToggleRow label="Фильтр накрутки" hint="уникальные мейкеры против ботов"
                           on={draft.screener.wash_filter}
                           onChange={(v) => patch({ screener: { wash_filter: v } })} />
                <ToggleRow label="Фильтр по новостям и упоминаниям"
                           hint="Собирает упоминания в X (Apify) и оценивает интерес; без него слой 5 не проверяется и кредит Apify не тратится"
                           on={draft.screener.llm_filter}
                           onChange={(v) => patch({ screener: { llm_filter: v } })} />
              </Group>
            </>
          )}
        </Panel>
      </div>

      {/* ── ДЕМО-ДВИЖОК И FREE RIDING ── */}
      <div className="px-3 mt-3">
        <Panel title="Демо-движок">
          {draft && (
            <>
              <SliderRow label="Стартовый баланс" value={draft.demo.start_balance} min={0} max={100000} step={50}
                         fmt={(v) => "$" + v.toLocaleString("ru-RU")} onCommit={(v) => patch({ demo: { start_balance: v } })} />
              <SliderRow label="Пополнение в месяц" value={draft.demo.monthly_deposit} min={0} max={100000} step={50}
                         fmt={(v) => "$" + v.toLocaleString("ru-RU")} onCommit={(v) => patch({ demo: { monthly_deposit: v } })} />
              <SliderRow label="Комиссия пула" value={draft.demo.pool_fee_pct} min={0} max={5} step={0.05}
                         suffix="%" onCommit={(v) => patch({ demo: { pool_fee_pct: v } })} />
              <SliderRow label="Проскальзывание, от" value={draft.demo.slippage_min_pct} min={0} max={50} step={0.5}
                         suffix="%" onCommit={(v) => patch({ demo: { slippage_min_pct: v } })} />
              <SliderRow label="Проскальзывание, до" value={draft.demo.slippage_max_pct} min={0} max={50} step={0.5}
                         suffix="%" onCommit={(v) => patch({ demo: { slippage_max_pct: v } })} />
              <SliderRow label="Time-stop" value={draft.demo.time_stop_days} min={7} max={60} step={1}
                         suffix=" дн" onCommit={(v) => patch({ demo: { time_stop_days: v } })} />
              <SliderRow label="Порог слива ликвидности" value={draft.demo.liq_drain_pct} min={1} max={100} step={1}
                         suffix="%" onCommit={(v) => patch({ demo: { liq_drain_pct: v } })} />
              <SliderRow label="Шаг виртуальных часов" value={draft.demo.tick_minutes} min={1} max={1440} step={1}
                         suffix=" мин" onCommit={(v) => patch({ demo: { tick_minutes: v } })} />

              <div className="mt-2 pt-2" style={{ boxShadow: "inset 0 .5px 0 var(--separator)" }}>
                <div className="text-[12px] uppercase tracking-wide mb-1" style={{ color: "var(--label-3)" }}>
                  Free Riding
                </div>
                <SliderRow label="Триггер фиксации" value={draft.free_ride.tp1_percent} min={10} max={400} step={10}
                           suffix="%" onCommit={(v) => patch({ free_ride: { tp1_percent: v } })} />
                <SliderRow label="Доля фиксации" value={draft.free_ride.tp1_fraction} min={0.1} max={0.9} step={0.05}
                           fmt={(v) => Math.round(v * 100) + "%"}
                           onCommit={(v) => patch({ free_ride: { tp1_fraction: v } })} />
                <SliderRow label="Цель 2 (остаток)" value={draft.free_ride.tp2_percent} min={100} max={1000} step={50}
                           suffix="%" onCommit={(v) => patch({ free_ride: { tp2_percent: v } })} />
              </div>
            </>
          )}
        </Panel>
      </div>

      {/* ── ЖУРНАЛ ── */}
      <div className="px-3 mt-3">
        <Panel title="Журнал действий">
          {audit.loading && !audit.data && <Loading label="читаем журнал…" />}
          {audit.error && <ErrorBox text={audit.error} onRetry={audit.refresh} />}
          {audit.data && audit.data.length === 0 && (
            <div className="text-[13px] py-1" style={{ color: "var(--label-3)" }}>записей пока нет</div>
          )}
          {audit.data?.map((a) => (
            <div key={a.id} className="flex items-start gap-2.5 py-2 hairline">
              <ClipboardList size={15} className="shrink-0 mt-0.5" style={{ color: "var(--label-3)" }} />
              <div className="flex-1 min-w-0">
                <div className="text-[14px]">{a.action}</div>
                <div className="text-[12px] mt-0.5" style={{ color: "var(--label-3)" }}>
                  {a.actor} · {dt(a.ts * 1000)}
                </div>
              </div>
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}

/* ── вспомогательные строки ── */

function KeyField({ label, status, value, onChange, hint }: {
  label: string; status: { set: boolean; preview: string };
  value: string; onChange: (v: string) => void; hint?: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[14px]">{label}</span>
        <span className="text-[12px] tabular-nums flex items-center gap-1"
              style={{ color: status.set ? "var(--green)" : "var(--label-3)" }}>
          {status.set && <KeyRound size={12} />}
          {status.set ? (status.preview || "задано") : "не задано"}
        </span>
      </div>
      <input value={value} onChange={(e) => onChange(e.target.value)}
             type="password" autoComplete="off" spellCheck={false}
             placeholder={status.set ? "оставьте пустым — не менять" : "введите значение"}
             className="w-full px-3 py-2.5 rounded-[12px] text-[15px] outline-none"
             style={{ background: "var(--bg-elev)", color: "var(--label)" }} />
      {hint && <div className="text-[12px] mt-1" style={{ color: "var(--label-3)" }}>{hint}</div>}
    </div>
  );
}

function Group({ label, open: openDefault, children }: {
  label: string; open?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!!openDefault);
  return (
    <div className="mt-1">
      <Press onClick={() => setOpen((o) => !o)} className="block w-full">
        <div className="flex items-center justify-between py-2">
          <span className="text-[14px] font-semibold">{label}</span>
          <span className="text-[12px]" style={{ color: "var(--label-3)" }}>{open ? "свернуть" : "развернуть"}</span>
        </div>
      </Press>
      {open && <div className="pb-1">{children}</div>}
    </div>
  );
}

function ToggleRow({ label, hint, on, onChange }: {
  label: string; hint?: string; on: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="flex-1 min-w-0">
        <div className="text-[15px]">{label}</div>
        {hint && <div className="text-[12px] mt-0.5" style={{ color: "var(--label-3)" }}>{hint}</div>}
      </div>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}

function SliderRow({ label, value, min, max, step = 1, suffix, fmt, onCommit }: {
  label: string; value: number; min: number; max: number; step?: number;
  suffix?: string; fmt?: (v: number) => string; onCommit: (v: number) => void;
}) {
  const [live, setLive] = useState(value);
  useEffect(() => { setLive(value); }, [value]);
  const show = fmt ? fmt(live) : live.toLocaleString("ru-RU") + (suffix ?? "");
  return (
    <div className="py-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[14px]" style={{ color: "var(--label-2)" }}>{label}</span>
        <span className="text-[14px] font-semibold tabular-nums">{show}</span>
      </div>
      <Slider value={value} min={min} max={max} step={step}
              onInput={setLive} onChange={(v) => { setLive(v); onCommit(v); }} />
    </div>
  );
}
