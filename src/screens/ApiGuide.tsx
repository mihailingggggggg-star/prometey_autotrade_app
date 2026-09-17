import { AlertTriangle, ExternalLink } from "lucide-react";
import { Glass, Press } from "../ui/kit";

const STEPS: { t: string; d: string }[] = [
  { t: "Откройте раздел API", d: "Bybit → аватар в правом верхнем углу → «API». Прямая ссылка: bybit.com/app/user/api-management" },
  { t: "Нажмите «Create New Key»", d: "Выберите тип «System-generated API Keys» — это обычный ключ, без подписи запросов сторонним сертификатом." },
  { t: "Назначение — «API Transaction»", d: "Не «Third-party App». Бот работает напрямую через API биржи." },
  { t: "Название ключа", d: "Любое понятное вам, например «Prometheus». Оно нужно только чтобы отличать ключи между собой." },
  { t: "Права: только чтение и торговля", d: "Отметьте «Contract — Orders, Positions» и «Unified Trading — Trade». Право «Withdraw» НЕ включайте — боту оно не нужно." },
  { t: "Привязка по IP — по желанию", d: "Если укажете IP сервера, ключ станет безопаснее. Без привязки Bybit ограничивает срок жизни ключа 90 днями." },
  { t: "Подтвердите операцию", d: "Bybit попросит код из почты и 2FA-приложения." },
  { t: "Скопируйте оба значения", d: "API Key и API Secret. Секрет показывается ОДИН раз — если закроете окно, ключ придётся создавать заново." },
  { t: "Вставьте их в приложение", d: "Кабинет → API-ключи Bybit → вставить → «Подключить». Мы сразу проверим связь и покажем баланс." },
];

export function ApiGuide() {
  return (
    <div className="pb-3">
      <Glass flat className="p-3.5 flex items-start gap-2.5 mb-3">
        <AlertTriangle size={18} style={{ color: "var(--orange)" }} className="shrink-0 mt-0.5" />
        <div className="text-[13px] leading-snug">
          Никогда не выдавайте право <b>на вывод средств</b> и не пересылайте секрет
          в переписке. Наша поддержка никогда его не спрашивает.
        </div>
      </Glass>

      <ol className="space-y-2.5">
        {STEPS.map((s, i) => (
          <li key={i}>
            <Glass flat className="p-3.5 flex gap-3">
              <span className="flex items-center justify-center w-6 h-6 rounded-full shrink-0 text-[13px] font-bold text-white"
                    style={{ background: "var(--tint)" }}>{i + 1}</span>
              <div>
                <div className="text-[15px] font-medium leading-snug">{s.t}</div>
                <div className="text-[13px] mt-1 leading-snug" style={{ color: "var(--label-2)" }}>{s.d}</div>
              </div>
            </Glass>
          </li>
        ))}
      </ol>

      <Press className="block w-full mt-3">
        <Glass flat className="py-3.5 flex items-center justify-center gap-2 text-[15px] font-medium"
               style={{ color: "var(--tint)" }}>
          Открыть Bybit <ExternalLink size={16} />
        </Glass>
      </Press>
    </div>
  );
}
