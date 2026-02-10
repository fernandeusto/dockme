############################################
# Stage 1: Build Healthcheck (Go)
############################################
FROM golang:1.21.4-bookworm AS build_healthcheck
WORKDIR /app
COPY dockge/extra/healthcheck.go ./extra/healthcheck.go
RUN go build -x -o ./extra/healthcheck ./extra/healthcheck.go

############################################
# Stage 2: Build Dockge Frontend
############################################
FROM node:22-bookworm-slim AS build_dockge
WORKDIR /app

# Crear usuario apps en el build stage
RUN groupadd -g 568 apps 2>/dev/null || true \
    && useradd -u 568 -g 568 -m -s /bin/bash apps 2>/dev/null || true

# Copiar package files de Dockge
COPY dockge/package.json ./package.json
COPY dockge/package-lock.json ./package-lock.json

# Instalar dependencias YA como usuario apps
RUN chown -R apps:apps /app
USER apps
RUN npm ci

# Copiar frontend de Dockge
COPY --chown=apps:apps dockge/frontend ./frontend
COPY --chown=apps:apps dockge/common ./common

# Build frontend
RUN npm run build:frontend

############################################
# Stage 3: Runtime Unificado
############################################
FROM node:22-bookworm-slim AS release

# ========================================
# Crear usuario apps PRIMERO
# ========================================
# Crear grupo docker con GID común (999)
# Crear usuario apps (UID 568) y añadirlo al grupo docker
RUN groupadd -g 999 docker 2>/dev/null || true \
    && groupadd -g 568 apps 2>/dev/null || true \
    && useradd -u 568 -g 568 -G docker -m -s /bin/bash apps 2>/dev/null || true

# ========================================
# Dependencias del sistema
# ========================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Para Dockge
    curl \
    ca-certificates \
    gnupg \
    dumb-init \
    tzdata \
    # Para Python (tools)
    python3 \
    python3-venv \
    python3-pip \
    # Nginx
    nginx \
    # Herramientas adicionales
    unzip \
    && rm -rf /var/lib/apt/lists/*

# ========================================
# Instalar Docker CLI
# ========================================
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo \
         "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
         $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
         > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
         docker-ce-cli \
         docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# ========================================
# Instalar tsx globalmente (para Dockge)
# ========================================
RUN npm install -g tsx

# ========================================
# Python venv para tools
# ========================================
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip flask
ENV PATH="/opt/venv/bin:$PATH"

# ========================================
# Crear estructura de directorios
# ========================================
RUN mkdir -p \
    /app \
    /app/data \
    /tools \
    /custom

# ========================================
# Copiar Dockge (estructura completa)
# ========================================
# Healthcheck compilado
COPY --from=build_healthcheck /app/extra/healthcheck /app/extra/healthcheck

# Node modules ya vienen con owner apps:apps del build stage
COPY --from=build_dockge --chown=apps:apps /app/node_modules /app/node_modules

# Frontend compilado
COPY --from=build_dockge --chown=apps:apps /app/frontend-dist /app/frontend-dist

# Backend y archivos necesarios de Dockge
COPY --chown=apps:apps dockge/backend /app/backend/
COPY --chown=apps:apps dockge/common /app/common/
COPY --chown=apps:apps dockge/package.json /app/package.json
COPY --chown=apps:apps dockge/package-lock.json /app/package-lock.json
COPY --chown=apps:apps dockge/tsconfig.json /app/tsconfig.json

# ========================================
# Copiar dockme-Version
# ========================================
COPY version.json /tools/version.json

# ========================================
# Copiar tools
# ========================================
COPY tools/check-updates.sh /tools/check-updates.sh
COPY tools/metrics.sh /tools/metrics.sh
COPY tools/api_metrics.py /tools/api_metrics.py
COPY tools/dockme /usr/local/bin/dockme

RUN chmod +x \
    /tools/check-updates.sh \
    /tools/metrics.sh \
    /tools/api_metrics.py \
    /usr/local/bin/dockme

# ========================================
# Copiar custom (Nginx + API Node + custom.js)
# ========================================
COPY custom/ /custom/
RUN chmod +x /custom/api.js

# Instalar dependencias de la API Node
WORKDIR /custom
RUN npm install --omit=dev

# Configurar Nginx - remover config por defecto y copiar la nuestra
RUN rm -f /etc/nginx/sites-enabled/default \
    && rm -f /etc/nginx/conf.d/default.conf \
    && rm -f /etc/nginx/nginx.conf

COPY custom/nginx-main.conf /etc/nginx/nginx.conf
COPY custom/nginx.conf /etc/nginx/conf.d/default.conf

# Crear directorios temporales para Nginx (ownership correcto desde el inicio)
RUN mkdir -p \
    /tmp/client_temp \
    /tmp/proxy_temp \
    /tmp/fastcgi_temp \
    /tmp/uwsgi_temp \
    /tmp/scgi_temp \
    /run \
    /var/log/nginx \
    /var/lib/nginx \
    && chown -R apps:apps \
    /tmp/client_temp \
    /tmp/proxy_temp \
    /tmp/fastcgi_temp \
    /tmp/uwsgi_temp \
    /tmp/scgi_temp \
    /run \
    /var/log/nginx \
    /var/lib/nginx \
    && chmod -R 755 /var/log/nginx

# ========================================
# Copiar metadata por defecto
# ========================================
COPY defaults/ /app/defaults/

# ========================================
# Copiar entrypoint
# ========================================
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# ========================================
# Crear usuario compatible TrueNAS/Proxmox
# ========================================
# Usuario 'apps' con UID/GID 568 (TrueNAS)
RUN groupadd -g 568 apps 2>/dev/null || true \
    && useradd -u 568 -g 568 -m -s /bin/bash apps 2>/dev/null || true

# ========================================
# Permisos finales (solo lo que falta)
# ========================================
RUN mkdir -p /app/data \
    && chown apps:apps \
    /app/data \
    /app/extra/healthcheck \
    /entrypoint.sh \
    && chown -R apps:apps \
    /tools \
    /custom \
    /etc/nginx \
    && chmod -R 755 /tools /custom /etc/nginx \
    && chmod +x /entrypoint.sh /app/extra/healthcheck \
    && chmod 644 /etc/nginx/nginx.conf /etc/nginx/conf.d/default.conf

# ========================================
# Variables de entorno
# ========================================
ENV UV_USE_IO_URING=0
ENV DOCKGE_STACKS_DIR=/opt/stacks
ENV TZ=Europe/Madrid

# ========================================
# Volúmenes y puertos
# ========================================
VOLUME /app/data
VOLUME /opt/stacks

EXPOSE 8080

# ========================================
# Healthcheck
# ========================================
HEALTHCHECK --interval=60s --timeout=30s --start-period=60s --retries=5 \
  CMD /app/extra/healthcheck

# ========================================
# Entrypoint
# ========================================
WORKDIR /app

# El entrypoint debe correr como root para poder hacer usermod
# Luego el script cambiará internamente al usuario apps
USER root

ENTRYPOINT ["/entrypoint.sh"]