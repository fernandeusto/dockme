#!/bin/bash
set -e

START_TIME=$(date '+%d-%m-%Y %H:%M')
echo "===================="
echo "🚀 Iniciando Dockme"
echo "🕒 $START_TIME"
echo "===================="

# Compatibilidad: nuevos nombres de variables del compose → nombres internos
# CENTRAL_URL reemplaza a WEBHOOK_URL, AGENT_URL reemplaza a ENDPOINT
WEBHOOK_URL="${WEBHOOK_URL:-$CENTRAL_URL}"
ENDPOINT="${ENDPOINT:-$AGENT_URL}"
export WEBHOOK_URL ENDPOINT

# HOSTNAME es obligatorio - debe definirse en el compose
SYSTEM_HOSTNAME=$(hostname)
if [ "$HOSTNAME" = "$SYSTEM_HOSTNAME" ]; then
    echo "==================================="
    echo "❌ ERROR: HOSTNAME no configurado"
    echo ""
    echo "   Añade en tu docker-compose.yml:"
    echo "   environment:"
    echo "     - HOSTNAME=NombreDeServidor"
    echo "==================================="
    exit 1
fi
export HOSTNAME

DOCKME_VERSION="unknown"
if [ -f /tools/version.json ]; then
    DOCKME_VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /tools/version.json)
fi
echo "🧩 Versión: $DOCKME_VERSION"
# ========================================
# Detección automática del GID de Docker
# ========================================
DOCKER_SOCK="/var/run/docker.sock"

if [ -n "$DOCKER_GID" ]; then
    if ! getent group "$DOCKER_GID" > /dev/null 2>&1; then
        groupadd -g "$DOCKER_GID" docker_host 2>/dev/null || true
    fi
    usermod -aG "$DOCKER_GID" apps 2>/dev/null || true
fi

# ========================================
# Migración automática (estructura antigua → nueva)
# ========================================
if [ -d "/metadata/icons" ] || [ -d "/metadata/json" ]; then
    echo "🔄 Detectada estructura antigua, migrando a nueva estructura..."
    
    # Crear nueva estructura
    mkdir -p /app/data/icons
    mkdir -p /app/data/config
    mkdir -p /app/data/logs
    
    # Mover iconos (mv, no cp)
    if [ -d "/metadata/icons" ] && [ "$(ls -A /metadata/icons 2>/dev/null)" ]; then
        mv /metadata/icons/* /app/data/icons/ 2>/dev/null || true
        echo "  ✅ Iconos migrados"
    fi
    
    # Mover configuración JSON (mv, no cp)
    if [ -d "/metadata/json" ] && [ "$(ls -A /metadata/json 2>/dev/null)" ]; then
        mv /metadata/json/* /app/data/config/ 2>/dev/null || true
        echo "  ✅ Configuración migrada"
    fi
    
    # Eliminar /metadata completamente (forzado)
    rm -rf /metadata 2>/dev/null || true
    
    # Crear flag de inicialización (evitar bloque de instalación limpia)
    touch /app/data/config/.dockme-initialized
    echo "  ✅ Migración completada"
    echo ""
    echo "  ℹ️  IMPORTANTE: Puedes eliminar el volumen /metadata del docker-compose.yml"
    echo ""
fi

# ========================================
# Migración flag initialized (v1.9 → v1.10)
# ========================================
if [ -f "/app/data/.dockme-initialized" ] && [ ! -f "/app/data/config/.dockme-initialized" ]; then
    echo "🔄 Migrando flag de inicialización a nueva ubicación..."
    mv /app/data/.dockme-initialized /app/data/config/.dockme-initialized
    echo "✅ Flag migrado correctamente"
fi


# ========================================
# Inicialización de metadata (primera vez)
# ========================================
INIT_FLAG="/app/data/config/.dockme-initialized"

if [ ! -f "$INIT_FLAG" ]; then
    echo "🆕 Instalación limpia, creando configuración por defecto..."
    mkdir -p /app/data/icons
    mkdir -p /app/data/config
    cp -r /app/defaults/icons/* /app/data/icons/ 2>/dev/null || true
    # Crear updates.json inicial (host local)
    HOSTNAME_VALUE="${HOSTNAME:-Dockme}"
    printf '[{"hostname":"%s","endpoint":"Actual","updates":[]}]' "$HOSTNAME_VALUE" \
        > /app/data/config/updates.json
    touch "$INIT_FLAG"
    echo "✅ Configuración inicializada"
fi

# Crear stacks.json inicial
if [ ! -f "/app/data/config/stacks.json" ]; then
    printf '[]' > /app/data/config/stacks.json
fi
# Crear links.json si no existe
if [ ! -f "/app/data/config/links.json" ]; then
    printf '[]' > /app/data/config/links.json
fi
# Crear settings.json si no existe (recupera valores del compose y de updates.json si los hay)
if [ ! -f "/app/data/config/settings.json" ]; then
    python3 << 'PYEOF'
import json, os

# Hora del check: coger la primera si hay varias separadas por coma
check_times_raw = os.environ.get('CHECK_TIMES', '09:00')
check_time = check_times_raw.split(',')[0].strip()

tg_token  = os.environ.get('TELEGRAM_TOKEN',  '')
tg_chatid = os.environ.get('TELEGRAM_CHATID', '')

# Migrar primaryHost y release desde updates.json si existen
primary_host = ''
release = ''
try:
    with open('/app/data/config/updates.json', 'r') as f:
        updates = json.load(f)
    local = next((h for h in updates if h.get('endpoint','').lower() == 'actual'), {})
    primary_host = local.get('primaryHost', '')
    release      = local.get('release', '')
    # Limpiarlos de updates.json ahora que migran a settings.json
    changed = False
    for h in updates:
        if 'primaryHost' in h or 'release' in h:
            h.pop('primaryHost', None)
            h.pop('release', None)
            changed = True
    if changed:
        with open('/app/data/config/updates.json', 'w') as f:
            json.dump(updates, f, indent=2)
        print("✅ primaryHost y release migrados desde updates.json")
except Exception as e:
    print(f"⚠️ No se pudo leer updates.json para migración: {e}")

# Detectar si es agente remoto
webhook_url = os.environ.get('WEBHOOK_URL', '')
endpoint    = os.environ.get('ENDPOINT', '')
is_agent    = bool(webhook_url and endpoint and endpoint.lower() != 'actual')
# Añadir http:// si falta en la URL del central
if is_agent and webhook_url and not webhook_url.startswith('http'):
    webhook_url = 'http://' + webhook_url
central_url = webhook_url.rstrip('/') if is_agent else ''

# Construir URL de shoutrrr desde variables de Telegram si existen
# Solo en central/standalone — los agentes no gestionan notificaciones
notification_urls = []

if not is_agent and tg_token and tg_chatid:
    notification_urls = [f"telegram://{tg_token}@telegram?chats={tg_chatid}"]
    print("✅ URL de Telegram migrada desde variables de entorno")

if is_agent:
    settings = {
        "centralUrl": central_url
    }
else:
    settings = {
        "centralUrl":  "",
        "primaryHost": primary_host,
        "release":     release,
        "notifications": {
            "enabled": bool(notification_urls),
            "urls":    notification_urls
        },
        "checkTime": check_time,
        "pruneMode": os.environ.get('PRUNE_MODE', 'conservative')
    }

with open('/app/data/config/settings.json', 'w') as f:
    json.dump(settings, f, indent=2)

print("✅ settings.json creado con valores del entorno")
PYEOF
fi

# TODO: eliminar en v2.3 — limpiar sources.json del volumen del usuario (migrado a imagen interna)
rm -f /app/data/config/sources.json 2>/dev/null || true

# TODO: eliminar en v2.4 — limpieza de carpetas antiguas de versiones previas a v2.2
# Una vez que todos los usuarios hayan migrado, esta limpieza ya no será necesaria
if [ -n "$WEBHOOK_URL" ] && [ -n "$ENDPOINT" ] && [ "$ENDPOINT" != "Actual" ]; then
    rm -rf /app/data/icons   2>/dev/null || true
    rm -rf /app/data/logs    2>/dev/null || true
    rm -rf /app/data/metadata 2>/dev/null || true
    echo "🧹 Carpetas antiguas eliminadas del volumen del agente"
fi



# ========================================
# Activar virtualenv para Python
# ========================================
source /opt/venv/bin/activate

# ========================================
# 1. Arrancar Dockge (backend)
# ========================================
echo "📦 Iniciando backend..."
tsx /app/backend/index.ts >> /tmp/dockge.log 2>&1 &

# ========================================
# 2. Arrancar API Node (updates + remove)
# ========================================
echo "🔧 Iniciando entorno..."
node /custom/api.js >> /tmp/api-node.log 2>&1 &

# ========================================
# 3. Scheduler de chequeo
# ========================================
# El scheduler está integrado en api.js (Node) y solo se activa
# en modo central/standalone. Los agentes remotos no programan checks.
if [ -n "$WEBHOOK_URL" ] && [ -n "$ENDPOINT" ] && [ "$ENDPOINT" != "Actual" ]; then
    echo "📡 Modo agente remoto — scheduler desactivado (el central gestiona los checks)"
fi

# Arrancar API Flask para métricas (bajo demanda, sin loop)
su -s /bin/bash apps -c "cd /tools && python3 api_metrics.py" >> /tmp/metrics.log 2>&1 &

# ========================================
# 4. Registro inicial en servidor central
# ========================================
if [ -n "$WEBHOOK_URL" ] && [ -n "$ENDPOINT" ] && [ "$ENDPOINT" != "Actual" ]; then
    echo "📡 Registrando agente en servidor central..."
    echo "   Hostname: $HOSTNAME"
    echo "   Endpoint: $ENDPOINT"
    WEBHOOK_BASE=$(echo "$WEBHOOK_URL" | sed 's#/api/.*##')
    
    # Enviar alive al central (asíncrono)
    (
        sleep 5
        curl -s -X POST "${WEBHOOK_BASE}/api/agent-alive" \
            -H "Content-Type: application/json" \
            -d "{\"hostname\":\"$HOSTNAME\",\"endpoint\":\"$ENDPOINT\"}" \
            -m 5 \
            || echo "⚠️ No se pudo registrar (el central podría estar offline)"
    ) &
    # Resetear updates.json local (agente no debe tener updates)
    UPDATES_FILE="/app/data/config/updates.json"
    printf '[{"hostname":"%s","endpoint":"Actual","updates":[]}]' "$HOSTNAME" > "$UPDATES_FILE"
fi

# ============================================
# 4b.Actualizar hostname local en updates.json
# ============================================
if [ "$ENDPOINT" = "Actual" ] || [ -z "$WEBHOOK_URL" ]; then
    UPDATES_FILE="/app/data/config/updates.json"
    
    # Verificar que existe el archivo
    if [ -f "$UPDATES_FILE" ]; then
        # Usar Python para actualizar el hostname del endpoint "Actual"
        python3 << EOF
import json

try:
    with open("$UPDATES_FILE", "r") as f:
        data = json.load(f)
    
    # Buscar y actualizar el endpoint "Actual"
    updated = False
    for host in data:
        if host.get("endpoint", "").lower() == "actual":
            host["hostname"] = "$HOSTNAME"
            updated = True
            break
    
    # Si no existe, crear entrada
    if not updated:
        data.append({
            "hostname": "$HOSTNAME",
            "endpoint": "Actual",
            "updates": []
        })
    
    # Guardar
    with open("$UPDATES_FILE", "w") as f:
        json.dump(data, f, indent=2)
    
except Exception as e:
    print(f"⚠️ Error actualizando hostname: {e}")
EOF
    else
        echo "⚠️ Archivo updates.json no encontrado, se creará en la primera ejecución"
    fi
fi

# ========================================
# 5. Arrancar Nginx (frontend + proxy) como apps
# ========================================
echo "===================="
echo "✅ Dockme está listo"
echo "===================="

# Nginx debe correr en foreground como usuario apps
exec su -s /bin/bash apps -c "nginx -g 'daemon off;'"