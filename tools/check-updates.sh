#!/bin/bash

# ============================
#   DOCKME UPDATE CHECKER
# ============================
# Based on docge-update-check by Phil_Goud
# https://github.com/PhilGoud/docge-update-check
# License: MIT
# Modified and extended for Dockme project
# ============================


# ============================
#   DEBUG INFO
# ============================
#echo "=== DEBUG CRON ===" >> /tmp/cron-debug.log
#env >> /tmp/cron-debug.log
#which docker >> /tmp/cron-debug.log 2>&1
#docker ps >> /tmp/cron-debug.log 2>&1

# ============================
#   FIXED CONFIGURATION
# ============================
STACKS_DIR="/opt/stacks"
HOSTNAME="${HOSTNAME:-Server}"
WEBHOOK_URL="${WEBHOOK_URL}"
ENDPOINT="${ENDPOINT}"
PRUNE_MODE="${1:-disabled}"   # disabled | conservative | normal | aggressive
IS_AGENT=false
if [ -n "$WEBHOOK_URL" ] && [ -n "$ENDPOINT" ]; then
    IS_AGENT=true
fi

# ========================================
# Normalizar WEBHOOK_URL (añadir http:// si falta, compatibilidad con legacy)
# ========================================
WEBHOOK_ENDPOINT=""
if [ -n "$WEBHOOK_URL" ]; then
    if echo "$WEBHOOK_URL" | grep -qE 'https?://[^/]+/.+'; then
        # Modo legacy: URL completa con /api/... — usar tal cual
        WEBHOOK_ENDPOINT="$WEBHOOK_URL"
        echo "⚠️ AVISO: WEBHOOK_URL incluye '/api/...'."
        echo " 👉 Debe actualizar el compose a:"
        echo "    CENTRAL_URL=<host>:<puerto>"
    elif echo "$WEBHOOK_URL" | grep -qE 'https?://'; then
        # Tiene http:// pero sin path — añadir /api/set-updates
        WEBHOOK_ENDPOINT="${WEBHOOK_URL%/}/api/set-updates"
    else
        # Sin protocolo — añadir http://
        WEBHOOK_ENDPOINT="http://${WEBHOOK_URL%/}/api/set-updates"
    fi
fi

# ============================
#   NOTIFICATION FUNCTIONS
# ============================
send_webhook() {
    local updates_json="$1"
    curl -s --retry 3 --retry-delay 30 --retry-connrefused -X POST "$WEBHOOK_ENDPOINT" \
        -H "Content-Type: application/json" \
        -d "{\"hostname\":\"$HOSTNAME\",\"endpoint\":\"$ENDPOINT\",\"updates\":$updates_json}" \
        >/dev/null
}

save_updates_local() {
    local updates_json="$1"
    # POST al API Node (mismo contenedor, puerto 5002 — acceso directo sin nginx).
    # Permite que set-updates detecte el fin de ciclo igual que los agentes.
    if curl -sf -X POST "http://localhost:5002/api/set-updates" \
        -H "Content-Type: application/json" \
        -d "{\"hostname\":\"$HOSTNAME\",\"endpoint\":\"Actual\",\"updates\":$updates_json}" \
        -m 5 >/dev/null 2>&1; then
        return 0
    fi
    # Fallback: escritura directa si el API local no responde
    echo "⚠️ API local no disponible, guardando updates directamente"
    python3 - << PYEOF
import json
try:
    with open("/app/data/config/updates.json", "r") as f:
        data = json.load(f)
    for host in data:
        if host.get("endpoint") == "Actual":
            host["updates"] = json.loads('$updates_json')
    with open("/app/data/config/updates.json", "w") as f:
        json.dump(data, f, indent=2)
except Exception as e:
    print(f"Error: {e}")
PYEOF
}

PROGRESS_FILE="/app/data/config/check-progress.json"

# ============================
#   START
# ============================
echo "🕒 Lanzando chequeo $(date '+%d-%m-%Y %H:%M')"
echo "=== Chequeando actualizaciones de Docker ==="
declare -a updates_list=()

# ============================
#   PRE-CHECKS
# ============================
if [ ! -d "$STACKS_DIR" ]; then
    echo "Error: $STACKS_DIR no existe (volume no montado)"
    exit 1
fi
mapfile -t stack_dirs < <(find "$STACKS_DIR" -mindepth 1 -maxdepth 1 -type d | sort)
if [ ${#stack_dirs[@]} -eq 0 ]; then
    echo "No se encontraron stacks en $STACKS_DIR"
    exit 0
fi
valid_stack_found=false
total_stacks=${#stack_dirs[@]}
processed_stacks=0

# Escribir estado inicial
cat > /app/data/config/check-progress.json << EOF
{"status":"checking","percent":0,"lastCheck":null}
EOF

# ============================
#   MAIN LOOP
# ============================
for stack_path in "${stack_dirs[@]}"; do
    stack_name=$(basename "$stack_path")
    if [[ -f "$stack_path/compose.yaml" ]]; then
        compose_file="compose.yaml"
    elif [[ -f "$stack_path/docker-compose.yml" ]]; then
        compose_file="docker-compose.yml"
    else
        continue
    fi
    valid_stack_found=true
    cd "$stack_path" || continue
    echo -n "Analizando [$stack_name]... "

    # Primero verificar si el stack tiene servicios activos
    services=$(docker compose ps --services 2>/dev/null)
    if [ -z "$services" ]; then
        echo "Inactivo (Saltando)"
        processed_stacks=$((processed_stacks + 1))
        percent=$((processed_stacks * 100 / total_stacks))
        cat > /app/data/config/check-progress.json << EOF
{"status":"checking","percent":${percent},"lastCheck":null}
EOF
        cd "$STACKS_DIR" || exit
        continue
    fi

    # Solo hacer pull si el stack está activo
    docker compose pull -q 2>/dev/null
    local_has_update=false
    for service in $services; do
        container_id=$(docker compose ps -q "$service")
        [ -z "$container_id" ] && continue
        image_name=$(docker inspect --format '{{.Config.Image}}' "$container_id")
        running_image_id=$(docker inspect --format '{{.Image}}' "$container_id")
        local_image_id=$(docker image inspect --format '{{.Id}}' "$image_name" 2>/dev/null)
        [ -z "$local_image_id" ] && continue
        if [ "$running_image_id" != "$local_image_id" ]; then
            if [ "$local_has_update" = false ]; then
                echo "Actualizacion encontrada!"
                local_has_update=true
            fi
            echo "  └─ $service"
            updates_list+=("$stack_name|$service")
        fi
    done
    if [ "$local_has_update" = false ]; then
        echo "OK"
    fi
    processed_stacks=$((processed_stacks + 1))
    percent=$((processed_stacks * 100 / total_stacks))
    cat > /app/data/config/check-progress.json << EOF
{"status":"checking","percent":${percent},"lastCheck":null}
EOF
    cd "$STACKS_DIR" || exit
done
if [ "$valid_stack_found" = false ]; then
    echo "No se encontro compose.yaml o docker-compose.yml"
    exit 0
fi

# ============================
#   FORMAT WEBHOOK
# ============================
if [ ${#updates_list[@]} -gt 0 ]; then
    updates_json="["
    first_stack=true
    for stack in $(printf "%s\n" "${updates_list[@]}" | cut -d'|' -f1 | sort -u); do
        services=$(printf "%s\n" "${updates_list[@]}" | grep "^$stack|" | cut -d'|' -f2)
        dockers_json="["
        first_service=true
        for svc in $services; do
            [ "$first_service" = true ] || dockers_json+=","
            first_service=false
            dockers_json+="\"$svc\""
        done
        dockers_json+="]"
        [ "$first_stack" = true ] || updates_json+=","
        first_stack=false
        updates_json+="{\"stack\":\"$stack\",\"dockers\":$dockers_json}"
    done
    updates_json+="]"
else
    echo "No hay actualizaciones. Todos los stacks estan actualizados!"
    updates_json="[]"
fi

# Siempre notificar al central (con updates o sin ellas) para señalar fin de ciclo
if [ -n "$WEBHOOK_URL" ] && [ -n "$ENDPOINT" ]; then
    WEBHOOK_BASE=$(echo "$WEBHOOK_ENDPOINT" | sed 's#/api/.*##')
    echo "🌐 Enviando updates a $WEBHOOK_BASE"
    send_webhook "$updates_json"
else
    echo "🖥️ Enviando updates al API local"
    save_updates_local "$updates_json"
fi
# ============================
#   PRUNE (antes de cerrar el ciclo)
# ============================
/tools/prune.sh "$PRUNE_MODE" 2>&1 | tee -a /tmp/prune.log

# Leer pruneSpace que dejó prune.sh en check-progress.json
prune_space=$(python3 -c "
import json
try:
    d = json.load(open('$PROGRESS_FILE'))
    print(d.get('pruneSpace',''))
except:
    print('')
" 2>/dev/null || echo "")

# ============================
#   ESTADO FINAL
# ============================
lastCheck=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat > /app/data/config/check-progress.json << PROGRESSEOF
{"status":"idle","percent":100,"lastCheck":"${lastCheck}","pruneSpace":"${prune_space}"}
PROGRESSEOF
echo "🕒 Última comprobación: $(date '+%d-%m-%Y %H:%M')"