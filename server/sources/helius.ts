/**
 * sources/helius.ts — LIVE-источник слоя 2 (концентрация холдеров) и метрики
 * мейкеров. Несмотря на имя файла (историческое), сейчас говорит с Solana RPC
 * через FluxRPC: ключ владельца едет В АДРЕСЕ (query), поэтому URL никогда не
 * выводим в лог/ошибку — его маскирует config.redactUrl.
 *
 * Доля топ-10 = сумма крупнейших токен-аккаунтов / эмиссия. Счета пулов
 * ИСКЛЮЧАЕМ до подсчёта — иначе баланс самого пула дал бы мнимую «концентрацию»
 * у любого токена. Опознаём двумя способами: (1) по ПРОГРАММЕ AMM — authority
 * токен-аккаунта принадлежит программе-маркет-мейкеру из AMM_PROGRAMS; (2) по
 * разметке RugCheck (адрес счёта или его владелец в knownAccounts, плюс
 * markets[].liquidityA/B). RugCheck одного способа мало: у Meteora владелец
 * vault'а — обычный System-кошелёк, поэтому метка лежит на самом адресе счёта.
 * Если пулы опознать не удалось — исключаем крупнейший счёт (подпись в checks).
 *
 * Число уникальных мейкеров за сутки — по выборке сделок GeckoTerminal
 * (ЧАСТИЧНАЯ: одна страница ≈300 сделок). Доля топ-10 при отсутствии RPC берётся
 * из Jupiter (audit.topHoldersPercentage), а FluxRPC, если задан, — уточняющее
 * измерение (исключает счета пулов). Прирост холдеров за 24ч и органичность —
 * из Jupiter (stats24h.holderChange, organicScore). Число холдеров — из отчёта
 * RugCheck, иначе из Jupiter.
 */
import { getEnv, ApiError } from "../config.ts";
import { netJson } from "./net.ts";
import { tradesMakers } from "./geckoterminal.ts";
import { poolForToken } from "./dexscreener.ts";
import { poolAccountsFor, holdersCountFor } from "./rugcheck.ts";
import { jupiterToken, type JupiterToken } from "./jupiter.ts";
import type { SourceRef, HolderData } from "./mock.ts";

const RPC_INTERVAL_MS = 200;

/**
 * Программы AMM Solana, по которым опознаём счёт пула (решение оркестратора от
 * 12.10.2026). Почему именно эти: это крупнейшие маркет-мейкеры сети, чьи
 * vault-счета держат ликвидность пула. Их баланс — не кошелёк холдера; если его
 * оставить в топ-10, «концентрация» раздувается (у MINI 38.94% через RPC против
 * ожидаемых ~3.5%, потому что баланс пула остался в сумме). RugCheck помечает
 * как AMM лишь часть счетов пула, поэтому опознаём по ПРОГРАММЕ: владелец счёта
 * (authority) сам принадлежит программе из списка ⇒ это пул.
 */
const AMM_PROGRAMS = new Set<string>([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // Raydium CPMM
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpool
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // Meteora DLMM
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", // Meteora DAMM v2
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", // Meteora Dynamic AMM
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // pump.fun AMM
]);

interface RpcResp<T> {
  result?: T;
  error?: { code: number; message: string };
}

/** Один аккаунт из getMultipleAccounts(jsonParsed): нужен owner и его authority. */
interface RawAccount {
  owner?: string;
  data?: { parsed?: { info?: { owner?: string } } };
}
interface MultiAccountsResp {
  value?: (RawAccount | null)[];
}

/**
 * Счета пулов среди переданных токен-аккаунтов — ПО ПРОГРАММЕ. Два батч-запроса
 * (getMultipleAccounts): сначала authority каждого счёта, затем программа,
 * которой принадлежит эта authority. Если программа — AMM, счёт исключаем.
 * Возврат: множество адресов-пулов; бросает, если RPC не ответил (вызывающий
 * решает, как честно деградировать).
 */
async function poolAccountsByProgram(addrs: string[]): Promise<Set<string>> {
  const pools = new Set<string>();
  if (!addrs.length) return pools;
  const first = await rpc<MultiAccountsResp>("getMultipleAccounts", [addrs, { encoding: "jsonParsed" }]);
  const list = first.value ?? [];
  const authorities: { addr: string; authority: string }[] = [];
  list.forEach((acc, i) => {
    const authority = acc?.data?.parsed?.info?.owner;
    if (authority && addrs[i]) authorities.push({ addr: addrs[i], authority });
  });
  // Ни один счёт не разобран как токен-аккаунт (jsonParsed не дал authority) —
  // программу определить НЕ удалось: пусть вызывающий честно деградирует, а не
  // принимает пустой набор за «пулов нет».
  if (!authorities.length) throw new ApiError("rpc_unparsed", 502, "FluxRPC: счета не разобраны (нет authority)");
  const second = await rpc<MultiAccountsResp>("getMultipleAccounts", [
    authorities.map((a) => a.authority),
    { encoding: "jsonParsed" },
  ]);
  const owners = second.value ?? [];
  authorities.forEach((a, k) => {
    const program = owners[k]?.owner;
    if (program && AMM_PROGRAMS.has(program)) pools.add(a.addr);
  });
  return pools;
}

interface LargestResp {
  value?: { address: string; amount?: string; uiAmount?: number | null; decimals?: number }[];
}
interface SupplyResp {
  value?: { amount?: string; decimals?: number; uiAmount?: number | null };
}

/** URL FluxRPC из окружения. Пустой — RPC не настроен. */
function rpcUrl(): string {
  return getEnv("FLUX_RPC_URL").trim();
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const url = rpcUrl();
  if (!url) throw new ApiError("missing_key", 400, "FLUX_RPC_URL не задан");
  const resp = await netJson<RpcResp<T>>(url, {
    minIntervalMs: RPC_INTERVAL_MS,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
  });
  if (resp.error) {
    // Сырое сообщение провайдера наружу НЕ отдаём: в нём могут быть детали
    // запроса (в т.ч. ключ). Клиенту — понятная формулировка без содержания.
    throw new ApiError("rpc_error", 502, `FluxRPC: запрос «${method}» отклонён провайдером`);
  }
  return resp.result as T;
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

export interface LiveHolderData extends HolderData {
  /** Что именно исключено из суммы топ-10 (для честной подписи слоя 2 в checks). */
  top10_excluded_note?: string;
}

export async function holders(ref: SourceRef): Promise<LiveHolderData> {
  const out: LiveHolderData = {
    top10_holders_pct: 0,
    // Число холдеров из отчёта RugCheck, если оно было.
    holders: holdersCountFor(ref.token_addr) ?? 0,
    holders_growth_pct: 0,
    makers_24h: 0,
    avg_trade_usd: 0,
    // Прирост холдеров недоступен без индексатора — проверка не блокирует.
    holders_growth_na: true,
  };

  // Метаданные Jupiter (кэш вселенной уже прогрет отбором кандидатов): прирост
  // холдеров за 24ч, органичность и — при отсутствии RPC — доля топ-10. Ошибка
  // Jupiter не роняет слой: поля останутся «нет данных», без выдумок.
  let jup: JupiterToken | null = null;
  try {
    jup = await jupiterToken(ref.token_addr);
  } catch {
    /* Jupiter недоступен — см. ниже */
  }
  if (jup) {
    if (out.holders === 0 && jup.holder_count > 0) out.holders = jup.holder_count;
    // ПОРОГ holders_growth_min трактуется как рост ЗА 7 ДНЕЙ (решение владельца),
    // а Jupiter даёт изменение ЗА СУТКИ (stats24h.holderChange, %). Своей истории
    // холдеров у нас пока нет, поэтому честно ОЦЕНИВАЕМ недельный рост из
    // суточного (×7); подпись в checks это проговаривает. Иначе живой недельный
    // рост ~4% выглядел бы как суточные 0.59% и кандидат зря отбраковывался.
    if (jup.holders_change_24h_pct !== null) {
      out.holders_growth_pct = r2(jup.holders_change_24h_pct * 7);
      out.holders_growth_na = false;
    }
    if (jup.organic_score !== null) out.organic_score = r2(jup.organic_score);
    if (jup.organic_label) out.organic_label = jup.organic_label;
  }

  // Мейкеры за сутки — по выборке сделок пула (не зависит от RPC). ВАЖНО:
  // недоступность GeckoTerminal (429/сеть) или отсутствие пула — это «замер НЕ
  // состоялся» (makers_na), а НЕ честный ноль. Иначе троттлинг молча отбраковал
  // бы кандидата проверкой wash_filter (нужно ≥ maker_min). Честный ноль (данные
  // пришли, адресов в выборке нет) остаётся нулём и блокирует как раньше.
  try {
    const pool = await poolForToken(ref.token_addr);
    if (pool) {
      const mk = await tradesMakers(pool);
      out.makers_24h = mk.makers;
      out.makers_partial = mk.partial;
    } else {
      out.makers_na = true;
      out.makers_note = "нет данных о сделках";
    }
  } catch {
    // 429/сеть/нет сделок: замер НЕ состоялся (не путать с честным нулём).
    out.makers_na = true;
    out.makers_note = "нет данных о сделках";
  }

  // Доля топ-10. ДВА метода измерения — РАЗНЫЕ пороги и подписи в checks:
  //  • RPC (FluxRPC), если задан, — точное измерение с ИСКЛЮЧЕНИЕМ счетов пулов
  //    (top10_source="rpc"): сравнимо с top10_max из настроек.
  //  • нет RPC — audit.topHoldersPercentage из Jupiter, но он ВКЛЮЧАЕТ счёт пула
  //    (top10_source="jupiter"): это верхняя оценка, с top10_max несопоставимая,
  //    сигнал по ней не блокируем (иначе без ключа контур снова мёртв).
  // Нет ни того, ни другого — честное «нет данных» (top10_na).
  if (!rpcUrl()) {
    if (jup?.top10_holders_pct !== null && jup?.top10_holders_pct !== undefined) {
      out.top10_holders_pct = r2(jup.top10_holders_pct);
      out.top10_source = "jupiter";
    } else {
      out.top10_na = true;
    }
    return out;
  }
  try {
    const [largest, supply] = await Promise.all([
      rpc<LargestResp>("getTokenLargestAccounts", [ref.token_addr]),
      rpc<SupplyResp>("getTokenSupply", [ref.token_addr]),
    ]);
    const dec = supply.value?.decimals ?? 0;
    const total = supply.value?.uiAmount ?? Number(supply.value?.amount ?? 0) / 10 ** dec;
    const accounts = (largest.value ?? []).filter((a) => a.address);
    if (!accounts.length) {
      // Крупнейших счетов нет вовсе — измерить нельзя: верхняя оценка или «нет данных».
      if (jup?.top10_holders_pct !== null && jup?.top10_holders_pct !== undefined) {
        out.top10_holders_pct = r2(jup.top10_holders_pct);
        out.top10_source = "jupiter";
      } else {
        out.top10_na = true;
      }
      return out;
    }
    const ui = (a: { amount?: string; uiAmount?: number | null }) =>
      typeof a.uiAmount === "number" ? a.uiAmount : Number(a.amount ?? 0) / 10 ** dec;
    // Исключаем счета пулов ДО отбора топ-10, иначе пул вытеснит реальных холдеров.
    // Первый проход — RugCheck knownAccounts (дешёвый, из уже закэшированного отчёта);
    // второй — по ПРОГРАММЕ AMM: authority счёта принадлежит программе-маркет-мейкеру.
    const rugExcluded = poolAccountsFor(ref.token_addr);
    const exclude = new Set(rugExcluded);
    let programDetermined = false;
    try {
      for (const a of await poolAccountsByProgram(accounts.map((x) => x.address as string))) exclude.add(a);
      programDetermined = true;
    } catch {
      programDetermined = false;
    }
    if (programDetermined) {
      out.top10_excluded_note = rugExcluded.size
        ? "счета пулов исключены (RugCheck + программа AMM)"
        : "счета пулов исключены по программе AMM";
    } else {
      // Программу определить не удалось — исключаем крупнейший счёт, честно подписывая.
      exclude.add(accounts[0].address as string);
      out.top10_excluded_note = "без крупнейшего счёта (предположительно пул)";
    }
    const top = accounts.filter((a) => !exclude.has(a.address as string)).slice(0, 10);
    const sum = top.reduce((s, a) => s + ui(a), 0);
    out.top10_holders_pct = total > 0 ? r2((sum / total) * 100) : 0;
    out.top10_source = "rpc";
  } catch {
    // RPC не ответил — честно падаем на верхнюю оценку Jupiter, пометив источник.
    if (jup?.top10_holders_pct !== null && jup?.top10_holders_pct !== undefined) {
      out.top10_holders_pct = r2(jup.top10_holders_pct);
      out.top10_source = "jupiter";
    } else {
      out.top10_na = true;
    }
  }
  return out;
}
