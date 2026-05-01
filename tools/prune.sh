#!/bin/bash

# ============================
#   DOCKME PRUNE
# ============================
# Ejecuta la limpieza de imágenes Docker según el modo indicado.
# Uso: prune.sh [disabled|conservative|normal|aggressive]
# Escribe el espacio liberado en check-progress.json para la tarjeta
# de métricas de la UI.

PRUNE_MODE="${1:-disabled}"
PROGRESS_FILE="/app/data/config/check-progress.json"


if [ "$PRUNE_MODE" = "disabled" ]; then
    echo "🧹 Prune desactivado"
    exit 0
fi

# Marcar status como "pruning" para que la UI lo muestre
python3 - << PYEOF
import json, os

progress_file = "$PROGRESS_FILE"
# Leer existente o crear estructura mínima si no existe
if os.path.exists(progress_file):
    try:
        with open(progress_file, "r") as f:
            data = json.load(f)
    except:
        data = {}
else:
    data = {"percent": 100, "lastCheck": "", "pruneSpace": ""}

data["status"] = "pruning"
data["pruneSpace"] = ""
with open(progress_file, "w") as f:
    json.dump(data, f, separators=(',', ':'))
PYEOF

case "$PRUNE_MODE" in
    conservative)
        PRUNE_CMD='docker image prune -f --filter "until=48h"'
        ;;
    normal)
        PRUNE_CMD='docker image prune -a -f --filter "until=48h"'
        ;;
    aggressive)
        PRUNE_CMD='docker image prune -a -f'
        ;;
    *)
        echo "⚠️ Modo desconocido: '$PRUNE_MODE', usando conservative"
        PRUNE_CMD='docker image prune -f --filter "until=48h"'
        ;;
esac

echo "=== Limpiando imágenes Docker (modo: $PRUNE_MODE) [$(date '+%d-%m-%Y %H:%M:%S')] ==="
prune_output=$(eval "$PRUNE_CMD" 2>&1 || true)
echo "$prune_output"

# Extraer espacio liberado
reclaimed=$(echo "$prune_output" | grep -i "Total reclaimed space" | sed 's/.*: //' || echo "")

# Formatear: solo mostrar si supera 100 MB
format_space() {
    echo "$1" | awk '{
        n = $0; gsub(/[A-Z]+/, "", n)
        u = $0; gsub(/[0-9.]+/, "", u)
        mb = n
        if (u == "KB") mb = n / 1024
        else if (u == "B")  mb = n / 1048576
        else if (u == "GB") mb = n * 1024
        else if (u == "TB") mb = n * 1048576
        if (mb < 100) { print ""; exit }
        if (u == "GB") {
            dec = n - int(n)
            if (dec == 0) printf "%d GB\n", int(n)
            else printf "%.1f GB\n", n
        } else {
            printf "%d %s\n", int(n + 0.5), u
        }
    }' | sed 's/\.\([0-9]\)/,\1/'
}

prune_space=""
if [ -n "$reclaimed" ] && ! echo "$reclaimed" | grep -qi "^0 B\|^0B"; then
    prune_space=$(format_space "$reclaimed")
fi

if [ -n "$prune_space" ]; then
    echo "🧹 Espacio liberado: $prune_space"
else
    echo "🧹 Nada que limpiar."
fi

# Actualizar pruneSpace y restaurar status a idle en check-progress.json
python3 - << PYEOF
import json, os

progress_file = "$PROGRESS_FILE"
if os.path.exists(progress_file):
    try:
        with open(progress_file, "r") as f:
            data = json.load(f)
    except:
        data = {}
else:
    data = {"percent": 100, "lastCheck": ""}

data["status"]     = "idle"
data["pruneSpace"] = "$prune_space"
with open(progress_file, "w") as f:
    json.dump(data, f, separators=(',', ':'))
PYEOF

echo "✅ Prune completado [$(date '+%d-%m-%Y %H:%M:%S')]"