#!/usr/bin/env bash
# Обновление демо-контура на сервере: свежий код, сборка, перезапуск, проверка.
#
# Запуск из каталога проекта:  bash deploy/update.sh
#
# Зачем скрипт, если есть та же команда в docs/DEPLOY.md: команду из трёх строк
# легко повторить наполовину — например, забыть `export PATH` и уехать на системный
# Node 12 (сборка падает на `node:path`), или забыть `git clean -fd` и оставить
# файлы, которые из репозитория уже удалены. Скрипт делает это в правильном
# порядке и в конце сам проверяет, что сервис ответил.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/solana_swing}"
NODE_DIR="${NODE_DIR:-/opt/node24/bin}"
PORT="${API_PORT:-8790}"
SERVICE="${SERVICE:-solana_swing}"

cd "$APP_DIR"
export PATH="$NODE_DIR:$PATH"

# Проверяем интерпретатор до сборки: системный Node 12 умеет npm только как
# обёртку и падает на `node:path` — сообщение об этом ничего не объясняет.
if ! node -v | grep -q '^v24'; then
  echo "Node в PATH не v24, а $(node -v). Проверьте $NODE_DIR" >&2
  exit 1
fi

echo "── код: $(git rev-parse --short HEAD) → origin/main"
git fetch origin
git reset --hard origin/main
git clean -fd

echo "── зависимости и сборка"
npm ci
npm run build

echo "── перезапуск службы $SERVICE"
sudo systemctl restart "$SERVICE"
sleep 3

echo "── проверка"
curl -fsS "http://127.0.0.1:$PORT/api/health"
echo
systemctl is-active --quiet "$SERVICE" && echo "OK: $SERVICE работает" || { echo "FAIL: $SERVICE не поднялся, смотрите journalctl -u $SERVICE -n 50" >&2; exit 1; }
