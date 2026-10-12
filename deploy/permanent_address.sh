#!/usr/bin/env bash
# ПОСТОЯННЫЙ адрес демо-контура Solana. Один раз — и адрес больше не меняется.
#
# Что чинит. cloudflared quick tunnel выдаёт адрес заново при каждом рестарте:
# закрыли терминал — адрес умер, закладка на телефоне ведёт в ошибку 1033.
# Домен для этого покупать не нужно: sslip.io — публичный DNS, отдающий IP прямо
# из имени (1-2-3-4.sslip.io → 1.2.3.4), поэтому Let's Encrypt выдаёт на такое
# имя настоящий сертификат, а Caddy получает и продлевает его сам.
#
# Почему поддомен `solana.<ip>.sslip.io`, а не голый `<ip>.sslip.io`: на этом же
# сервере тем же способом уже опубликован API автотрейда (futures webapi,
# deploy/permanent_api.sh). Голое имя занято им — второй сайт на то же имя
# переписал бы его конфиг и уронил живой мини-апп.
#
# Почему сразу пароль. Приложение держит ключи Helius/Gemini и секрет кошелька,
# а авторизации в V1 нет: без пароля постоянный адрес означает открытый доступ
# к кошельку для любого, кто адрес узнает. Caddy закрывает это basic-авторизацией
# без правок в коде. Отключить: AUTH=off sudo -E bash deploy/permanent_address.sh
#
# Запуск:  sudo bash deploy/permanent_address.sh
set -euo pipefail

PORT="${API_PORT:-8790}"
SUBDOMAIN="${SUBDOMAIN:-solana}"
AUTH="${AUTH:-on}"
BASIC_USER="${BASIC_USER:-solana}"
PASS_FILE="${PASS_FILE:-/etc/caddy/solana_swing.pass}"
BLOCK_FILE="/etc/caddy/solana_swing.caddy"
MAIN_FILE="/etc/caddy/Caddyfile"
CHECKS_DIR="/etc/caddy/checks"
MARK="# solana_swing"

log() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "нужен sudo: sudo bash $0"

# ── 1. Адрес ──────────────────────────────────────────────────────────────
IP="$(curl -fsS --max-time 10 https://api.ipify.org)"
[[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "не удалось узнать внешний IP"
HOST="${SUBDOMAIN}.${IP//./-}.sslip.io"
log "постоянный адрес будет: https://$HOST"

getent hosts "$HOST" >/dev/null || die "DNS не отвечает про $HOST — проверьте сеть"

# ── 2. Наш ли сервис слушает порт ────────────────────────────────────────
# Проверяем ДО правки конфига: на этом сервере рядом живут чужие сервисы, и
# опубликовать наружу чужой порт по ошибке — хуже, чем ничего не сделать.
HEALTH="$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" || true)"
case "$HEALTH" in
  *'"mode"'*) log "на 127.0.0.1:$PORT отвечает демо-контур (режим $(printf '%s' "$HEALTH" | grep -o '"mode":"[a-z]*"' | cut -d'"' -f4))" ;;
  *) die "на 127.0.0.1:$PORT не демо-контур. Проверьте: sudo systemctl status solana_swing" ;;
esac

# ── 3. Caddy ──────────────────────────────────────────────────────────────
if ! command -v caddy >/dev/null; then
  log "── ставим caddy"
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

# Порты 80 и 443: 80 нужен Let's Encrypt для проверки владения именем.
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp  >/dev/null || true
  ufw allow 443/tcp >/dev/null || true
fi

# ── 4. Пароль ─────────────────────────────────────────────────────────────
AUTH_BLOCK=""
if [[ "$AUTH" == "on" ]]; then
  if [[ ! -s "$PASS_FILE" ]]; then
    NEWPASS="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-16)"
    printf '%s\n' "$NEWPASS" > "$PASS_FILE"
    chmod 600 "$PASS_FILE"
  fi
  NEWPASS="$(cat "$PASS_FILE")"

  # Директива basic-авторизации переименована в Caddy 2.8 (basicauth → basic_auth).
  # Ставим ту, которую понимает установленная версия, иначе caddy validate откажет.
  CADDY_VER="$(caddy version | sed 's/^v//' | cut -d. -f1,2)"
  if awk -v v="$CADDY_VER" 'BEGIN { split(v, a, "."); exit !(a[1] > 2 || (a[1] == 2 && a[2] >= 8)) }'; then
    AUTH_DIRECTIVE="basic_auth"
  else
    AUTH_DIRECTIVE="basicauth"
  fi
  HASH="$(caddy hash-password --plaintext "$NEWPASS")"
  AUTH_BLOCK="	${AUTH_DIRECTIVE} {
		${BASIC_USER} ${HASH}
	}
"
fi

# ── 5. Конфиг: свой блок отдельным файлом ────────────────────────────────
# Чужой конфиг (API автотрейда) не переписываем: наш сайт живёт в отдельном
# файле, а в основной добавляется одна строка import. Так правка идемпотентна
# и не может утащить за собой чужой сайт.
mkdir -p "$CHECKS_DIR"
cat > "$BLOCK_FILE" <<CADDY
$MARK — блок создан deploy/permanent_address.sh, правится только им.
$HOST {
$AUTH_BLOCK	reverse_proxy 127.0.0.1:$PORT
}
CADDY

touch "$MAIN_FILE"
if ! grep -qF "$MARK" "$MAIN_FILE"; then
  cp -a "$MAIN_FILE" "$MAIN_FILE.bak.$(date +%s)"
  {
    printf '\n'
    printf '%s\n' "$MARK — сайт демо-контура Solana (см. $BLOCK_FILE)"
    printf 'import %s\n' "$BLOCK_FILE"
  } >> "$MAIN_FILE"
  log "в $MAIN_FILE добавлена строка импорта (резервная копия рядом)"
fi

# Проверка ДО применения: неверный конфиг не должен уронить уже работающие сайты.
if ! caddy validate --config "$MAIN_FILE" >/tmp/caddy_validate.log 2>&1; then
  log "$(cat /tmp/caddy_validate.log)"
  die "конфиг Caddy невалиден — ничего не применяю. Разберитесь или откатите $MAIN_FILE из резервной копии"
fi

systemctl enable caddy >/dev/null 2>&1 || true
systemctl reload caddy 2>/dev/null || systemctl restart caddy

# ── 6. Ждём сертификат ───────────────────────────────────────────────────
log "── ждём сертификат Let's Encrypt (до 90 с)"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$HOST/api/health" >/dev/null 2>&1; then
    log ""
    log "✅ ГОТОВО. Постоянный адрес: https://$HOST"
    if [[ "$AUTH" == "on" ]]; then
      log "   Вход: пользователь «$BASIC_USER», пароль — в $PASS_FILE"
      log "   (пароль сохранён, чтобы вы могли его посмотреть: sudo cat $PASS_FILE)"
    else
      log "   ⚠️ авторизация ВЫКЛЮЧЕНА: приложение открыто всем, кто знает адрес"
    fi
    log "   Запасной путь: quick tunnel на 8790 остаётся рабочим."
    exit 0
  fi
  sleep 3
done

log "⚠️ сертификат пока не выдан. Работающие сайты не тронуты."
log "   Причина: journalctl -u caddy -n 50 --no-pager"
log "   Частая причина — закрыт порт 80: Let's Encrypt проверяет владение именем по нему."
exit 1
