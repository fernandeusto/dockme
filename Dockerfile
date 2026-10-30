############################################
# Stage 1: Build Healthcheck (Go)
############################################
FROM golang:1-bookworm AS build_healthcheck
WORKDIR /app
COPY dockge/extra/healthcheck.go ./extra/healthcheck.go
RUN go build -x -o ./extra/healthcheck ./extra/healthcheck.go

############################################
# Stage 2: Instalar dependencias Node para Dockge backend
############################################
FROM node:22-bookworm-slim AS build_dockge
WORKDIR /app

# Build SQLite against the same Debian/GLIBC used by the runtime. Upstream
# prebuilt binaries may require a newer GLIBC than Bookworm provides.
# These compilers stay in the build stage and are not copied to the runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 568 apps 2>/dev/null || true \
    && useradd -u 568 -g 568 -m -s /bin/bash apps 2>/dev/null || true

COPY dockge/package.json ./package.json
COPY dockge/package-lock.json ./package-lock.json

RUN chown -R apps:apps /app
USER apps
# prebuild-install accepts a package name here, so only SQLite is forced to
# compile; the other native dependencies can keep their compatible prebuilds.
RUN npm_config_build_from_source=sqlite3 npm ci --omit=dev



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

# Fail the image build if the native module cannot load in the real runtime.
RUN node -e "const sqlite = require('/app/node_modules/sqlite3'); const db = new sqlite.Database(':memory:', error => { if (error) throw error; db.get('SELECT 1 AS ok', (error, row) => { if (error) throw error; if (row.ok !== 1) throw new Error('SQLite runtime check failed'); db.close(); }); });"

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
COPY tools/prune.sh /tools/prune.sh
COPY tools/MetricsService.js /tools/MetricsService.js

# ========================================
# Descargar binario shoutrrr (notificaciones multi-servicio)
# ========================================
RUN set -e; \
    ARCH=$(dpkg --print-architecture); \
    case "$ARCH" in \
        amd64)  SHOUTRRR_ARCH="linux_amd64" ;; \
        arm64)  SHOUTRRR_ARCH="linux_arm64" ;; \
        armhf)  SHOUTRRR_ARCH="linux_arm" ;; \
        i386)   SHOUTRRR_ARCH="linux_386" ;; \
        *)      echo "Arquitectura no soportada: $ARCH" && exit 1 ;; \
    esac; \
    SHOUTRRR_URL=$(curl -sf https://api.github.com/repos/nicholas-fedor/shoutrrr/releases/latest \
        | grep -o "https://[^\"]*${SHOUTRRR_ARCH}[^\"]*\.tar\.gz" | head -1); \
    echo "Descargando shoutrrr: $SHOUTRRR_URL"; \
    mkdir -p /tmp/shoutrrr-install; \
    curl -sfL "$SHOUTRRR_URL" | tar -xz -C /tmp/shoutrrr-install; \
    install -m 755 $(find /tmp/shoutrrr-install -maxdepth 2 -type f ! -name '*.md' | head -1) /usr/local/bin/shoutrrr; \
    rm -rf /tmp/shoutrrr-install; \
    shoutrrr --version

RUN chmod +x \
    /tools/check-updates.sh \
    /tools/prune.sh

# ========================================
# Copiar custom (Nginx + API Node + custom.js)
# ========================================
COPY custom/ /custom/
COPY custom/shoutrrr-services.json /custom/shoutrrr-services.json

# Instalar dependencias de la API Node (como apps para evitar chown posterior)
WORKDIR /custom
RUN chown -R apps:apps /custom     && chmod +x /custom/api.js     && su -s /bin/sh apps -c "npm ci --omit=dev"

# frontend-dist para Dockge backend — usar nuestro index.html de /custom/
RUN mkdir -p /app/frontend-dist && cp /custom/index.html /app/frontend-dist/index.html

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
    /etc/nginx \
    && chmod -R 755 /tools /etc/nginx \
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
