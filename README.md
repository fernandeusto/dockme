# Dockme

<p align="left">
  <img src="https://raw.githubusercontent.com/fernandeusto/dockme/main/custom/icons/dockme.svg" width="120">
</p>

**Dockme** es una solución completa para administrar tus docker-compose desde una interfaz web moderna.
Basado en el conocido Dockge, añade nuevas funcionalidades y mejora su diseño.

---

## 🌟 Características destacadas

- 🎨 **Interfaz web intuitiva** - Gestiona tus Compose con editor en pantalla completa y Terminal con portapapeles
- 🎯 **Iconos personalizados por stack** - Sube tus propios iconos SVG desde URL o local
- ⚡ **Ordenación inteligente** - Stacks activos primero, inactivos al final y filtrado por servidor
- 🎯 **Acceso rápido** - Tarjetas con últimos stacks visitados y con actualizaciones pendientes
- 🔔 **Detección de actualizaciones** - Chequeo automático programable de actualizaciones
- 📱 **Notificaciones** - Alertas por Telegram cuando hay actualizaciones disponibles
- 🌐 **Multi-servidor** - Gestiona múltiples hosts desde un panel centralizado
- 📊 **Métricas en tiempo real** - CPU, RAM, temperatura y más de cada servidor
- 🔄 **Auto-actualización** - Sistema integrado para actualizarse Dockme a si mismo

---

<p align="left">
  <img src="https://raw.githubusercontent.com/fernandeusto/dockme/main/screenshot/main-screen.png" style="width:100%;max-width:800px">
</p>


## 🚀 Instalación rápida

### Docker Compose
```yaml
services:
  dockme:
    container_name: dockme
    image: ghcr.io/fernandeusto/dockme:latest
    restart: always
    
    environment:
      - HOSTNAME=NombreDeServidor    # ⚠️ Obligatorio
    
    ports:
      - "5041:8080"
    
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # Acceso al Docker daemon
      - ./dockme:/app/data                         # Datos persistentes
      - ./stacks:/opt/stacks                       # Docker Compose stacks
```

---

### ⚙️ Variables de entorno

| Variable | Descripción | Por defecto |
|----------|-------------|-------------|
| `HOSTNAME` | Nombre del servidor ⚠️ **Obligatorio** | |
| `CHECK_TIMES` | Horarios de chequeo (HH:MM, separados por comas) | `09:00` |
| `TZ` | Zona horaria | `Europe/Madrid` |
| `TELEGRAM_TOKEN` | Token del bot de Telegram | |
| `TELEGRAM_CHATID` | ID del chat de Telegram | |
| `ENDPOINT` | IP:Puerto del servidor remoto | *(solo remotos)* |
| `WEBHOOK_URL` | URL del servidor central | *(solo remotos)* |

### 📂 Sobre el volumen `/opt/stacks`

Este volumen debe apuntar a la carpeta donde guardas tus stacks de Docker Compose, organizados en subcarpetas:
```
./stacks/
├── immich/
│   └── compose.yaml
├── jellyfin/
│   └── compose.yaml
└── nextcloud/
    └── compose.yaml
```

**¿Tienes stacks ya creados?** Muévelos a esta estructura, detén los contenedores, y usa el botón **"Escanear carpeta de pilas"** en Dockme (menú superior derecho) para detectarlos automáticamente.

---

## 🌐 Configuración Multi-servidor

Dockme puede funcionar **en solitario** o como **servidor central** recibiendo información de instancias remotas.

Para conectar un servidor remoto al central, añade estas **2 variables** al compose del servidor remoto:
```yaml
environment:
  ENDPOINT: "192.168.1.200:5041"             # IP:Puerto de ESTE servidor
  WEBHOOK_URL: "http://192.168.1.100:5041"   # URL del servidor central
```

1. **Levanta el Dockme remoto** con las variables `ENDPOINT` y `WEBHOOK_URL`
2. **En el central**, recarga la página (F5) o espera unos segundos
3. **Aparecerá una alerta** indicando que hay servidores detectados
4. **Click en "Gestionar"** junto a "🖥️ Servidores conectados"
5. **Introduce usuario y contraseña** del Dockme remoto en la tabla de servidores detectados
6. **Click en "Conectar agente"**

¡Listo! El servidor remoto ya está sincronizado, ahora se podrán gestionar remotamente sus compose, desplegar nuevos stack, ver sus métricas, recibir sus actualizaciones disponibles, y actualizarlas desde el central.

👉 Haciendo click en cada una de las tarjetas de metricas se pueden filtrar la lista de stack para mostrar solo los stack de ese servidor, y volver a mostrar todos haciendo click de nuevo en la que esta seleccionada.

---

## 🎨 Personalización de iconos

Puedes personalizar los iconos de tus stacks directamente desde la interfaz web:

1. Click en el botón **✏️** junto al buscador (modo edición)
2. Selecciona el stack que quieres personalizar de la lista de la izquierda
3. Asigna un SVG desde su URL o desde un archivo local

💡 **Tip:** Encuentra iconos SVG en [Simple Icons](https://simpleicons.org/)

---

## 🛠️ Comandos CLI

Desde el terminal del contenedor:

| Comando | Descripción |
|---------|-------------|
| `dockme checkupdates` | Chequear actualizaciones manualmente |
| `dockme prune` | Limpiar imágenes Docker huérfanas |
| `dockme test-telegram` | Enviar mensaje de prueba a Telegram |

---

## Motivación

Durante años he usado Portainer para gestionar mis contenedores Docker, pero siempre he echado en falta algo más específico para stacks de Docker Compose: un editor integrado más ágil y simple, detección automática de actualizaciones, y una interfaz más directa sin capas de abstracción innecesarias.

Dockge resolvió gran parte de esas necesidades con una interfaz limpia y enfocada exclusivamente en Compose.

Dockme toma esa base y añade las funcionalidades que necesitaba para tener una interfaz aún más visual gracias a la personalización con los iconos, y a su vez pudiendo gestionar múltiples servidores desde un solo punto.

---

## 🙏 Agradecimientos

Este proyecto está construido sobre el trabajo de:

- [**Dockge**](https://github.com/louislam/dockge) por **Louis Lam** - Interfaz web para gestión de Docker Compose
- [**docge-update-check**](https://github.com/PhilGoud/docge-update-check) por **Phil_Goud** - Script de detección de actualizaciones

---

## 📜 Licencia

MIT License - Copyright (c) 2025 Fernandeusto

Este proyecto incorpora código de Dockge y docge-update-check, ambos bajo licencia MIT.
Ver [LICENSE](LICENSE) para más detalles.
