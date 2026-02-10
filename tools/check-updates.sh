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
TELEGRAM_TOKEN="${TELEGRAM_TOKEN}"
TELEGRAM_CHATID="${TELEGRAM_CHATID}"
HOSTNAME="${HOSTNAME:-Server}"
WEBHOOK_URL="${WEBHOOK_URL}"
ENDPOINT="${ENDPOINT}"
IS_AGENT=false
if [ -n "$WEBHOOK_URL" ] && [ -n "$ENDPOINT" ]; then
    IS_AGENT=true
fi

# ============================
#   COLORS
# ============================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[38;5;39m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ========================================
# Normalizar WEBHOOK_URL (base vs legacy)
# ========================================
WEBHOOK_ENDPOINT=""
if [ -n "$WEBHOOK_URL" ]; then
 if echo "$WEBHOOK_URL" | grep -qE 'https?://[^/]+/.+'; then
        # Modo legacy (compatibilidad)
        WEBHOOK_ENDPOINT="$WEBHOOK_URL"
        echo "⚠️ AVISO: WEBHOOK_URL incluye '/api/...'."
        echo " 👉 Debe actualizar el compose a:"
        echo "    WEBHOOK_URL=http://<host>:<puerto>"
    else
        WEBHOOK_ENDPOINT="${WEBHOOK_URL%/}/api/set-updates"
    fi
fi

# ============================
#   NOTIFICATION FUNCTIONS
# ============================
send_notif() {
   echo -e "\n${BLUE}Enviando notificación...${NC}"
    local message="$1"

    if [ -z "$TELEGRAM_TOKEN" ] || [ -z "$TELEGRAM_CHATID" ]; then
        return
    fi

    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
        -d chat_id="${TELEGRAM_CHATID}" \
        -d text="$message" \
        -d parse_mode="HTML" >/dev/null
}

send_webhook() {
    local updates_json="$1"
    curl -s -X POST "$WEBHOOK_ENDPOINT" \
        -H "Content-Type: application/json" \
        -d "{\"hostname\":\"$HOSTNAME\",\"endpoint\":\"$ENDPOINT\",\"updates\":$updates_json}" \
        >/dev/null
}

save_updates_local() {
    local updates_json="$1"
    local updates_file="/app/data/config/updates.json"
    python3 - <<EOF
import json
updates_file = "$updates_file"
updates = json.loads('$updates_json')
with open(updates_file, 'r') as f:
    data = json.load(f)
for host in data:
    if host.get("endpoint") == "Actual":
        host["updates"] = updates
with open(updates_file, 'w') as f:
    json.dump(data, f, indent=2)
EOF
}

# ============================
#   START
# ============================
echo "🕒 Lanzando chequeo $(date '+%d-%m-%Y %H:%M')"
echo -e "${BLUE}=== Chequeando actualizaciones de Docker ===${NC}"
declare -a updates_list=()

# ============================
#   PRE-CHECKS
# ============================
if [ ! -d "$STACKS_DIR" ]; then
    echo -e "${RED}Error: $STACKS_DIR no existe (volume no montado)${NC}"
    exit 1
fi
mapfile -t stack_dirs < <(find "$STACKS_DIR" -mindepth 1 -maxdepth 1 -type d | sort)
if [ ${#stack_dirs[@]} -eq 0 ]; then
    echo -e "${YELLOW}No se encontraron stacks en $STACKS_DIR${NC}"
    exit 0
fi
valid_stack_found=false

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
    echo -n -e "Analizando [${YELLOW}$stack_name${NC}]... "
    docker compose pull -q 2>/dev/null
    services=$(docker compose ps --services 2>/dev/null)
    if [ -z "$services" ]; then
        echo -e "${RED}Inactive (Saltando)${NC}"
        cd "$STACKS_DIR" || exit
        continue
    fi
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
                echo -e "${RED}Actualización encontrada!${NC}"
                local_has_update=true
            fi
            echo -e "  └─ ${CYAN}$service${NC}"
            updates_list+=("$stack_name|$service")
        fi
    done
    if [ "$local_has_update" = false ]; then
        echo -e "${GREEN}OK${NC}"
    fi
    cd "$STACKS_DIR" || exit
done
if [ "$valid_stack_found" = false ]; then
    echo -e "${YELLOW}No se encontró compose.yaml o docker-compose.yml${NC}"
    exit 0
fi

# ============================
#   CLEANUP
# ============================
echo -e "\n${BLUE}=== Limpiando imagenes huerfanas ===${NC}"
prune_output=$(docker image prune -f 2>&1 || true)
reclaimed=$(echo "$prune_output" | grep -i "Total reclaimed space" | sed 's/Total reclaimed space/Espacio recuperado/' || echo "")

if [ -z "$reclaimed" ]; then
    echo -e "${GREEN}Nada que limpiar.${NC}"
else
    echo -e "${YELLOW}$reclaimed${NC}"
fi

# ============================
#   SUMMARY
# ============================
if [ ${#updates_list[@]} -gt 0 ]; then
    echo -e "Estos stacks tienen actualizaciones pendientes:\n"
    printf "%-25s | %-25s\n" "STACK" "SERVICIO"
    printf "%s\n" "--------------------------+--------------------------"
    for item in "${updates_list[@]}"; do
        IFS='|' read -r stack service <<< "$item"
        printf "${YELLOW}%-25s${NC} | ${CYAN}%-25s${NC}\n" "$stack" "$service"
    done
    stacks_formatted=$(printf "%s\n" "${updates_list[@]}" | cut -d'|' -f1 | sort -u | sed 's/^/- /')
    msg="🐋 $HOSTNAME Updates:"$'\n'"$stacks_formatted"
    send_notif "$msg"

# ============================
#   FORMAT WEBHOOK
# ============================
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
    if [ -n "$WEBHOOK_URL" ] && [ -n "$ENDPOINT" ]; then
        WEBHOOK_BASE=$(echo "$WEBHOOK_URL" | sed 's#/api/.*##')
        echo -e "\n${BLUE}🌐 Enviando updates a $WEBHOOK_BASE${NC}"
        send_webhook "$updates_json"
    else
        echo "🖥️ Guardando updates localmente"
        save_updates_local "$updates_json"
    fi
else
    echo -e "${GREEN}No hay actualizaciones. Todos los stacks están actualizados!${NC}"
fi
echo "🕒 Última comprobación: $(date '+%d-%m-%Y %H:%M')"