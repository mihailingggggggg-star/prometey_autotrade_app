import { Component, type ReactNode } from "react";

/**
 * Последний рубеж: любая необработанная ошибка рендера.
 *
 * Без него React размонтирует всё дерево — человек видит БЕЛЫЙ ЭКРАН и не
 * может сказать о поломке ничего, кроме «не работает». Именно так выглядела
 * встреча нового интерфейса со старым ботом: он падал на отсутствующем поле,
 * а снаружи это читалось как «пропала кнопка».
 *
 * Поэтому здесь показываются ровно те две вещи, которые нужны для диагноза:
 * текст ошибки и отметка сборки.
 */
export class Boom extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };

  static getDerivedStateFromError(err: Error) {
    return { err };
  }

  componentDidCatch(err: Error) {
    console.error("[app]", err);
  }

  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ padding: "22px 20px", color: "#fff", fontSize: 15, lineHeight: 1.45 }}>
        <div style={{ fontSize: 19, fontWeight: 700, marginBottom: 8 }}>
          Приложение не запустилось
        </div>
        <p style={{ color: "rgba(235,235,245,.6)", marginTop: 0 }}>
          Чаще всего это значит, что бот на сервере старее приложения — обновите
          его и откройте заново.
        </p>
        <pre style={{
          whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12,
          background: "rgba(255,255,255,.06)", padding: 12, borderRadius: 12,
          color: "rgba(235,235,245,.75)",
        }}>{String(this.state.err?.message || this.state.err)}</pre>
        <div style={{ fontSize: 11, color: "rgba(235,235,245,.3)" }}>
          сборка {__BUILD__}
        </div>
        <button onClick={() => location.reload()}
                style={{ marginTop: 16, width: "100%", padding: "14px 0", border: 0,
                         borderRadius: 16, background: "#0a84ff", color: "#fff",
                         fontSize: 16, fontWeight: 600 }}>
          Перезагрузить
        </button>
      </div>
    );
  }
}
