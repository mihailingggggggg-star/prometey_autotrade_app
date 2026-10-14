/**
 * Кабинет (§9.5): профиль-карточка, капитал, группы настроек скринера и
 * демо-движка, доступы (ключам/токен), демо-баланс и журнал действий.
 *
 * Форма — как в прежней, фьючерсной версии приложения: сверху высокая
 * профиль-карточка, поверх её нижнего края заезжает карточка капитала, ниже
 * идут группы-строки. Каждая строка открывает шторку с настройками.
 *
 * Почему настройки сохраняются ПО КНОПКЕ, а не сразу ползунком. Раньше каждое
 * отпускание пальца отправляло PUT: собранная «пачка» из восьми подвижек — это
 * восемь записей в журнал и восемь сетевых кругов, а случайный перетяг уже
 * менял поведение бота. Теперь шторка держит ЛОКАЛЬНУЮ копию группы (`draft`),
 * все правки идут в неё, и один запрос `updateSettings({<группа>: …})` уходит
 * только по «Сохранить». Отказ сервера показывается прямо в шторке и НЕ
 * закрывает её — человек видит, что именно не приняли, и правит; крестик/тап по
 * фону откатывают черновик к состоянию сервера.
 *
 * Ключи. Значения НИКОГДА не приходят с сервера — только `set` и `preview`
 * (маска «abcd…12»). Пустое поле означает «не трогать», а не «стереть»: так
 * случайный тап по «Сохранить» не затирает рабочий ключ.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  CalendarRange, ClipboardList, Filter, Gauge, History, KeyRound, Newspaper, Plug, Repeat,
  Save, ShieldCheck, TrendingUp, Users, Wallet,
} from "lucide-react";
import {
  addDeposit, analyticsSummary, getSettings, hasToken, health, keysStatus, listAudit,
  probeAuth, setToken, updateKeys, updateSettings, UnauthorizedError,
} from "../lib/api";
import { useApi } from "../lib/useApi";
import type { KeysUpdate, Settings, SettingsPatch } from "../../shared/types";
import { Aurora, Glass, GroupLabel, Press, Row, Sheet, Title, Toggle } from "../ui/kit";
import { ErrorBox, Loading } from "../ui/states";
import { FunnelSheet } from "../ui/FunnelSheet";
import { SliderField } from "../ui/SliderField";
import { dt } from "../lib/format";

type SheetId = "age" | "safety" | "holders" | "accum" | "media"
             | "exec" | "freeride" | "api" | "keys" | "balance" | "audit";

export function Profile({ refreshKey }: { refreshKey: number }) {
  const settings = useApi(getSettings, 0, [refreshKey]);
  const summary = useApi(analyticsSummary, 20000, [refreshKey]);
  const keys = useApi(keysStatus, 0, [refreshKey]);
  const audit = useApi(() => listAudit(20), 20000, [refreshKey]);
  const healthApi = useApi(health, 30000, [refreshKey]);

  const [sheet, setSheet] = useState<SheetId | null>(null);
  const [funnelOpen, setFunnelOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Free Riding: признак, что пару «триггер / цель» только что поправили
  // автоматически (сервер требует строго tp2 > tp1) — чтобы показать подсказку
  // под полями. Сбрасывается при уходе из шторки.
  const [freeAdjusted, setFreeAdjusted] = useState(false);
  useEffect(() => { if (sheet !== "freeride") setFreeAdjusted(false); }, [sheet]);

  // Ключи: в поля уходит только то, что человек реально набрал.
  const [fields, setFields] = useState<KeysUpdate>({});
  const [keyBusy, setKeyBusy] = useState(false);

  // Ключ доступа к API: сам ключ не показываем — только признак «задан».
  const [apiKey, setApiKey] = useState("");
  const [apiKeySet, setApiKeySet] = useState(hasToken());
  const [apiBusy, setApiBusy] = useState(false);

  const close = () => setSheet(null);
  const s = summary.data;
  const st = settings.data;
  const mode = healthApi.data?.mode;
  const openValue = s ? Math.round((s.equity - s.balance) * 100) / 100 : 0;

  const deposit = async () => {
    setNotice(null);
    try {
      await addDeposit(500);
      summary.refresh();
      setNotice("Пополнено на $500");
    } catch (e) {
      setNotice(msg(e));
    }
  };

  const saveKeys = async () => {
    const body: KeysUpdate = {};
    (Object.keys(fields) as (keyof KeysUpdate)[]).forEach((k) => {
      const v = fields[k]?.trim();
      if (v) body[k] = v;                 // пустое — «не менять»
    });
    if (!Object.keys(body).length) { setNotice("нет новых значений для сохранения"); return; }
    setKeyBusy(true);
    setNotice(null);
    try {
      await updateKeys(body);
      setFields({});
      keys.refresh();
      setNotice("Ключи сохранены");
    } catch (e) {
      setNotice(msg(e));
    } finally {
      setKeyBusy(false);
    }
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
        : msg(e));
    } finally {
      setApiBusy(false);
    }
  };

  const scr = st?.screener;
  const demo = st?.demo;
  const free = st?.free_ride;
  const keysSet = keys.data
    ? [keys.data.telegram_bot_token, keys.data.telegram_chat_id, keys.data.helius_api_key,
       keys.data.gemini_api_key, keys.data.wallet].filter((k) => k.set).length
    : 0;

  return (
    <div className="pb-3">
      <Title sub="Профиль и настройки">Кабинет</Title>

      {notice && (
        <div className="mx-5 mb-2 text-[13px] leading-snug px-3 py-2 rounded-[12px]"
             style={{ background: "var(--bg-elev)", color: "var(--label-2)" }}>{notice}</div>
      )}
      {settings.error && <ErrorBox text={settings.error} onRetry={settings.refresh} />}

      {/* ── Профиль ─────────────────────────────────────────────────────────
          Данных профиля в системе нет: пользователь один и имени у него нет.
          Поэтому инициалы и имя — не «из аккаунта», а постоянные: так честнее,
          чем показывать выдуманное имя. Подпись честно говорит, что за данные
          на экране (live или тестовые). */}
      <div className="px-4">
        <div className="relative rounded-[26px] overflow-hidden" style={{ height: 210 }}>
          <div className="absolute inset-0" style={{ background: "var(--tint-grad)", opacity: 0.55 }} />
          <Aurora />
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="w-[84px] h-[84px] rounded-full flex items-center justify-center text-[30px] font-bold"
                 style={{ color: "#fff", background: "rgba(10,10,12,.55)",
                          border: "1px solid rgba(255,255,255,.28)",
                          backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}>
              П
            </div>
            <div className="text-[22px] font-bold mt-3 tracking-[-0.02em]">ПРОМЕТЕЙ</div>
            <div className="text-[13px] mt-0.5" style={{ color: "var(--label-2)" }}>
              {mode === "live"
                ? "демо-контур · живые рыночные данные"
                : "демо-контур · тестовые данные"}
            </div>
          </div>
        </div>

        {/* ── Капитал ───────────────────────────────────────────────────────
            Главное число кабинета заезжает на профиль-карточку. «Эффективный
            капитал» — это equity (свободные деньги ПЛЮС оценка позиций); ниже
            честно разложено, сколько из него свободно, а сколько в позициях,
            чтобы одна цифра не читалась как «доступно к выводу». */}
        <div className="-mt-7 relative z-10">
          <Glass className="p-5">
            <div className="text-[13px] uppercase tracking-wide" style={{ color: "var(--label-2)" }}>
              Эффективный капитал · демо
            </div>
            <div className="num-hero mt-1">{s ? usd(s.equity) : "—"}</div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[14px]"
                 style={{ color: "var(--label-2)" }}>
              <span>свободно {s ? usd(s.balance) : "—"}</span>
              <span>в позициях {s ? usd(openValue) : "—"}</span>
            </div>
            <Press feel="press" className="block w-full mt-4" onClick={deposit}>
              <div className="py-3 rounded-[14px] text-center text-[16px] font-semibold text-white"
                   style={{ background: "var(--tint-grad)" }}>
                Пополнить $500
              </div>
            </Press>
          </Glass>
        </div>
      </div>

      {/* ── Скринер ─────────────────────────────────────────────────────── */}
      <GroupLabel>Скринер</GroupLabel>
      <div className="px-4">
        <Glass flat className="overflow-hidden">
          <Row icon={<CalendarRange size={16} />} title="Возраст и ликвидность"
               right={<span className="tabular-nums whitespace-nowrap">{scr
                 ? `${scr.age_min}–${scr.age_max} дн`
                 : "—"}</span>}
               onClick={() => setSheet("age")} />
          <Row icon={<ShieldCheck size={16} />} title="Безопасность контракта"
               right={<span className="tabular-nums whitespace-nowrap">{scr
                 ? `≥${scr.burned_liq_min}%` : "—"}</span>}
               onClick={() => setSheet("safety")} />
          <Row icon={<Users size={16} />} title="Концентрация холдеров"
               right={<span className="tabular-nums whitespace-nowrap">{scr
                 ? `< ${scr.top10_max}%` : "—"}</span>}
               onClick={() => setSheet("holders")} />
          <Row icon={<TrendingUp size={16} />} title="Накопление"
               right={<span className="tabular-nums whitespace-nowrap">{scr
                 ? `≤${trim(scr.range_pct * 2)}% · ${trim(scr.drawdown_min)}–${trim(scr.drawdown_max)}%`
                 : "—"}</span>}
               onClick={() => setSheet("accum")} />
          <Row last icon={<Newspaper size={16} />} title="Медиа и новости"
               right={scr ? (scr.llm_filter ? "включено" : "выключено") : "—"}
               onClick={() => setSheet("media")} />
        </Glass>
      </div>

      {/* ── Демо-движок ─────────────────────────────────────────────────── */}
      <GroupLabel>Демо-движок</GroupLabel>
      <div className="px-4">
        <Glass flat className="overflow-hidden">
          <Row icon={<Gauge size={16} />} title="Параметры исполнения"
               right={<span className="tabular-nums whitespace-nowrap">{demo
                 ? `${trim(demo.slippage_min_pct)}–${trim(demo.slippage_max_pct)}%`
                 : "—"}</span>}
               onClick={() => setSheet("exec")} />
          <Row last icon={<Repeat size={16} />} title="Free Riding"
               right={<span className="tabular-nums whitespace-nowrap">{free
                 ? `${trim(free.tp1_percent)}% · ${trim(free.tp2_percent)}%`
                 : "—"}</span>}
               onClick={() => setSheet("freeride")} />
        </Glass>
      </div>

      {/* ── Данные и доступ ─────────────────────────────────────────────── */}
      <GroupLabel>Данные и доступ</GroupLabel>
      <div className="px-4">
        <Glass flat className="overflow-hidden">
          <Row icon={<Filter size={16} />} title="Воронка отбора"
               right="этапы"
               onClick={() => setFunnelOpen(true)} />
          <Row icon={<Plug size={16} />} title="Доступ к API"
               right={apiKeySet ? "задан" : "нет"}
               onClick={() => setSheet("api")} />
          <Row icon={<KeyRound size={16} />} title="Ключи и кошелёк"
               right={keys.data ? `${keysSet} из 5` : "—"}
               onClick={() => setSheet("keys")} />
          <Row last icon={<Wallet size={16} />} title="Демо-баланс"
               right={<span className="tabular-nums whitespace-nowrap">{s ? usd(s.balance) : "—"}</span>}
               onClick={() => setSheet("balance")} />
        </Glass>
      </div>

      {/* ── Прочее ──────────────────────────────────────────────────────── */}
      <GroupLabel>Прочее</GroupLabel>
      <div className="px-4">
        <Glass flat className="overflow-hidden">
          <Row last icon={<History size={16} />} title="Журнал действий"
               right={<span className="tabular-nums whitespace-nowrap">{__BUILD__}</span>}
               onClick={() => setSheet("audit")} />
        </Glass>
      </div>

      {/* ── Шторки настроек ─────────────────────────────────────────────── */}
      <GroupSheet open={sheet === "age"} onClose={close} title="Возраст и ликвидность"
                  group="screener" base={st} onSaved={settings.refresh}>
        {(d, p) => (<>
          <SliderField label="Возраст, от" value={d.screener.age_min} min={0} max={365} step={1}
                       suffix="дн" onChange={(v) => p({ screener: { age_min: v } })} />
          <SliderField label="Возраст, до" value={d.screener.age_max} min={1} max={730} step={1}
                       suffix="дн" onChange={(v) => p({ screener: { age_max: v } })} />
          <SliderField label="Ликвидность, от" value={d.screener.liq_min} min={0} max={500000} step={1000}
                       suffix="$" onChange={(v) => p({ screener: { liq_min: v } })} />
          <SliderField label="Ликвидность, до" value={d.screener.liq_max} min={0} max={500000} step={1000}
                       suffix="$" hint="0 — без потолка"
                       onChange={(v) => p({ screener: { liq_max: v } })} />
        </>)}
      </GroupSheet>

      <GroupSheet open={sheet === "safety"} onClose={close} title="Безопасность контракта"
                  group="screener" base={st} onSaved={settings.refresh}>
        {(d, p) => (<>
          <SliderField label="Сожжённая ликвидность, не менее" value={d.screener.burned_liq_min}
                       min={0} max={100} step={1} suffix="%"
                       onChange={(v) => p({ screener: { burned_liq_min: v } })} />
          <SliderField label="Уникальных мейкеров, не менее" value={d.screener.maker_min}
                       min={0} max={100000} step={100}
                       onChange={(v) => p({ screener: { maker_min: v } })} />
          <ToggleRow label="Фильтр накрутки объёма" hint="уникальные мейкеры против ботов"
                     on={d.screener.wash_filter}
                     onChange={(v) => p({ screener: { wash_filter: v } })} />
        </>)}
      </GroupSheet>

      <GroupSheet open={sheet === "holders"} onClose={close} title="Концентрация холдеров"
                  group="screener" base={st} onSaved={settings.refresh}>
        {(d, p) => (
          <SliderField label="Доля топ-10 холдеров, не более" value={d.screener.top10_max}
                       min={0} max={100} step={1} suffix="%"
                       onChange={(v) => p({ screener: { top10_max: v } })} />
        )}
      </GroupSheet>

      <GroupSheet open={sheet === "accum"} onClose={close} title="Накопление"
                  group="screener" base={st} onSaved={settings.refresh}>
        {(d, p) => (<>
          <SliderField label="Окно коридора" value={d.screener.range_days} min={1} max={90} step={1}
                       suffix="дн" onChange={(v) => p({ screener: { range_days: v } })} />
          {/* Ширина коридора = полуширина×2: на сервере хранится полуширина,
              а человеку показываем полную ширину и пишем назад v/2. */}
          <SliderField label="Ширина коридора, не более" value={d.screener.range_pct * 2}
                       min={2} max={100} step={1} suffix="%"
                       onChange={(v) => p({ screener: { range_pct: v / 2 } })} />
          <SliderField label="Просадка от максимума, от" value={d.screener.drawdown_min}
                       min={0} max={100} step={1} suffix="%"
                       onChange={(v) => p({ screener: { drawdown_min: v } })} />
          <SliderField label="Просадка от максимума, до" value={d.screener.drawdown_max}
                       min={0} max={100} step={1} suffix="%"
                       onChange={(v) => p({ screener: { drawdown_max: v } })} />
          <SliderField label="Рост холдеров за 7 дней, не менее" value={d.screener.holders_growth_min}
                       min={0} max={100} step={0.5} suffix="%"
                       onChange={(v) => p({ screener: { holders_growth_min: v } })} />
        </>)}
      </GroupSheet>

      <GroupSheet open={sheet === "media"} onClose={close} title="Медиа и новости"
                  group="screener" base={st} onSaved={settings.refresh}>
        {(d, p) => (
          <ToggleRow label="Проверка упоминаний в X"
                     hint="расходует кредит Apify: собирает упоминания и оценивает интерес, без неё слой медиа пропускается"
                     on={d.screener.llm_filter}
                     onChange={(v) => p({ screener: { llm_filter: v } })} />
        )}
      </GroupSheet>

      <GroupSheet open={sheet === "exec"} onClose={close} title="Параметры исполнения"
                  group="demo" base={st} onSaved={settings.refresh}>
        {(d, p) => (<>
          <SliderField label="Стартовый баланс" value={d.demo.start_balance} min={0} max={100000} step={50}
                       suffix="$" onChange={(v) => p({ demo: { start_balance: v } })} />
          <SliderField label="Пополнение в месяц" value={d.demo.monthly_deposit} min={0} max={100000} step={50}
                       suffix="$" onChange={(v) => p({ demo: { monthly_deposit: v } })} />
          <SliderField label="Комиссия пула" value={d.demo.pool_fee_pct} min={0} max={5} step={0.05}
                       suffix="%" onChange={(v) => p({ demo: { pool_fee_pct: v } })} />
          <SliderField label="Проскальзывание, от" value={d.demo.slippage_min_pct} min={0} max={50} step={0.5}
                       suffix="%" onChange={(v) => p({ demo: { slippage_min_pct: v } })} />
          <SliderField label="Проскальзывание, до" value={d.demo.slippage_max_pct} min={0} max={50} step={0.5}
                       suffix="%" onChange={(v) => p({ demo: { slippage_max_pct: v } })} />
          <SliderField label="Time-stop" value={d.demo.time_stop_days} min={7} max={60} step={1}
                       suffix="дн" onChange={(v) => p({ demo: { time_stop_days: v } })} />
          <SliderField label="Порог слива ликвидности" value={d.demo.liq_drain_pct} min={1} max={100} step={1}
                       suffix="%" onChange={(v) => p({ demo: { liq_drain_pct: v } })} />
          <SliderField label="Длительность тика" value={d.demo.tick_minutes} min={1} max={1440} step={1}
                       suffix="мин" onChange={(v) => p({ demo: { tick_minutes: v } })} />
        </>)}
      </GroupSheet>

      <GroupSheet open={sheet === "freeride"} onClose={close} title="Free Riding"
                  group="free_ride" base={st} onSaved={settings.refresh}>
        {(d, p) => (<>
          {/* Пара «триггер / цель» обязана быть строго упорядоченной (tp2 > tp1):
              сервер отвергает равенство и меньшинство. Правя одно поле, поднимаем
              или опускаем второе на шаг, чтобы «Сохранить» не падало с 400. */}
          <SliderField label="Триггер фиксации" value={d.free_ride.tp1_percent} min={10} max={400} step={10}
                       suffix="%" onChange={(v) => {
                         const next = { ...d.free_ride, tp1_percent: v };
                         if (next.tp2_percent <= v) { next.tp2_percent = v + 1; setFreeAdjusted(true); }
                         p({ free_ride: next });
                       }} />
          {/* Доля хранится как 0..1, показываем в процентах: 0.5 → «50%». */}
          <SliderField label="Доля фиксации" value={d.free_ride.tp1_fraction * 100} min={10} max={90} step={5}
                       suffix="%" onChange={(v) => p({ free_ride: { tp1_fraction: v / 100 } })} />
          <SliderField label="Цель 2 (остаток)" value={d.free_ride.tp2_percent} min={100} max={1000} step={50}
                       suffix="%" hint="должна быть выше триггера фиксации"
                       onChange={(v) => {
                         const next = { ...d.free_ride, tp2_percent: v };
                         if (v <= next.tp1_percent) { next.tp1_percent = v - 1; setFreeAdjusted(true); }
                         p({ free_ride: next });
                       }} />
          {freeAdjusted && (
            <p className="text-[12px] mt-1 leading-snug" style={{ color: "var(--label-3)" }}>
              Цель всегда выше триггера — значение поднято автоматически.
            </p>
          )}
        </>)}
      </GroupSheet>

      {/* ── Воронка отбора: готовый компонент ───────────────────────────── */}
      <FunnelSheet open={funnelOpen} onClose={() => setFunnelOpen(false)} />

      {/* ── Доступ к API ────────────────────────────────────────────────── */}
      <Sheet open={sheet === "api"} onClose={close} title="Доступ к API" tall>
        <div className="pb-6">
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
          <Press onClick={saveApiKey} disabled={apiBusy} className="block w-full mt-3">
            <div className="py-3 rounded-[14px] text-center text-[15px] font-semibold text-white"
                 style={{ background: "var(--tint-grad)", opacity: apiBusy ? 0.6 : 1 }}>
              Сохранить ключ
            </div>
          </Press>
          <p className="text-[12px] mt-2 leading-snug" style={{ color: "var(--label-3)" }}>
            Ключ хранится только в этом устройстве и не показывается — виден лишь факт «задан».
          </p>
        </div>
      </Sheet>

      {/* ── Ключи и кошелёк ─────────────────────────────────────────────── */}
      <Sheet open={sheet === "keys"} onClose={close} title="Ключи и кошелёк" tall>
        <div className="pb-6 flex flex-col gap-3">
          {keys.loading && !keys.data && <Loading label="читаем статус ключей…" />}
          {keys.error && <ErrorBox text={keys.error} onRetry={keys.refresh} />}
          {keys.data && (<>
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

            <Press onClick={saveKeys} disabled={keyBusy} className="block w-full mt-1">
              <div className="flex items-center justify-center gap-2 py-3 rounded-[14px] text-[15px] font-semibold text-white"
                   style={{ background: "var(--tint-grad)", opacity: keyBusy ? 0.6 : 1 }}>
                <Save size={16} /> Сохранить
              </div>
            </Press>
            <p className="text-[12px] leading-snug" style={{ color: "var(--label-3)" }}>
              Секреты хранятся в .env на сервере и наружу не отдаются — здесь
              видны только маска и отметка «задано».
            </p>
          </>)}
        </div>
      </Sheet>

      {/* ── Демо-баланс ─────────────────────────────────────────────────── */}
      <Sheet open={sheet === "balance"} onClose={close} title="Демо-баланс" tall>
        <div className="pb-6">
          {s ? (<>
            <div className="text-[13px] uppercase tracking-wide" style={{ color: "var(--label-2)" }}>
              Свободно на демо-счёте
            </div>
            <div className="num-hero mt-1">{usd(s.balance)}</div>
            <div className="mt-3">
              <KVRow label="Внесено за всё время" value={usd(s.deposited)} />
              <KVRow label="В позициях" value={usd(openValue)} />
              <KVRow label="Издержки за всё время" value={usd(s.costs_usd)} />
            </div>
            <Press feel="press" className="block w-full mt-4" onClick={deposit}>
              <div className="py-3.5 rounded-[16px] text-center text-[16px] font-semibold text-white"
                   style={{ background: "var(--tint-grad)" }}>
                Пополнить $500
              </div>
            </Press>
          </>) : (
            <Loading label="считаем баланс…" />
          )}
        </div>
      </Sheet>

      {/* ── Журнал действий ─────────────────────────────────────────────── */}
      <Sheet open={sheet === "audit"} onClose={close} title="Журнал действий" tall>
        <div className="pb-6">
          <div className="text-[12px] mb-2 tabular-nums" style={{ color: "var(--label-3)" }}>
            сборка {__BUILD__} · режим {mode === "live" ? "боевой" : "демо"}
          </div>
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
        </div>
      </Sheet>
    </div>
  );
}

/* ── шторка группы настроек ──────────────────────────────────────────────── */

/** Шторка с локальным черновиком группы.
 *
 *  Открытие даёт свежую копию настроек сервера; все правки полей идут в неё
 *  (`patch`) и никуда не отправляются. Один запрос уходит по «Сохранить» — и
 *  только за ТУ группу, которую правили. Отказ сервера печатается в шторке, и
 *  она остаётся открытой; закрытие (крестик/фон) откатывает черновик. */
function GroupSheet({ open, onClose, title, group, base, onSaved, children }: {
  open: boolean;
  onClose: () => void;
  title: string;
  group: keyof Settings;
  base: Settings | null;
  onSaved: () => void;
  children: (draft: Settings, patch: (p: SettingsPatch) => void) => ReactNode;
}) {
  const [draft, setDraft] = useState<Settings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setDraft(base
      ? { screener: { ...base.screener }, demo: { ...base.demo }, free_ride: { ...base.free_ride } }
      : null);
  }, [open, base]);

  const patch = (p: SettingsPatch) => setDraft((d) => d ? {
    screener: { ...d.screener, ...(p.screener ?? {}) },
    demo: { ...d.demo, ...(p.demo ?? {}) },
    free_ride: { ...d.free_ride, ...(p.free_ride ?? {}) },
  } : d);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setErr(null);
    // Один запрос на всю группу — по кнопке, а не по каждому движению пальца.
    const body: SettingsPatch =
      group === "screener" ? { screener: draft.screener } :
      group === "demo" ? { demo: draft.demo } :
      { free_ride: draft.free_ride };
    try {
      await updateSettings(body);
      onSaved();
      onClose();
    } catch (e) {
      // Причина отказа — прямо в шторке, и шторка НЕ закрывается: человек
      // должен увидеть, что именно не приняли, и поправить.
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={title} tall>
      {draft ? (
        <div className="pb-4">
          {children(draft, patch)}
          {err && (
            <p className="text-[13px] mt-3 px-3 py-2 rounded-[12px] leading-snug"
               style={{ background: "color-mix(in srgb, var(--red) 16%, transparent)", color: "var(--red)" }}>
              {err}
            </p>
          )}
          <Press feel="press" className="block w-full mt-4" disabled={busy} onClick={save}>
            <div className="flex items-center justify-center gap-2 py-3.5 rounded-[16px] text-[16px] font-semibold text-white"
                 style={{ background: "var(--tint-grad)", opacity: busy ? 0.6 : 1 }}>
              <Save size={17} /> Сохранить
            </div>
          </Press>
        </div>
      ) : (
        <div className="pb-6"><Loading label="читаем настройки…" /></div>
      )}
    </Sheet>
  );
}

/* ── вспомогательные строки ── */

/** Строка «подпись → значение» для шторок (баланс, ключи). Локальная копия
 *  KV из ui/states: здесь нужен только компактный вид, без лишних пропов. */
function KVRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-[5px]">
      <span className="text-[14px]" style={{ color: "var(--label-2)" }}>{label}</span>
      <span className="text-[14px] font-medium tabular-nums">{value}</span>
    </div>
  );
}

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

function ToggleRow({ label, hint, on, onChange }: {
  label: string; hint?: string; on: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="flex-1 min-w-0">
        <div className="text-[15px] leading-snug">{label}</div>
        {hint && <div className="text-[12px] mt-0.5 leading-snug" style={{ color: "var(--label-3)" }}>{hint}</div>}
      </div>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}

/* ── мелочи ── */

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Сумма в долларах с копейками: «$1 234,56». Знак не показываем — это не PnL. */
function usd(v: number): string {
  return "$" + v.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Число шага без «хвоста»: 45, 0.5, 20. */
function trim(v: number): string {
  return String(+v.toFixed(2));
}
