#!/usr/bin/env bash
# Despliega Interstellar Options al VPS.
#
#   bash scripts/deploy-vps.sh
#
# Se construye AQUÍ y se sube el resultado: en el VPS (1 vCPU / 961MB, con
# gatsby y koenigbauer-web ya corriendo) `next build` moriría por memoria.
#
# LO IMPORTANTE DE ESTE GUION SON LOS --exclude. `rsync --delete` borra en el
# destino todo lo que no esté en el origen, y ya se llevó por delante dos veces
# cosas que solo viven en el servidor:
#   · .env.local  → el servicio no arrancaba ("Failed to load environment files")
#   · data/       → el push del token fallaba ("No such file or directory")
# Son estado del servidor, no artefactos del build. Nunca deben viajar ni
# borrarse.
set -euo pipefail

# Node vive bajo nvm y no está en el PATH de un shell no interactivo.
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

VPS="${TITO_VPS:-root@142.93.255.19}"
DESTINO=/root/tito
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WEB"

echo "▸ Construyendo…"
npm run build >/dev/null

echo "▸ Subiendo servidor…"
rsync -az --delete \
  --exclude='.env.local' \
  --exclude='data/' \
  .next/standalone/ "$VPS:$DESTINO/"

# El rastreo de `standalone` se deja módulos internos de Next que se requieren
# en tiempo de ejecución (llegaban 71 de 376 archivos de next/dist/lib y el
# servicio moría con MODULE_NOT_FOUND). Se superpone el paquete entero.
echo "▸ Completando node_modules/next…"
rsync -az node_modules/next/ "$VPS:$DESTINO/node_modules/next/"

echo "▸ Subiendo estáticos…"
rsync -az --delete .next/static/ "$VPS:$DESTINO/.next/static/"
[ -d public ] && rsync -az public/ "$VPS:$DESTINO/public/"

echo "▸ Asegurando estado del servidor…"
ssh -o BatchMode=yes "$VPS" "mkdir -p $DESTINO/data && chmod 700 $DESTINO/data"

# Comprobación antes de reiniciar: sin entorno el servicio entra en bucle de
# reinicios y es más difícil de leer que un fallo aquí.
if ! ssh -o BatchMode=yes "$VPS" "test -f $DESTINO/.env.local"; then
  echo "✗ Falta $DESTINO/.env.local en el VPS. Créalo antes de reiniciar." >&2
  exit 1
fi

echo "▸ Empujando access token de Schwab…"
python3 scripts/schwab-push.py || echo "  (aviso: el push falló; la cadena de opciones no funcionará)"

echo "▸ Reiniciando…"
ssh -o BatchMode=yes "$VPS" "systemctl restart tito"
sleep 6
estado=$(ssh -o BatchMode=yes "$VPS" "systemctl is-active tito")
echo "▸ Estado: $estado"
[ "$estado" = "active" ] || { ssh -o BatchMode=yes "$VPS" "journalctl -u tito -n 12 --no-pager | tail -6"; exit 1; }
echo "✓ Desplegado en http://100.105.244.125:3000"
