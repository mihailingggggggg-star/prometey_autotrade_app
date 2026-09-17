import { useState } from "react";
import QRCode from "react-qr-code";
import {
  BadgeCheck, BookOpen, Check, ChevronRight, Copy, CreditCard, Download, ExternalLink,
  KeyRound, LifeBuoy, Lock, Percent, Plug, Receipt, RefreshCw, ShieldAlert, Sliders, Wallet,
} from "lucide-react";
import { Glass, GroupLabel, Modal, Press, Row, Segmented, Sheet, Title, Toggle, tone } from "../ui/kit";
import { useApp } from "../lib/store";
import * as M from "../lib/mock";
import { dt, plural } from "../lib/format";
import { haptic } from "../lib/tg";
import { ApiGuide } from "./ApiGuide";

export function Cabinet() {
  const a = useApp();
  const [pay, setPay] = useState<null | { title: string; amount: number; note: string }>(null);
  const [plans, setPlans] = useState(false);
  const [settings, setSettings] = useState(false);
  const [apiSheet, setApiSheet] = useState(false);
  const [guide, setGuide] = useState(false);
  const [history, setHistory] = useState(false);
  const [copied, setCopied] = useState(false);

  const nextFee = new Date(Date.now() + 3 * 864e5);

  return (
    <div className="pb-2">
      <Title sub={a.user.name || "Личный кабинет"}>Кабинет</Title>

      {/* ── Баланс ─────────────────────────────────────────────────────────── */}
      <div className="px-4" data-coach="balance">
        <Glass className="p-5">
          <div className="text-[13px] uppercase tracking-wide" style={{ color: "var(--label-2)" }}>
            Свободно на счёте бота
          </div>
          <div className="num-hero mt-1">${a.balance.toFixed(2)}</div>
          <div className="flex items-center gap-4 mt-2 text-[14px]" style={{ color: "var(--label-2)" }}>
            <span>в позициях ${a.inPositions.toFixed(2)}</span>
            <span>депозит биржи ${a.deposit.toFixed(2)}</span>
          </div>
          <Press feel="press" className="block w-full mt-4"
                 onClick={() => setPay({ title: "Пополнение баланса", amount: 50, note: "Любая сумма от $10" })}>
            <div className="py-3 rounded-[14px] text-center text-[16px] font-semibold text-white"
                 style={{ background: "var(--tint)" }}>Пополнить</div>
          </Press>
        </Glass>
      </div>

      {/* ── Комиссия и подписка ────────────────────────────────────────────── */}
      <GroupLabel>Подписка и комиссия</GroupLabel>
      <div className="px-4">
        <Glass flat className="overflow-hidden">
          <Row icon={<BadgeCheck size={16} />} title={a.sub.active ? `Подписка активна · ${a.sub.plan}` : "Подписки нет"}
               note={a.sub.active && a.sub.until
                 ? `до ${new Date(a.sub.until).toLocaleDateString("ru-RU")} · комиссия 4% с прибыли`
                 : "без подписки комиссия 15% с прибыли"}
               right={<ChevronRight size={17} />} onClick={() => setPlans(true)} />
          <Row icon={<Percent size={16} />} title="Комиссия к оплате"
               note={a.owed > 0
                 ? `за 10–16 сентября · следующее начисление ${nextFee.toLocaleDateString("ru-RU")}`
                 : "задолженности нет"}
               right={<b style={{ color: a.owed > a.balance ? "var(--red)" : "var(--label)" }}>
                        ${a.owed.toFixed(2)}</b>}
               onClick={a.owed > 0 ? () => setPay({
                 title: "Оплата комиссии", amount: a.owed, note: "за 10–16 сентября · 4% от прибыли",
               }) : undefined} />
          <Row last icon={<Receipt size={16} />} title="История оплат и отчёты"
               note="все платежи, выгрузка таблицей" right={<ChevronRight size={17} />}
               onClick={() => setHistory(true)} />
        </Glass>
        <p className="text-[12px] mt-2 px-1 leading-snug" style={{ color: "var(--label-2)" }}>
          Комиссия берётся <b>только с прибыльного</b> результата и выставляется раз в неделю.
          Автосписаний нет — вы оплачиваете вручную. Если на балансе не хватит средств, новые
          сделки приостанавливаются до оплаты.
        </p>
      </div>

      {/* ── Настройки бота ─────────────────────────────────────────────────── */}
      <GroupLabel>Торговля</GroupLabel>
      <div className="px-4" data-coach="risk">
        <Glass flat className="overflow-hidden">
          <Row icon={<Sliders size={16} />} title="Риск на сделку"
               note={a.riskAlert
                 ? `$${a.settings.riskUsd} — это ${((a.settings.riskUsd / a.deposit) * 100).toFixed(1)}% депозита`
                 : "сколько теряем при срабатывании стопа"}
               right={<b>${a.settings.riskUsd}</b>} onClick={() => setSettings(true)} />
          <Row icon={<Plug size={16} />} title="Настройки бота"
               note="режимы, плечо, схема выхода, лимиты" right={<ChevronRight size={17} />}
               onClick={() => setSettings(true)} />
          <Row last icon={<KeyRound size={16} />} title="API-ключи Bybit"
               note={a.api.connected ? `подключено · ${a.api.key}` : "не подключены"}
               right={<span className="flex items-center gap-1.5">
                 <span className="w-2 h-2 rounded-full"
                       style={{ background: a.api.connected ? "var(--green)" : "var(--red)" }} />
                 <ChevronRight size={17} />
               </span>} onClick={() => setApiSheet(true)} />
        </Glass>
        {a.riskAlert && (
          <Glass flat className="p-3.5 mt-2.5 flex items-start gap-3">
            <ShieldAlert size={19} style={{ color: "var(--orange)" }} className="shrink-0 mt-0.5" />
            <div className="text-[13px] leading-snug">
              Риск выше 5% депозита. Три стопа подряд заберут
              {" "}{((a.settings.riskUsd * 3 / a.deposit) * 100).toFixed(0)}% счёта — это много.
              Рекомендуем не больше <b>${Math.floor(a.deposit * 0.05)}</b> на сделку.
            </div>
          </Glass>
        )}
      </div>

      {/* ── Поддержка ──────────────────────────────────────────────────────── */}
      <GroupLabel>Помощь</GroupLabel>
      <div className="px-4">
        <Glass flat className="overflow-hidden">
          <Row icon={<BookOpen size={16} />} title="Как создать API-ключ на Bybit"
               note="пошаговая инструкция" right={<ChevronRight size={17} />} onClick={() => setGuide(true)} />
          <Row icon={<LifeBuoy size={16} />} title="Написать в поддержку"
               note="отвечаем в течение часа" right={<ExternalLink size={16} />} />
          <Row last icon={<BookOpen size={16} />} title="База знаний и сообщество"
               right={<ExternalLink size={16} />} />
        </Glass>
      </div>

      <div className="px-4 mt-5 text-center text-[12px]" style={{ color: "var(--label-3)" }}>
        PROMETHEUS · автотрейд · v1.0
      </div>

      {/* ── Шторки ─────────────────────────────────────────────────────────── */}
      <PlansSheet open={plans} onClose={() => setPlans(false)}
                  onBuy={(id) => { const p = M.PLANS.find((x) => x.id === id)!;
                    setPlans(false);
                    setPay({ title: `Подписка · ${p.label}`, amount: p.price, note: "комиссия снизится до 4%" }); }} />

      <BotSettings open={settings} onClose={() => setSettings(false)} />

      <ApiSheet open={apiSheet} onClose={() => setApiSheet(false)} onGuide={() => { setApiSheet(false); setGuide(true); }} />

      <Sheet open={guide} onClose={() => setGuide(false)} title="API-ключ Bybit" tall><ApiGuide /></Sheet>

      <Sheet open={history} onClose={() => setHistory(false)} title="История оплат">
        <div className="pb-3">
          <Glass flat className="overflow-hidden">
            {M.payments.map((p, i) => (
              <Row key={p.id} last={i === M.payments.length - 1}
                   icon={p.kind === "подписка" ? <BadgeCheck size={16} />
                       : p.kind === "пополнение" ? <Wallet size={16} /> : <Percent size={16} />}
                   title={<span className="capitalize">{p.kind}</span>}
                   note={`${p.note} · ${dt(p.at)}`}
                   right={<span style={{ color: p.status === "ожидает" ? "var(--orange)" : "var(--label-2)" }}>
                     ${p.amount.toFixed(2)}
                   </span>} />
            ))}
          </Glass>
          <Press feel="press" className="block w-full mt-3" onClick={() => haptic.ok()}>
            <Glass flat className="py-3.5 flex items-center justify-center gap-2 text-[16px] font-medium">
              <Download size={17} /> Скачать финансовый отчёт (CSV)
            </Glass>
          </Press>
        </div>
      </Sheet>

      {/* ── Оплата ─────────────────────────────────────────────────────────── */}
      <Sheet open={!!pay} onClose={() => setPay(null)} title={pay?.title} tall>
        {pay && (
          <div className="pb-3">
            <div className="text-center">
              <div className="num-hero">${pay.amount.toFixed(2)}</div>
              <div className="text-[14px] mt-1" style={{ color: "var(--label-2)" }}>{pay.note}</div>
            </div>
            <div className="mt-4 flex justify-center">
              <div className="p-3 rounded-[18px] bg-white">
                <QRCode value={M.USDT_ADDRESS} size={168} bgColor="#ffffff" fgColor="#000000" />
              </div>
            </div>
            <div className="mt-4">
              <div className="text-[13px] mb-1.5" style={{ color: "var(--label-2)" }}>
                Кошелёк USDT · сеть Polygon (PoS)
              </div>
              <Press className="block w-full" onClick={() => {
                navigator.clipboard?.writeText(M.USDT_ADDRESS); haptic.ok();
                setCopied(true); setTimeout(() => setCopied(false), 1600);
              }}>
                <Glass flat className="px-3.5 py-3 flex items-center gap-2">
                  <span className="text-[13px] font-mono break-all flex-1">{M.USDT_ADDRESS}</span>
                  {copied ? <Check size={17} style={{ color: "var(--green)" }} />
                          : <Copy size={17} style={{ color: "var(--label-2)" }} />}
                </Glass>
              </Press>
            </div>
            <Glass flat className="p-3.5 mt-3 text-[13px] leading-snug" style={{ color: "var(--label-2)" }}>
              Отправляйте <b>только USDT в сети Polygon</b>. Средства в другой сети
              восстановить невозможно. Зачисление — обычно в течение минуты после подтверждения.
            </Glass>
            <Press feel="press" className="block w-full mt-3"
                   onClick={() => {
                     if (pay.title.startsWith("Оплата комиссии")) a.payOwed();
                     else if (pay.title.startsWith("Подписка")) {
                       const pl = M.PLANS.find((x) => pay.title.includes(x.label));
                       if (pl) a.buyPlan(pl.id);
                     } else a.topUp(pay.amount);
                     haptic.ok(); setPay(null);
                   }}>
              <div className="py-3.5 rounded-[16px] text-center text-[16px] font-semibold text-white"
                   style={{ background: "var(--green)" }}>Я оплатил — проверить</div>
            </Press>
          </div>
        )}
      </Sheet>
    </div>
  );
}

/* ── Тарифы ─────────────────────────────────────────────────────────────────── */
function PlansSheet({ open, onClose, onBuy }: { open: boolean; onClose: () => void; onBuy: (id: string) => void }) {
  const [sel, setSel] = useState("m6");
  return (
    <Sheet open={open} onClose={onClose} title="Подписка" tall>
      <div className="pb-3">
        <Glass flat className="p-4">
          <div className="flex items-center justify-between text-[15px]">
            <span>Без подписки</span><b>15% с прибыли</b>
          </div>
          <div className="flex items-center justify-between text-[15px] mt-2">
            <span style={{ color: "var(--green)" }}>С подпиской</span>
            <b style={{ color: "var(--green)" }}>4% с прибыли</b>
          </div>
          <p className="text-[12px] mt-2.5 leading-snug" style={{ color: "var(--label-2)" }}>
            Комиссия берётся только с прибыльных недель. Подписка окупается,
            если за месяц бот зарабатывает больше ~$180.
          </p>
        </Glass>

        <div className="mt-3 space-y-2">
          {M.PLANS.map((p) => {
            const on = sel === p.id;
            return (
              <Press key={p.id} onClick={() => setSel(p.id)} className="block w-full" scale={0.985}>
                <Glass flat className="p-4 flex items-center gap-3"
                       style={{ outline: on ? "2px solid var(--tint)" : "none", outlineOffset: -2 } as any}>
                  <span className="w-[22px] h-[22px] rounded-full flex items-center justify-center shrink-0"
                        style={{ border: `2px solid ${on ? "var(--tint)" : "var(--label-3)"}`,
                                 background: on ? "var(--tint)" : "transparent" }}>
                    {on && <Check size={13} color="#fff" strokeWidth={3} />}
                  </span>
                  <div className="flex-1">
                    <div className="text-[16px] font-semibold">{p.label}</div>
                    <div className="text-[12px]" style={{ color: "var(--label-2)" }}>
                      ${(p.price / p.months).toFixed(2)} в месяц
                    </div>
                  </div>
                  {p.best && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold text-white"
                          style={{ background: "var(--green)" }}>выгодно</span>
                  )}
                  <div className="text-right">
                    <div className="text-[18px] font-bold">${p.price}</div>
                    {p.note && <div className="text-[11px]" style={{ color: "var(--green)" }}>{p.note}</div>}
                  </div>
                </Glass>
              </Press>
            );
          })}
        </div>

        <Press feel="press" className="block w-full mt-4" onClick={() => onBuy(sel)}>
          <div className="py-3.5 rounded-[16px] text-center text-[16px] font-semibold text-white"
               style={{ background: "var(--tint)" }}>
            Оплатить ${M.PLANS.find((p) => p.id === sel)!.price}
          </div>
        </Press>
        <p className="text-[12px] mt-2.5 text-center leading-snug" style={{ color: "var(--label-2)" }}>
          Автопродления нет. Подписка покупается вручную каждый раз.
        </p>
      </div>
    </Sheet>
  );
}

/* ── Настройки бота (те же, что в Telegram-боте) ────────────────────────────── */
function BotSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { settings: s, setSettings, deposit, riskAlert, demo } = useApp();
  const rec = Math.floor(deposit * 0.05);
  return (
    <Sheet open={open} onClose={onClose} title="Настройки бота" tall>
      <div className="pb-3 space-y-3">
        {/* Настройки бота API отдаёт, но не принимает. Оставь мы ползунки
            рабочими — человек подвинул бы риск, увидел новое число и был бы
            уверен, что бот теперь рискует иначе. Это худший вид вранья в
            торговом интерфейсе, поэтому здесь замок и прямая инструкция. */}
        {!demo && (
          <Glass flat className="p-3.5 flex items-start gap-3">
            <Lock size={18} className="mt-0.5 shrink-0" style={{ color: "var(--label-2)" }} />
            <div className="text-[13px] leading-snug" style={{ color: "var(--label-2)" }}>
              Показаны настоящие настройки бота. Менять их — в Telegram-панели:
              <b style={{ color: "var(--label)" }}> ⚙️ Настройки</b>. Мини-апп
              работает только на чтение.
            </div>
          </Glass>
        )}
        <fieldset disabled={!demo} className="space-y-3"
                  style={!demo ? { opacity: 0.72 } : undefined}>
        <Glass flat className="p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-[15px]">Риск на сделку</span>
            <b className="text-[22px]" style={{ color: riskAlert ? "var(--orange)" : "var(--label)" }}>
              ${s.riskUsd}
            </b>
          </div>
          <input type="range" min={1} max={120} step={1} value={s.riskUsd}
                 onChange={(e) => setSettings({ riskUsd: +e.target.value })}
                 className="w-full mt-3 accent-[var(--tint)]" />
          <div className="flex justify-between text-[11px] mt-1" style={{ color: "var(--label-2)" }}>
            <span>$1</span>
            <span>{((s.riskUsd / deposit) * 100).toFixed(1)}% депозита</span>
            <span>$120</span>
          </div>
          {riskAlert && (
            <div className="mt-2.5 flex items-start gap-2 text-[12px]" style={{ color: "var(--orange)" }}>
              <ShieldAlert size={15} className="shrink-0 mt-0.5" />
              <span>Выше 5% депозита. Рекомендуем не больше ${rec}.</span>
            </div>
          )}
        </Glass>

        <Glass flat className="overflow-hidden">
          <Row icon={<Plug size={16} />} title="Приём сигналов" note="главный тумблер бота"
               right={<Toggle on={s.enabled} onChange={(v) => setSettings({ enabled: v })} />} />
          <Row title="Разрешить лонги" right={<Toggle on={s.allowLong} onChange={(v) => setSettings({ allowLong: v })} />} />
          <Row title="Разрешить шорты" right={<Toggle on={s.allowShort} onChange={(v) => setSettings({ allowShort: v })} />} />
          <Row last title="Только киты" note="брать лишь сигналы от крупных игроков"
               right={<Toggle on={s.whaleOnly} onChange={(v) => setSettings({ whaleOnly: v })} />} />
        </Glass>

        <div>
          <div className="text-[13px] mb-1.5 px-1" style={{ color: "var(--label-2)" }}>Схема выхода</div>
          <Segmented value={s.tpMode} onChange={(v) => setSettings({ tpMode: v })}
                     options={[{ id: "single", label: "Одна цель" }, { id: "ladder", label: "Лесенка" }]} />
          <Glass flat className="overflow-hidden mt-2">
            <Row title="Цель" note="в R от риска" right={<b>{s.tpR}R</b>} />
            <Row last title="Безубыток"
                 note={s.beR ? "стоп в точку входа при достижении уровня" : "стоп остаётся на месте"}
                 right={<b>{s.beR ? `с ${s.beR}R` : "выкл"}</b>} />
          </Glass>
        </div>

        <Glass flat className="overflow-hidden">
          <Row title="Плечо" note={s.leverageMode === "max" ? "максимум по монете с запасом до ликвидации" : "фиксированное"}
               right={<b>{s.leverageMode === "max" ? "авто" : `${s.leverage}×`}</b>} />
          <Row title="Лимит открытых позиций" right={<b>{s.maxOpen}</b>} />
          <Row last title="Жизнь лимитки" note="через сколько снимать непролившийся ордер"
               right={<b>{Math.round(s.limitTtlMin / 60)} ч</b>} />
        </Glass>
        </fieldset>
      </div>
    </Sheet>
  );
}

/* ── API-ключи ──────────────────────────────────────────────────────────────── */
function ApiSheet({ open, onClose, onGuide }: { open: boolean; onClose: () => void; onGuide: () => void }) {
  const { api, connectApi, disconnectApi } = useApp();
  const [k, setK] = useState(""); const [s, setS] = useState("");
  const [test, setTest] = useState<null | "run" | "ok" | "err">(null);

  return (
    <Sheet open={open} onClose={onClose} title="API-ключи Bybit" tall>
      <div className="pb-3 space-y-3">
        <Glass flat className="p-4 flex items-center gap-3">
          <span className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ background: api.connected ? "var(--green)" : "var(--red)" }} />
          <div className="flex-1">
            <div className="text-[15px] font-medium">{api.connected ? "Подключено" : "Не подключено"}</div>
            <div className="text-[12px] font-mono mt-0.5" style={{ color: "var(--label-2)" }}>
              {api.connected ? api.key : "ключ не задан"}
            </div>
          </div>
          {api.connected && (
            <Press onClick={() => { setTest("run"); setTimeout(() => { setTest("ok"); haptic.ok(); }, 1100); }}>
              <span className="flex items-center gap-1.5 text-[14px]" style={{ color: "var(--tint)" }}>
                <RefreshCw size={15} className={test === "run" ? "animate-spin" : ""} /> Проверить
              </span>
            </Press>
          )}
        </Glass>

        {test === "ok" && (
          <Glass flat className="p-3.5 flex items-center gap-2.5 text-[14px]">
            <Check size={17} style={{ color: "var(--green)" }} />
            Ключи рабочие · баланс $1 042.80 · права: торговля, чтение
          </Glass>
        )}

        {!api.connected && (
          <>
            <Field label="API Key" value={k} onChange={setK} placeholder="вставьте ключ" />
            <Field label="API Secret" value={s} onChange={setS} placeholder="вставьте секрет" secret />
            <Press feel="press" className="block w-full" disabled={!k || !s}
                   onClick={() => { connectApi(k, s); haptic.ok(); }}>
              <div className="py-3.5 rounded-[16px] text-center text-[16px] font-semibold text-white"
                   style={{ background: "var(--tint)" }}>Подключить</div>
            </Press>
          </>
        )}

        <Press onClick={onGuide} className="block w-full">
          <Glass flat className="p-3.5 flex items-center gap-2.5">
            <BookOpen size={17} style={{ color: "var(--tint)" }} />
            <span className="text-[15px] flex-1">Как создать ключ на Bybit</span>
            <ChevronRight size={17} style={{ color: "var(--label-2)" }} />
          </Glass>
        </Press>

        <Glass flat className="p-3.5 text-[12px] leading-snug" style={{ color: "var(--label-2)" }}>
          Ключ нужен с правами <b>Contract — Trade</b> и <b>Read</b>. Право на вывод
          средств выдавать <b>нельзя</b>: боту оно не нужно, а с ним ключ становится
          опасным. Секрет хранится в зашифрованном виде и не показывается повторно.
        </Glass>

        {api.connected && (
          <Press onClick={() => { disconnectApi(); haptic.warn(); }} className="block w-full">
            <Glass flat className="py-3 text-center text-[15px]" style={{ color: "var(--red)" }}>
              Отключить ключи
            </Glass>
          </Press>
        )}
      </div>
    </Sheet>
  );
}

function Field({ label, value, onChange, placeholder, secret }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; secret?: boolean;
}) {
  return (
    <div>
      <div className="text-[13px] mb-1.5 px-1" style={{ color: "var(--label-2)" }}>{label}</div>
      <div className="glass glass-flat px-3.5 py-3">
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
               type={secret ? "password" : "text"} autoCapitalize="off" autoCorrect="off" spellCheck={false}
               className="bg-transparent outline-none w-full text-[16px] font-mono"
               style={{ color: "var(--label)" }} />
      </div>
    </div>
  );
}
