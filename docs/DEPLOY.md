# Деплой демо-контура на сервер (Vultr, Ubuntu 22.04)

Один процесс `node server/index.ts` отдаёт **и API, и собранный интерфейс** с одного порта:
приложение и данные живут по одному адресу, CORS и второй тоннель не нужны.

## Три ловушки этого сервера (проверено на живом деплое)

1. **Порт 8788 занят живым автотрейдом** (`python3`, futures `webapi`). Демо-контур слушает
   **8790**. При совпадении портов демо-сервер не поднимется, а `curl` ответит чужой сервис —
   и это будет выглядеть как успешный запуск. Отличать по полям ответа: у нас `"mode"` и
   `"virtual_ts"`, у автотрейда `"service":"autotrade"`.
2. **Системный Node — v12**, ему нужен `/usr/bin/node`. Скрипт `npm` берёт интерпретатор из
   `PATH`, поэтому `/opt/node24/bin/npm` падает с `Cannot find module 'node:path'`. Лечится
   `export PATH=/opt/node24/bin:$PATH` — тогда `node` и `npm` берутся из `/opt/node24`.
3. **Системный Node не заменяем.** На этом же сервере под pm2 работает фьючерсный контур;
   апгрейд системного Node может его задеть. Поэтому Node 24 живёт отдельным каталогом.

⚠️ **Аутентификации в V1 нет.** Порт слушает только `127.0.0.1`, наружу — тоннелем.
Публичный доступ означает, что любой, кто узнает адрес, сможет читать и менять ключи и кошелёк.

⚠️ Установка идёт в свой каталог и свою службу. `pump_bot`, `prometey` и pm2 не трогаем.

## Установка с нуля

```bash
# 1. Осмотреться (ничего не меняет)
node -v; which node
ss -ltnp | grep -E '8790' || echo "8790 свободен"
systemctl list-units --type=service --state=running | grep -Ei 'pump|prometey|solana'

# 2. Node 24 отдельным каталогом, без apt
cd /tmp
curl -fsSLO https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz
echo "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6  node-v24.21.0-linux-x64.tar.xz" | sha256sum -c
sudo mkdir -p /opt/node24 && sudo tar -xJf node-v24.21.0-linux-x64.tar.xz -C /opt/node24 --strip-components=1
/opt/node24/bin/node -v            # v24.21.0

# 3. Код
sudo mkdir -p /opt/solana_swing && sudo chown "$USER":"$USER" /opt/solana_swing
git clone https://github.com/mihailingggggggg-star/prometey_autotrade_app.git /opt/solana_swing
cd /opt/solana_swing
cp .env.example .env               # DATA_MODE=mock, API_PORT=8790

# 4. Сборка — ВАЖНО: npm из /opt/node24 идёт первым в PATH
export PATH=/opt/node24/bin:$PATH
node -v                            # v24.21.0, а не v12
npm ci && npm run build
```

Служба (`<пользователь>` — владелец каталога, обычно `myuser`):

```bash
sudo tee /etc/systemd/system/solana_swing.service >/dev/null <<UNIT
[Unit]
Description=Solana Swing Bot (демо): API и интерфейс
After=network.target

[Service]
WorkingDirectory=/opt/solana_swing
ExecStart=/opt/node24/bin/node /opt/solana_swing/server/index.ts
Restart=always
RestartSec=3
User=$USER

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now solana_swing
sudo systemctl status solana_swing --no-pager | head -5
curl -s 127.0.0.1:8790/api/health     # ожидается {"ok":true,"mode":"mock",...}
```

Доступ снаружи (адрес меняется при каждом рестарте тоннеля, поэтому нигде не хардкодится):

```bash
cloudflared tunnel --url http://127.0.0.1:8790 --no-autoupdate
```

Открывать адрес тоннеля целиком — он отдаёт и интерфейс, и API.

## Постоянный адрес (делается один раз)

Quick tunnel выдаёт новый адрес при каждом рестарте: закрыли терминал — закладка на телефоне
ведёт в ошибку **1033**. Домен для постоянного адреса покупать не нужно — берём `sslip.io`
(публичный DNS, отдающий IP прямо из имени) и Caddy с сертификатом Let's Encrypt:

```bash
cd /opt/solana_swing && git fetch origin && git reset --hard origin/main \
  && export PATH=/opt/node24/bin:$PATH && sudo -E bash deploy/permanent_address.sh
```

Скрипт печатает итоговый адрес вида `https://solana.95-179-167-90.sslip.io`. Поддомен
`solana.` обязателен: на голом `<ip>.sslip.io` уже опубликован API автотрейда, и второй сайт на
то же имя переписал бы его конфиг.

Устройство скрипта, чтобы не было сюрпризов:

- **Проверяет, что на порту именно наш сервис** (`/api/health` содержит `"mode"`), а не соседний:
  опубликовать наружу чужой порт хуже, чем не сделать ничего.
- **Не переписывает чужой Caddyfile.** Наш сайт лежит отдельным файлом
  `/etc/caddy/solana_swing.caddy`, в основной конфиг добавляется одна строка `import`,
  а перед применением делается резервная копия и прогоняется `caddy validate` — неверный
  конфиг не может уронить уже работающие сайты.
- **Ставит пароль по умолчанию.** В приложении лежат ключи Helius/Gemini и секрет кошелька,
  а авторизации в V1 нет: без пароля постоянный адрес открывает доступ к кошельку всем.
  Пароль генерируется и лежит в `/etc/caddy/solana_swing.pass` (`sudo cat`), пользователь —
  `solana`. Отключить: `AUTH=off sudo -E bash deploy/permanent_address.sh`.
- Сертификат Caddy получает и продлевает сам; порты 80 и 443 должны быть открыты
  (80 нужен Let's Encrypt для проверки владения именем).

## Обновление — одна команда

```bash
cd /opt/solana_swing && bash deploy/update.sh
```

Скрипт делает всё в правильном порядке (свежий код с удалением исчезнувших файлов, зависимости,
сборка, перезапуск службы, проверка ответа) и падает с понятной причиной, если Node в `PATH`
не 24 — самая частая причина «сборка сломалась». Эквивалент вручную:

```bash
cd /opt/solana_swing && export PATH=/opt/node24/bin:$PATH \
  && git fetch origin && git reset --hard origin/main && git clean -fd \
  && npm ci && npm run build && sudo systemctl restart solana_swing \
  && curl -s 127.0.0.1:8790/api/health
```

`git reset --hard` + `git clean -fd` удаляют все старые файлы, исчезнувшие из репозитория
(прежние экраны фьючерсов, `tools/`, `public/api.txt`), и не трогают `.env`, `data/`
и `node_modules` — они в `.gitignore`.

## Полная чистка (всё, включая служебное)

`.env` и базу сохраняем заранее — `git clean -fdx` удаляет и игнорируемые файлы:

```bash
cd /opt/solana_swing && export PATH=/opt/node24/bin:$PATH \
  && mkdir -p /tmp/keep \
  && [ -f .env ] && cp -a .env /tmp/keep/ \
  && [ -d data ] && cp -a data /tmp/keep/ \
  && git fetch origin && git reset --hard origin/main && git clean -fdx \
  && cp -a /tmp/keep/.env . \
  && [ -d /tmp/keep/data ] && cp -a /tmp/keep/data . \
  && npm ci && npm run build && sudo systemctl restart solana_swing \
  && curl -s 127.0.0.1:8790/api/health
```

Копировать `.env` и `data/` одной командой `cp -a .env data .` нельзя: если `data/`
ещё не создан, копирование падает целиком и `.env` не восстанавливается — служба
поднимется с настройками по умолчанию и пустой базой.

## Проверка после обновления

```bash
systemctl status solana_swing --no-pager | head -5
journalctl -u solana_swing -n 30 --no-pager          # значений ключей быть не должно
curl -s 127.0.0.1:8790/api/health                    # {"ok":true,"mode":"mock",...}
curl -s -o /dev/null -w "%{http_code}\n" 127.0.0.1:8790/     # 200 — интерфейс отдаётся
ss -ltnp | grep 8790                                 # слушает только 127.0.0.1
```

Если служба перезапускается по кругу — смотреть `journalctl`; почти всегда это занятый порт
(`EADDRINUSE`) или не найденный `server/index.ts` из-за неверного `WorkingDirectory`.
