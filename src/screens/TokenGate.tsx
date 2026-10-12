/**
 * Экран «нужен ключ доступа» — то, что видит человек при ответе 401 вместо
 * пустого (белого или чёрного) экрана.
 *
 * Ключ вводится руками и проверяется ДО сохранения: кандидат отправляется на
 * аутентифицированный маршрут (api.probeAuth) с заголовком X-Api-Token, и только
 * принятый ключ ложится в localStorage. Так неверный ввод не оставляет в
 * хранилище мусор, а следующий опрос поднимает гейт снова.
 *
 * Сам ключ в интерфейсе не показывается никогда — ни здесь, ни в «Профиле».
 */
import { useState } from "react";
import { KeyRound } from "lucide-react";
import { probeAuth, setToken, UnauthorizedError } from "../lib/api";
import { Glass, Press, Title } from "../ui/kit";

export function TokenGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const v = value.trim();
    if (!v) {
      setError("введите ключ доступа");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await probeAuth(v); // неверный ключ здесь бросит UnauthorizedError
      setToken(v);
      onUnlocked();
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "ключ не подошёл — проверьте значение"
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="relative h-full flex flex-col justify-center px-4"
      style={{ paddingTop: "var(--safe-t)", paddingBottom: "var(--safe-b)" }}
    >
      <div className="mesh" aria-hidden />
      <div className="relative z-10">
        <Title sub="доступ к демо-контуру" mark={false}>Нужен ключ доступа</Title>

        <Glass flat className="rounded-[18px] p-4">
          <div className="flex items-start gap-2 mb-3">
            <KeyRound size={18} className="shrink-0 mt-0.5" style={{ color: "var(--tint-soft)" }} />
            <span className="text-[14px] leading-snug" style={{ color: "var(--label-2)" }}>
              Введите ключ доступа к демо-контуру — без него данные и действия недоступны.
            </span>
          </div>

          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="ключ доступа"
            className="w-full px-3 py-3 rounded-[12px] text-[15px] outline-none"
            style={{ background: "var(--bg-elev)", color: "var(--label)" }}
          />

          {error && (
            <p className="text-[13px] mt-2 leading-snug" style={{ color: "var(--orange)" }}>{error}</p>
          )}

          <Press onClick={save} disabled={busy} className="block w-full mt-3">
            <div
              className="flex items-center justify-center gap-2 py-3 rounded-[14px] text-[15px] font-semibold text-white"
              style={{ background: "var(--tint-grad)", opacity: busy ? 0.6 : 1 }}
            >
              Продолжить
            </div>
          </Press>
        </Glass>

        <p className="text-[12px] mt-3 px-1 leading-snug" style={{ color: "var(--label-3)" }}>
          Ключ хранится только в этом устройстве и больше нигде не показывается.
        </p>
      </div>
    </div>
  );
}
