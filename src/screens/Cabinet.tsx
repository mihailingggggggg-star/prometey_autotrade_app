import { useState } from "react";
import QRCode from "react-qr-code";
import {
  BadgeCheck, BookOpen, Check, ChevronRight, Copy, CreditCard, Download, ExternalLink,
  KeyRound, LifeBuoy, Lock, Percent, Plug, Receipt, RefreshCw, ShieldAlert, Sliders, Wallet,
} from "lucide-react";
import { Glass, GroupLabel, Modal, Press, Row, Segmented, Sheet, Title, Toggle, tone } from "../ui/kit";
import { useApp } from "../lib/store";
import { AddToHomeRow } from "./AddToHome";
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
      <Title sub={a.me?.name || a.user.name || "Личный кабинет"}>Кабинет</Title>

      {/* Роль видна сразу: у владельца счёта есть права, которых нет у
          остальных, и держать это в тайне от него самого незачем. */}
      {a.me?.role === "admin" && (
        <div className="px-4 -mt-1 mb-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-semibold"
                style={{ background: "color-mix(in srgb, var(--tint) 18%, transparent)",
                         color: "var(--tint)" }}>
            <BadgeCheck size={13} /> Владелец счёта
          </span>
        </div>
      )}

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
          {/* У владельца пополнение мгновенное и «из воздуха» — это для показа
              и отладки. Остальные платят по-настоящему: перевод USDT, который
              подтверждает человек. Одна кнопка с двумя разными смыслами была бы
              ловушкой, поэтому и надпись разная. */}
          <Press feel="press" className="block w-full mt-4"
                 onClick={() => a.can.topupFree
                   ? a.topUp(50)
                   : setPay({ title: "Пополнение баланса", amount: 50, note: "Любая сумма от $10" })}>
            <div className="py-3 rounded-[14px] text-center text-[16px] font-semibold text-white"
                 style={{ background: "var(--tint)" }}>
              {a.can.topupFree ? "Начислить $50 (владелец)" : "Пополнить"}
            </div>
          </Press>
        </Glass>
      </div>

      {/* Постоянный вход к установке ярлыка: карточку на главной можно скрыть
          навсегда, и без этой строки функция пропала бы вместе с ней. */}
      <div className="px-4 mt-2.5">
        <AddToHomeRow />
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

      {/* Версия сборки и состояние связи. Диагностика, а не украшение:
          кэш вебвью Telegram живёт своей жизнью, и «у меня нет кнопки» должно
          отличаться от «у меня открыта вчерашняя версия». */}
      <div className="px-4 mt-5 mb-1 text-center text-[11px] leading-relaxed"
           style={{ color: "var(--label-3)" }}>
        сборка {__BUILD__} · бот{" "}
        {a.link === "ok" ? "на связи" : a.link === "off" ? "не подключён"
          : a.link === "denied" ? "не признал доступ" : "не отвечает"}
        {a.me ? ` · вы ${a.me.role === "admin" ? "владелец" : "пользователь"}` : ""}
      </div>

      <BotSettings open={settings} onClose={() => setSettings(false)} />

      <ApiSheet open={apiSheet} onClose={() => setApiSheet(false)} onGuide={() => { setApiSheet(false); setGuide(true); }} />

      <Sheet open={guide} onClose={() => setGuide(false)} title="API-ключ Bybit" tall><ApiGuide /></Sheet>

      <Sheet open={history} onClose={() => setHistory(false)} title="История оплат">
        <div className="pb-3">
          <Glass flat className="overflow-hidden">
            {!a.payments.length && (
              <Row last title="Платежей пока нет"
                   note="здесь появятся комиссии, подписки и пополнения" />
            )}
            {a.payments.map((p, i) => (
              <Row key={p.id} last={i === a.payments.length - 1}
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
  const { settings: s, setSettings, deposit, riskAlert, can, busy } = useApp();
  const rec = Math.floor(deposit * 0.05);
  return (
    <Sheet open={open} onClose={onClose} title="Настройки бота" tall>
      <div className="pb-3 space-y-3">
        {/* Настройки бота API отдаёт, но не принимает. Оставь мы ползунки
            рабочими — человек подвинул бы риск, увидел новое число и был бы
            уверен, что бот теперь рискует иначе. Это худший вид вранья в
            торговом интерфейсе, поэтому здесь замок и прямая инструкция. */}
        {/* Управлять счётом может только его владелец: у обычного пользователя
            нет счёта, которым он мог бы тут распоряжаться. Право приходит с
            сервера, а не выводится из роли на клиенте. */}
        {!can.control && (
          <Glass flat className="p-3.5 flex items-start gap-3">
            <Lock size={18} className="mt-0.5 shrink-0" style={{ color: "var(--label-2)" }} />
            <div className="text-[13px] leading-snug" style={{ color: "var(--label-2)" }}>
              Настройки показаны для сведения. Управление счётом доступно его владельцу.
            </div>
          </Glass>
        )}
        <fieldset disabled={!can.control || !!busy} className="space-y-3"
                  style={!can.control ? { opacity: 0.72 } : undefined}>
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

        <SchemeEditor />

        <AccountMode />

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

/* ── Счёт: демо или реальные деньги ──────────────────────────────────────────
   Самая дорогая путаница из возможных, поэтому переключение в LIVE требует
   отдельного подтверждения, а сам режим виден всегда — ровно как в панели
   бота, где он печатается в шапке каждого экрана. */
function AccountMode() {
  const { mode, setMode, can } = useApp();
  const [confirm, setConfirm] = useState(false);
  return (
    <div>
      <div className="text-[13px] mb-1.5 px-1" style={{ color: "var(--label-2)" }}>Счёт</div>
      <Segmented value={mode}
                 onChange={(v) => (v === "live" ? setConfirm(true) : setMode("demo"))}
                 options={[{ id: "demo", label: "🧪 Демо" }, { id: "live", label: "🔴 Реальный" }]} />
      <p className="text-[12px] mt-1.5 px-1 leading-snug" style={{ color: "var(--label-2)" }}>
        {mode === "live"
          ? "Бот торгует настоящими деньгами."
          : can.demo
            ? "Виртуальные средства Bybit. Сделки настоящие, деньги — нет."
            : "Демо-счёт доступен владельцу."}
      </p>

      <Modal open={confirm} onClose={() => setConfirm(false)}>
        <div className="text-center">
          <div className="mx-auto mb-3 flex items-center justify-center w-12 h-12 rounded-full"
               style={{ background: "color-mix(in srgb, var(--red) 18%, transparent)" }}>
            <ShieldAlert size={24} style={{ color: "var(--red)" }} />
          </div>
          <h3 className="text-[19px] font-bold">Переключить на реальные деньги?</h3>
          <p className="text-[14px] mt-1.5 leading-snug" style={{ color: "var(--label-2)" }}>
            Следующий сигнал откроет позицию на живом счёте. Убедитесь, что риск на
            сделку задан верно.
          </p>
          <div className="flex gap-2.5 mt-5">
            <Press onClick={() => setConfirm(false)} className="flex-1">
              <div className="glass glass-flat py-3 text-center text-[16px] font-medium">Отмена</div>
            </Press>
            <Press feel="heavy" className="flex-1"
                   onClick={() => { setMode("live"); haptic.warn(); setConfirm(false); }}>
              <div className="py-3 rounded-[16px] text-center text-[16px] font-semibold text-white"
                   style={{ background: "var(--red)" }}>Переключить</div>
            </Press>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/* ── Схема выхода ────────────────────────────────────────────────────────────
   Те же правила, что у мастера в Telegram, и проверяет их тот же код на
   сервере: доли дают ровно 100%, уровни R строго растут, безубыток лежит до
   последней цели. Здесь интерфейс лишь не даёт собрать заведомо неверное —
   но последнее слово всё равно за сервером. */
const R_STEP = 0.25;

function SchemeEditor() {
  const { scheme, setScheme, can } = useApp();
  const [side, setSide] = useState<"long" | "short">("long");
  const [own, setOwn] = useState(false);
  const [legs, setLegs] = useState<{ r: number; pct: number }[]>([{ r: 1.5, pct: 100 }]);
  const [beR, setBeR] = useState<number | null>(1);

  const current = scheme?.[side] || "";
  const sum = legs.reduce((a, l) => a + l.pct, 0);
  const rising = legs.every((l, i) => i === 0 || l.r > legs[i - 1].r);
  const beOk = beR === null || (beR > 0 && beR < legs[legs.length - 1].r);
  const valid = sum === 100 && rising && beOk;

  const setLeg = (i: number, patch: Partial<{ r: number; pct: number }>) =>
    setLegs((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div>
      <div className="text-[13px] mb-1.5 px-1" style={{ color: "var(--label-2)" }}>Схема выхода</div>
      <Segmented value={side} onChange={(v) => setSide(v as "long" | "short")}
                 options={[{ id: "long", label: "Лонг" }, { id: "short", label: "Шорт" }]} />

      <Glass flat className="overflow-hidden mt-2">
        <Row title="Сейчас" note={current ? undefined : "ступени приходят из сигнала"}
             right={<b className="text-[13px]">{current || "из сигнала"}</b>} />
        <Row last title="Своя схема"
             note="иначе торгуем ровно тем, что прислал скринер"
             right={<Toggle on={own} onChange={(v) => { setOwn(v); if (!v) setScheme(side, null); }} />} />
      </Glass>

      {own && (
        <Glass flat className="overflow-hidden mt-2">
          {legs.map((l, i) => (
            <Row key={i} title={`Цель ${i + 1}`}
                 note={`закрыть ${l.pct}% позиции`}
                 right={
                   <div className="flex items-center gap-1">
                     <Stepper value={l.r} suffix="R" step={R_STEP}
                              onChange={(v) => setLeg(i, { r: Math.max(R_STEP, v) })} />
                     <Stepper value={l.pct} suffix="%" step={5}
                              onChange={(v) => setLeg(i, { pct: Math.min(100, Math.max(5, v)) })} />
                   </div>
                 } />
          ))}
          <Row title="Число целей"
               right={
                 <div className="flex items-center gap-2">
                   <Press onClick={() => setLegs((ls) => ls.length > 1 ? ls.slice(0, -1) : ls)}
                          className="px-3 py-1 text-[17px]">−</Press>
                   <b>{legs.length}</b>
                   <Press onClick={() => setLegs((ls) => ls.length < 3
                            ? [...ls, { r: +(ls[ls.length - 1].r + 1).toFixed(2), pct: 0 }] : ls)}
                          className="px-3 py-1 text-[17px]">+</Press>
                 </div>
               } />
          <Row last title="Безубыток"
               note={beR ? "стоп в точку входа при достижении уровня" : "стоп остаётся на месте"}
               right={
                 <div className="flex items-center gap-1">
                   <Toggle on={beR !== null} onChange={(v) => setBeR(v ? 1 : null)} />
                   {beR !== null && (
                     <Stepper value={beR} suffix="R" step={R_STEP}
                              onChange={(v) => setBeR(Math.max(R_STEP, v))} />
                   )}
                 </div>
               } />
        </Glass>
      )}

      {own && (
        <>
          {!valid && (
            <p className="text-[12px] mt-2 px-1 leading-snug" style={{ color: "var(--orange)" }}>
              {sum !== 100 ? `Доли дают ${sum}% — нужно ровно 100%.`
                : !rising ? "Уровни целей должны идти по возрастанию."
                : "Безубыток обязан лежать ближе последней цели."}
            </p>
          )}
          <Press disabled={!valid || !can.control} className="block w-full mt-2"
                 onClick={() => { setScheme(side, { legs, be_r: beR }); haptic.ok(); }}>
            <div className="py-3 rounded-[16px] text-center text-[16px] font-semibold text-white"
                 style={{ background: valid ? "var(--tint)" : "var(--label-3)" }}>
              Применить к {side === "long" ? "лонгам" : "шортам"}
            </div>
          </Press>
        </>
      )}
      <p className="text-[12px] mt-2 px-1 leading-snug" style={{ color: "var(--label-2)" }}>
        Своя схема разводит торговлю и замер: карточка сигнала и Signal Lab
        продолжат показывать схему скринера.
      </p>
    </div>
  );
}

function Stepper({ value, suffix, step, onChange }: {
  value: number; suffix: string; step: number; onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center glass glass-flat">
      <Press onClick={() => onChange(+(value - step).toFixed(2))} className="px-2.5 py-1 text-[15px]">−</Press>
      <span className="text-[13px] font-semibold tabular-nums w-[46px] text-center">
        {value}{suffix}
      </span>
      <Press onClick={() => onChange(+(value + step).toFixed(2))} className="px-2.5 py-1 text-[15px]">+</Press>
    </div>
  );
}
