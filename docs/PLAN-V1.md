# SOLANA SWING BOT · V1 (DEMO) — ТЗ, архитектура, контракты

> Рабочая спецификация V1 — единственный источник правды для исполнителей.
> Продукт: спотовая свинг-торговля Solana (DEX) + скринер токенов в фазе накопления.
> V1 — **демо-контур**: рыночные данные настоящие (или синтетика в `mock`), исполнение виртуальное,
> старт $500 + $500/мес. Транзакции в блокчейн не отправляются ни при каких условиях.
>
> Репозиторий: `~/prometey_autotrade_app` (существующее приложение). Фьючерсная логика ПРОМЕТЕЯ
> (экраны, `src/lib/mock.ts`, связь с `autotrade_bot/webapi.py`) удаляется целиком: у продукта
> другая стратегия, другой рынок, другой контур данных. Живой фьючерсный контур скринера
> (`~/pump_screener`) этим проектом не затрагивается.

## 1. Стек и состав репозитория

Одна кодовая база, один язык — TypeScript. Новых зависимостей НЕ добавляем.

- **Сервер** `server/`: Node.js 24 (TypeScript запускается нативно: `node server/index.ts`),
  HTTP — `node:http`, БД — `node:sqlite`, шифрование — `node:crypto`, HTTP-запросы — встроенный `fetch`.
  Сборки нет, зависимостей нет.
- **Клиент** `web`-часть — текущий `src/`: React 18 + Vite + Tailwind 4 + `lightweight-charts` 5 + `lucide-react`
  + `clsx` + `tailwind-merge` + `motion` (всё уже стоит в `package.json`).
- **Общий контракт** `shared/types.ts` — типы запросов/ответов, импортируются и сервером, и клиентом.

```
prometey_autotrade_app/
├── package.json           # владелец: оркестратор (скрипты server/dev/dev:all, прокси)
├── vite.config.ts         # владелец: оркестратор (proxy /api → 127.0.0.1:8788)
├── .env.example           # владелец: оркестратор
├── docs/PLAN-V1.md        # этот документ
├── scripts/dev.mjs        # владелец: оркестратор (поднимает сервер + vite одной командой)
├── shared/types.ts        # владелец: оркестратор — замороженный контракт
├── server/                # владелец: исполнитель A
│   ├── index.ts           # HTTP-роутер, порт 8788, слушает ТОЛЬКО 127.0.0.1
│   ├── config.ts          # чтение/запись .env, дефолты, режим DATA_MODE
│   ├── db.ts              # схема node:sqlite (§4) + хелперы
│   ├── screener.ts        # воронка слоёв 1–5 (§6)
│   ├── demo.ts            # демо-движок исполнения (§7)
│   ├── keys.ts            # маскирование ключей, шифрование кошелька, запись .env
│   ├── sources/
│   │   ├── mock.ts        # детерминированная синтетика (без ключей и без сети)
│   │   ├── dexscreener.ts # поиск пулов, цена, OHLCV
│   │   ├── rugcheck.ts    # burned liq, mint/freeze
│   │   ├── helius.ts      # top-10 holders, уникальные мейкеры, прирост холдеров
│   │   ├── jupiter.ts     # цена/котировка
│   │   └── gemini.ts      # промпты §8
│   └── tests/             # node:test: воронка, движок, секреты, роуты
└── src/                   # владелец: исполнитель B
    ├── App.tsx, main.tsx, theme.css, index.html
    ├── nav/TabBar.tsx     # 4 таба
    ├── lib/{api.ts,useApi.ts,format.ts,pwa.ts}
    ├── screens/{Feed,CoinDetail,Positions,Analytics,Profile}.tsx
    └── ui/{PriceChart.tsx,kit.tsx,Plot.tsx,Logo.tsx}
```

**Сохраняем как есть** (переиспользуется): `index.html`, `src/theme.css`, `src/ui/kit.tsx`,
`src/ui/Plot.tsx`, `src/ui/Logo.tsx`, `src/ui/TradeChart.tsx` (рабочий пример `lightweight-charts` v5 —
читать как образец API и как источник готовых приёмов), `src/lib/format.ts`, `src/lib/pwa.ts`,
`src/nav/TabBar.tsx` (переделывается под 4 таба).

**Переписываются заново:** `src/main.tsx` (вместо bootstrap-цепочки `bootApi`/`initTelegram` —
импорт `theme.css` и рендер `App`), `src/App.tsx` (вместо фьючерсного — табы и экраны §9).

**Уже удалены** (фьючерсная логика): все прежние `src/screens/*`, `src/mount.tsx` и
`src/lib/{api,mock,agg,market,useMarket,flow,useFlow,liquidity,stats,store,swipe,tg,lock,push,useServer,boot}.ts(x)`.
История сохранена — старый файл доступен как `git show HEAD~1:src/<путь>`.

## 2. Режимы работы

- `DATA_MODE=mock` (по умолчанию) — всё считается по синтетике, ключи не нужны, сеть не нужна.
  В mock-режиме **виртуальные часы ускорены**: каждый цикл обслуживания (60 с) двигает мир вперёд на
  `demo.tick_minutes` (по умолчанию 360 — то есть шесть виртуальных часов за минуту реального времени,
  примерно 15 виртуальных суток за реальный час). Это позволяет за один вечер увидеть, как позиция
  доходит до x2, срабатывает Free Riding, истекает time-stop и просаживается ликвидность.
  Медленный тик делает демо-контур мёртвым: растущий токен за шесть виртуальных часов не проходит
  и процента пути, и Free Riding не наступает никогда.
- `DATA_MODE=live` — DexScreener / RugCheck / Helius / Jupiter / Gemini. Интерфейс источников
  одинаков в обоих режимах: `screener.ts` и `demo.ts` не знают, откуда данные.

Сервер слушает только `127.0.0.1:8788`. В dev-режиме Vite проксирует `/api` на него — CORS не нужен.
Авторизации в V1 нет: сервер локальный. **Перед выносом наружу (тоннель/сервер) обязателен этап
аутентификации** — в текущем виде ключи и кошелёк доступны любому, кто дотянется до порта.

## 3. Модель данных (`data/demo.db`, node:sqlite)

Время — UTC, секунды (`ts`).

- `signals(id, ts, token_addr, symbol, name, pair_addr, price, liq_usd, mc_usd, age_days, tf_accum,
  score, status, checks_json, metrics_json, social_json, overview_ru, sentiment, is_organic)`
  `status`: `new | taken | skipped | archived`.
- `positions(id, signal_id, token_addr, symbol, entry_price, qty, usd_in, fees_usd, slippage_usd,
  tp_price, tp_percent, status, free_ride_done, realized_usd, peak_price, opened_ts, closed_ts,
  close_reason, note)` → `status`: `open | free_ride | closed`;
  `close_reason`: `manual | tp_50 | tp_full | time_stop | liq_drain`.
- `fills(id, position_id, ts, kind, price, qty, usd, fee_usd, slippage_usd)` → `kind`: `open | add | tp_50 | close | partial`.
- `deposits(id, ts, usd, kind)` → `kind`: `initial | monthly | manual`.
- `settings(key, value_json, updated_ts)` — одна строка на ключ (§9).
- `audit(id, ts, actor, action, payload_json)` — настройки, ключи, сделки.
- `alerts(id, ts, position_id, kind, message, severity, seen)` → `kind`: `free_ride | time_stop | liq_drain | tp_reached`; `severity`: `info | warn | critical`.
- `keys_meta(key_name, is_set, updated_ts, preview)` — **значения ключей в БД не хранятся**, только в `.env`.

## 4. HTTP API (JSON, `http://127.0.0.1:8788`)

Ошибки: `{"error":{"code":"...","message":"..."}}`, HTTP 4xx/5xx. Числа — числами. Типы — в `shared/types.ts`.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/health` | `{ok, mode, keys:{helius,gemini,telegram,wallet}, ts, virtual_ts}` |
| GET | `/api/signals?limit=&status=` | лента сигналов |
| GET | `/api/signals/:id` | карточка: `{signal, checks[], indicators{}, overview_ru, social{}}` |
| POST | `/api/scan` | скан сейчас → `{found, ids[]}` (в mock добавляет 3–5 сигналов) |
| GET | `/api/candles?token=&tf=1m|5m|1h|1d&limit=` | `[[ts,o,h,l,c,v], ...]` по возрастанию ts |
| GET | `/api/positions?status=` | позиции + `current_price, pnl_usd, pnl_pct` |
| POST | `/api/positions/open` | `{signal_id, usd, order_type:"market"|"limit", limit_price?, tp_percent?, tp_mode:"free_ride"|"manual"}` |
| POST | `/api/positions/:id/add` | `{usd}` — докупка, пересчёт средней цены |
| POST | `/api/positions/:id/tp` | `{tp_price}` — перетащили линию ТП на графике |
| POST | `/api/positions/:id/close` | `{fraction: 0..1}` → `{position, fill}` |
| GET | `/api/trades?limit=` | закрытые сделки, net-результат после издержек |
| GET | `/api/analytics/summary` | `{balance, deposited, equity, equity_curve, winrate, avg_profit_pct, by_outcome, trades_count, open_count}` |
| GET | `/api/settings` / PUT | настройки (§9), PUT — частичный, с валидацией на сервере и записью в audit |
| GET | `/api/keys/status` | `{telegram_bot_token:{set,preview}, …, wallet:{set,address,preview}}` — **значений нет** |
| PUT | `/api/keys` | `{telegram_bot_token?, telegram_chat_id?, helius_api_key?, gemini_api_key?, wallet_secret?}` |
| GET | `/api/alerts?unseen=1` / POST `/api/alerts/:id/seen` | алерты движка |
| POST | `/api/deposits` | `{usd}` — пополнение |
| GET | `/api/audit?limit=` | журнал действий |

`preview` ключа — первые 4 и последние 2 символа (`abcd…12`); для кошелька — публичный адрес вместо превью.

## 5. Воронка скринера (`server/screener.ts`)

Каждая проверка отдаётся в UI как элемент чек-листа:
`{layer, code, label_ru, ok, value, threshold}`. Сигнал попадает в ленту, когда слои 1–4 пройдены
и слой 5 даёт `sentiment_score >= 6` и `is_organic === true`.

- **Слой 1 · RugCheck:** `burned_liq == 100`, mint authority revoked, freeze authority revoked.
- **Слой 2 · Helius:** `top10_holders_pct < top10_max` (по умолчанию 15), пулы и биржи исключены.
- **Слой 3 · DexScreener:** возраст `age_min..age_max` (30–180 дней), ликвидность `liq_min..liq_max` ($20k–$150k).
- **Слой 4 · накопление и защита от накрутки:** `tight_range` (за `range_days` цена в коридоре ±`range_pct`),
  `drawdown_from_ath` (−70…−90%), `holders_growth` (≥ `holders_growth_min` за 7д),
  `wash_filter` (уникальных мейкеров ≥ `maker_min`; выключенный тумблер не блокирует, но проверка остаётся видимой).
- **Слой 5 · Gemini:** промпт 2 (§7) → `sentiment`, `is_organic`, `summary`. Промпт 1 → `overview_ru`.
  При сбое LLM сигнал НЕ создаётся (не создавать «на веру»).

## 6. Демо-движок (`server/demo.ts`)

1. **Размер позиции** — сумма из запроса (быстрые $10/$25/$50/$100 или кастом); дефолт в интерфейсе — 2% баланса.
2. **Издержки** удерживаются при входе и при выходе: комиссия пула `pool_fee_pct` + проскальзывание
   `slippage_min..slippage_max` (псевдослучайно из интервала, фиксируется в `fills`). Результат — net.
3. **Free Riding:** при цене `+tp_percent` (по умолчанию +100%, то есть x2) движок автоматически
   фиксирует `tp1_fraction` (50%) объёма: возвращён вложенный капитал, риск = $0, статус → `free_ride`,
   алерт `free_ride`. Остаток 50% летит бесплатно до ручного выхода, до цели 2 или до time-stop/liq-drain.
   **Цель 2 по умолчанию x5** (`free_ride.tp2_percent = 400`), а не +100%: если цель совпадает с
   триггером, «бесплатный полёт» длится один тик обслуживания и вся идея стратегии исчезает —
   остаток продаётся сразу после фиксации половины.
4. **Time-stop:** нет импульса за `time_stop_days` (по умолчанию 21, диапазон 14–30) → алерт `time_stop`
   с рекомендацией закрытия. Автозакрытия нет — решение за пользователем, факт фиксируется.
5. **Liquidity drain:** ликвидность пула за 7 дней после входа упала более чем на `liq_drain_pct` (30%) →
   алерт `liq_drain` с severity `critical`.
6. Обслуживание: раз в 60 с и на каждом чтении `/api/positions`; события идемпотентны (алерты не дублируются).
7. `winrate` — доля закрытых сделок с net > 0. `by_outcome`: `closed_zero` (в ноль/минус),
   `reached_x2` (дошло до +100%), `reached_x5` (дошло до +400%).
8. Баланс: старт `DEMO_START_BALANCE` (500), пополнение `DEMO_MONTHLY_DEPOSIT` (500) кнопкой,
   всё в `equity_curve`.

## 7. Промпты Gemini (`server/sources/gemini.ts`)

- **Промпт 1 (описание):** венчурный крипто-аналитик, формат из трёх пунктов — что за проект / кто
  основатель и комьюнити / к какому нарративу привязан. Без рекламного мусора.
- **Промпт 2 (соцфильтр):** строгий JSON `{"sentiment_score":0..10,"is_organic":true|false,"summary":"…"}`.
  Парсер переживает JSON внутри текста и пустой ответ: при сбое — 0 / false / "" (и сигнал не создаётся).

## 8. Настройки (`settings`, ключи из интерфейса «Профиль»)

```
screener:  {age_min:30, age_max:180, liq_min:20000, liq_max:150000, top10_max:15,
            wash_filter:true, llm_filter:true, range_days:14, range_pct:18,
            drawdown_min:70, drawdown_max:90, holders_growth_min:3, maker_min:120}
demo:      {start_balance:500, monthly_deposit:500, pool_fee_pct:0.25, slippage_min_pct:3,
            slippage_max_pct:5, time_stop_days:21, liq_drain_pct:30, tick_minutes:360}
free_ride: {tp1_percent:100, tp1_fraction:0.5, tp2_percent:400}
```
Валидация — на сервере (типы, диапазоны, `min <= max`), каждое изменение — в `audit`.

## 9. Интерфейс (`src/`)

Нижние табы: **Сигналы · Позиции · Аналитика · Профиль**. Язык — русский, обращение на «вы».
Цифры цен — монотипно, тёмная тема, плотная сетка, без «детских» градиентов; адаптив от 360px.

1. **Сигналы (главный).** Компактные карточки: логотип, тикер, цена, ТФ накопления, плашка статуса
   («Фаза накопления подтверждена»). Кнопка «Сканировать». Клик → детальный экран.
2. **Детальный экран монеты** сверху вниз:
   - график `lightweight-charts` с ТФ 1m/5m/1h/1D и **перетаскиваемой линией ТП**; кнопка быстрой
     установки ТП «+100% с фиксацией 50%» (Free Riding);
   - терминал: Market/Limit, суммы $10/$25/$50/$100/кастом, кнопка «Купить токен (USDT)»,
     кнопка «Закрыть всю позицию по рынку» с показом расчётного проскальзывания;
   - блок индикаторов (SVD, On-Chain Volume, Liquidity Flow) и зелёный чек-лист фильтров
     (значение и порог рядом с каждым пунктом);
   - сворачиваемое описание монеты (`overview_ru`);
   - карточка-тизер соцсетей (`sentiment`, `is_organic`, `summary`), клик → модальное окно с лентой упоминаний.
3. **Позиции.** Карточки: токен, размер в USDT, PnL в % и $, цена входа, текущая цена, метка Free Ride.
   Клик → тот же детальный экран (двигать ТП, докупать, закрывать).
4. **Аналитика.** График прироста депозита с пополнениями, винрейт, средний профит, распределение
   исходов (в ноль / x2 / x5), таблица закрытых сделок с издержками и проскальзыванием.
5. **Профиль.** Ключи (маскированные поля + «Сохранить»), ползунки и тумблеры скринера (§8),
   демо-баланс, кнопка пополнения, журнал последних действий (`/api/audit`).

## 10. Фазы и критерии готовности

| Фаза | Содержание | Критерий готовности |
|---|---|---|
| 0 | Скелет сервера и новый каркас клиента, контракт, mock-источники | `npm run server` отвечает на `/api/health`, `npm run build` проходит, `node --test server/tests` зелёный |
| 1 | Лента + детальный экран (график, ТП-линия, терминал, чек-лист, описание, соцлента) | «Сканировать» даёт сигналы, карточка открывается, ТП двигается, покупка создаёт позицию |
| 2 | Демо-движок (издержки, Free Riding, time-stop, liq-drain), раздел «Позиции» | позиция доходит до x2 → авто-фиксация 50% + алерт; PnL net |
| 3 | «Аналитика» + «Профиль» (ключи, ползунки, аудит) | ключи пишутся в `.env` и не отдаются наружу; ползунок реально меняет прохождение слоя 3 |
| 4 | `live`-источники и Telegram-уведомления | скан на живых данных находит токены; Gemini пишет `overview_ru` и `social` |

## 11. Общие правила

- Комментарии и логи — русский; идентификаторы — английский; тексты для пользователя — на «вы».
- Новых зависимостей не добавлять: только то, что уже в `package.json` + стандартная библиотека Node.
- Время — UTC. Ничего не читать из будущего. Все денежные расчёты — net после издержек.
- Секреты только в `.env` (chmod 600); в API, БД и логах — только `set` и `preview`.
- Команда `timeout` на машине владельца отсутствует — не использовать в скриптах.
- Проверки: `npm run build`, `npx tsc -b --noEmit`, `node --test server/tests/`, ручной смоук
  `curl -s localhost:8788/api/health`.
