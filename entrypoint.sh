#!/bin/bash
set -e

START_TIME=$(date '+%d-%m-%Y %H:%M')
echo "===================="
echo "🚀 Iniciando Dockme"
echo "🕒 $START_TIME"
echo "===================="

# Usar hostname del sistema si no se especifica
HOSTNAME="${HOSTNAME:-$(hostname)}"
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
    touch /app/data/.dockme-initialized
    echo "  ✅ Migración completada"
    echo ""
    echo "  ℹ️  IMPORTANTE: Puedes eliminar el volumen /metadata del docker-compose.yml"
    echo ""
fi

# ========================================
# Inicialización de metadata (primera vez)
# ========================================
INIT_FLAG="/app/data/.dockme-initialized"

if [ ! -f "$INIT_FLAG" ]; then
    echo "🆕 Instalación limpia, creando configuración por defecto..."
    mkdir -p /app/data/icons
    mkdir -p /app/data/config
    cp -r /app/defaults/icons/* /app/data/icons/ 2>/dev/null || true
    cp /app/defaults/json/sources.json /app/data/config/sources.json 2>/dev/null || true
    # Crear updates.json inicial (host local)
    HOSTNAME_VALUE="${HOSTNAME:-Dockme}"
    printf '[{"hostname":"%s","endpoint":"Actual","updates":[]}]' "$HOSTNAME_VALUE" \
        > /app/data/config/updates.json

    touch "$INIT_FLAG"
    echo "✅ Configuración inicializada"
fi

# Verificar que tenemos permisos de lectura en metadata
if [ ! -r "/app/data/config/sources.json" ]; then
    echo "⚠️  ADVERTENCIA: No se puede leer /app/data/config/sources.json"
    echo "   Asegúrate de que el volumen /app/data tiene permisos."
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
echo "🔧 Iniciando API..."
node /custom/api.js >> /tmp/api-node.log 2>&1 &

# ========================================
# 3. Arrancar dockme-agent como apps
# ========================================
# Configurar horarios de chequeo
CHECK_TIMES="${CHECK_TIMES:-09:00}"
echo "🤖  Programando actualizaciones: $CHECK_TIMES"

# Crear script del scheduler
cat > /tmp/scheduler.sh << 'SCHEDULER_SCRIPT'
#!/bin/bash
CHECK_TIMES="$1"
while true; do
  HORA_ACTUAL=$(date +%H:%M)
  IFS=',' read -ra TIMES <<< "$CHECK_TIMES"
  for CHECK_TIME in "${TIMES[@]}"; do
    CHECK_TIME=$(echo "$CHECK_TIME" | xargs)
    if [ "$HORA_ACTUAL" = "$CHECK_TIME" ]; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⏰ Ejecutando chequeo de updates..."
      /tools/check-updates.sh 2>&1 | tee -a /tmp/updates-check.log
      sleep 61
      break
    fi
  done
  sleep 60
done
SCHEDULER_SCRIPT

chmod +x /tmp/scheduler.sh

# Arrancar scheduler como usuario apps
su -s /bin/bash apps -c "/tmp/scheduler.sh '$CHECK_TIMES'" &

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
    echo "🏠 Actualizando hostname local en updates.json..."
    
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
    
    print("✅ Hostname local actualizado: $HOSTNAME")
    
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