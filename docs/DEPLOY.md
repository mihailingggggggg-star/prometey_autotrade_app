# Деплой демо-контура на сервер

Один процесс `node server/index.ts` отдаёт **и API, и собранный интерфейс** с одного порта:
приложение и данные живут по одному адресу, CORS и второй тоннель не нужны.

⚠️ Установка идёт в СВОЙ каталог и СВОЮ службу. Живой фьючерсный контур (`pump_screener`,
`pump_bot`, служба `pump_bot`) на том же сервере этим не затрагивается — не переиспользуйте
его каталог и не перезапускайте его службы.

⚠️ **Аутентификации в V1 нет.** Порт слушает только `127.0.0.1`, наружу выводим через тоннель.
Публичный доступ означает, что любой, кто узнает адрес, сможет читать и менять ключи и кошелёк.

## Установка с нуля

```bash
# Node 24 — сервер запускает TypeScript нативно, сборки серверной части нет
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v                     # ожидается v24.x

# код в отдельный каталог
sudo mkdir -p /opt/solana_swing && sudo chown "$USER" /opt/solana_swing
git clone https://github.com/mihailingggggggg-star/prometey_autotrade_app.git /opt/solana_swing
cd /opt/solana_swing
cp .env.example .env        # DATA_MODE=mock — ключи не нужны
npm ci && npm run build
```

Служба (`<пользователь>` — тот же, от кого лежит каталог):

```bash
sudo tee /etc/systemd/system/solana_swing.service >/dev/null <<'UNIT'
[Unit]
Description=Solana Swing Bot (демо): API и интерфейс
After=network.target

[Service]
WorkingDirectory=/opt/solana_swing
ExecStart=/usr/bin/node /opt/solana_swing/server/index.ts
Restart=always
RestartSec=3
User=<пользователь>

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now solana_swing
curl -s 127.0.0.1:8788/api/health
```

Доступ снаружи (адрес меняется при рестарте тоннеля, поэтому нигде не хардкодится):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

Открывать нужно адрес тоннеля целиком: он отдаёт и интерфейс, и API.

## Обновление на сервере — одна команда

```bash
cd /opt/solana_swing && git fetch origin && git reset --hard origin/main && git clean -fd \
  && npm ci && npm run build && sudo systemctl restart solana_swing \
  && curl -s 127.0.0.1:8788/api/health
```

`git reset --hard` + `git clean -fd` удаляют все старые файлы, которые исчезли из репозитория
(прежние экраны фьючерсов, `tools/`, `public/api.txt`), и при этом **не трогают** `.env`,
`data/` и `node_modules` — они в `.gitignore`.

## Полная чистка («удалить действительно всё»)

Если нужно снести и служебные каталоги, а `.env` с базой сохранить:

```bash
cd /opt/solana_swing \
  && mkdir -p /tmp/keep && cp -a .env data /tmp/keep/ 2>/dev/null \
  && git fetch origin && git reset --hard origin/main && git clean -fdx \
  && cp -a /tmp/keep/.env /tmp/keep/data . 2>/dev/null \
  && npm ci && npm run build && sudo systemctl restart solana_swing \
  && curl -s 127.0.0.1:8788/api/health
```

`git clean -fdx` удаляет и игнорируемые файлы — то есть `.env`, `data/` и `node_modules`;
именно поэтому они копируются в `/tmp` заранее.

## Проверка после обновления

```bash
systemctl status solana_swing --no-pager | head -5
journalctl -u solana_swing -n 30 --no-pager        # в логах не должно быть значений ключей
curl -s 127.0.0.1:8788/api/health                  # {"ok":true,"mode":"mock",...}
curl -s -o /dev/null -w "%{http_code}\n" 127.0.0.1:8788/          # 200 — интерфейс отдаётся
```

## Бэкап демо-данных

```bash
cd /opt/solana_swing && cp data/demo.db "data/demo-$(date +%F).db"
```
