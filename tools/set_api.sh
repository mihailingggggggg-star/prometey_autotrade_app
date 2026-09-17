#!/usr/bin/env bash
# Опубликовать адрес бота рядом с приложением (public/api.txt) и выложить.
#
# Зачем: адрес cloudflared-тоннеля меняется при его рестарте, и все уже
# установленные ярлыки после этого обращаются в никуда. Файл рядом с
# приложением — единственное место, правка которого лечит ВСЕ устройства
# сразу, не заставляя каждого человека переносить новый адрес руками.
#
#   bash tools/set_api.sh https://xxxx-yyyy.trycloudflare.com
#
# Адрес выдаёт команда /web в боте.
set -euo pipefail

URL="${1:-}"
[[ "$URL" =~ ^https://[^[:space:]]+$ ]] || {
  echo "нужен https-адрес: bash tools/set_api.sh https://…trycloudflare.com" >&2
  exit 2
}
URL="${URL%/}"

cd "$(dirname "$0")/.."
# Проверяем, что по адресу действительно отвечает бот. Опубликованный мёртвый
# адрес хуже отсутствующего: приложение будет молча стучаться в пустоту.
if ! curl -fsS --max-time 8 "$URL/api/health" >/dev/null; then
  echo "по адресу не отвечает /api/health — адрес не опубликован" >&2
  exit 1
fi

{
  echo "# Адрес бота для веб-версии. Обновляется командой tools/set_api.sh."
  echo "# Меняется при рестарте cloudflared-тоннеля; /web в боте показывает текущий."
  echo "$URL"
} > public/api.txt

git add public/api.txt
git commit -m "Адрес бота: $URL"
git push
echo "опубликовано: $URL — устройства подхватят после сборки Pages (~минута)"
