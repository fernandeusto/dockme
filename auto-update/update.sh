#!/bin/sh

LOG_FILE="/opt/stacks/dockme/auto-update.log"

log() {
  echo "$1" | tee -a "$LOG_FILE"
}

log_file() {
  echo "$1" >> "$LOG_FILE"
}

log "🔄 Dockme auto-update iniciado: $(date)"

STACK_DIR="/opt/stacks/dockme"

if [ ! -d "$STACK_DIR" ]; then
    log "❌ No se encontró el stack de Dockme en $STACK_DIR"
    exit 1
fi

cd "$STACK_DIR" || {
    log "❌ No se pudo acceder a $STACK_DIR"
    exit 1
}

# Detectar imagen actual de Dockme
IMAGE=$(docker inspect dockme --format='{{.Config.Image}}' 2>/dev/null || true)

if [ -z "$IMAGE" ]; then
    log "❌ No se pudo detectar la imagen actual de Dockme"
    exit 1
fi

log "📦 Imagen actual de Dockme: $IMAGE"

# Si es imagen de registry, hacer pull
if echo "$IMAGE" | grep -qE '^ghcr.io/'; then
    log "📥 Descargando imagen nueva..."
    docker compose pull >> "$LOG_FILE" 2>&1
else
    log "⚠️ Imagen local detectada, omitiendo pull..."
fi

log "🚀 Imagen descargada, reiniciando Dockme en 3 segundos..."
sleep 3

docker compose up -d --force-recreate --no-deps dockme >> "$LOG_FILE" 2>&1

log "🏁 Auto-update finalizado: $(date)"