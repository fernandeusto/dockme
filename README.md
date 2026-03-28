# Dockme

<p align="left">
  <img src="https://raw.githubusercontent.com/fernandeusto/dockme/main/custom/icons/dockme.svg" width="120">
</p>

**Dockme** es una solución completa para administrar tus docker-compose desde una interfaz web moderna, con iconos y sistema de actualizaciones integrado. Además, desde la v2, Dockme puede funcionar también como homepage personal: lanza tanto las webs de tus servicios como otros links externos, organizados en categorías reorganizables y redimensionables con distintos layouts para cada uno de tus dispositivos.

---

## 🌟 Características destacadas

- 🎨 **Gestión de Compose mejorada** - Editor, logs y terminal a pantalla completa; terminal con portapapeles
- 🏠 **Homepage personal** - Organiza links y servicios docker en categorías con sus iconos, y márcalos como favoritos para tenerlos anclados en el dashboard. Tanto desde las tarjetas favoritas como desde la lista de stacks puedes abrir el compose o lanzar el servicio si el click es en el icono.
- 📐 **Layouts por dispositivo** - Arrastra y redimensiona los bloques a tu gusto y guarda distintas disposiciones del dashboard para cada uno de tus dispositivos o tamaños de pantalla.
- 🔔 **Detección de actualizaciones** - Chequeo automático programable y manual con notificaciones por Telegram, prune de imágenes antiguas para recuperar espacio en disco, sincronizado entre dispositivos y actualización masiva de todos los pendientes en múltiples servidores con un solo click.
- 🌐 **Multi-servidor** - Gestiona múltiples hosts desde un panel centralizado con métricas en tiempo real, editando o desplegando nuevos compose en remoto. Ademas puedes asignar un icono a cada servidor para identificarlos y lanzar su interfaz web.
- 🔄 **Auto-actualización** - Dockme puede actualizarse a sí mismo desde la tarjeta de métricas, incluso en los host remotos sin perder el control de sus docker.

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

#### **🐧 NOTA: Instalación en Synology**

Los NAS Synology utilizan versiones de Docker Engine desactualizadas, lo que puede causar incompatibilidades con el cliente Docker incluido en DockMe. Los síntomas más comunes son:

- Los stacks existentes no se muestran
- Al crear un nuevo stack aparece `Process exited with code 1`
- Las métricas muestran 0 contenedores

**Solución:** añadir las siguientes variables al compose de DockMe:
```yaml
environment:
  - DOCKER_API_VERSION=1.43
  - DOCKER_GID=0
```

El valor `1.43` corresponde a DSM 7.3.2 con Docker 24.x. Para obtener el valor exacto de tu instalación, ejecuta en el terminal de DSM:
```bash
docker version --format '{{.Server.APIVersion}}'
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
2. **En el central**, espera unos segundos o recarga la página 
3. **Aparecerá una alerta** indicando que hay servidores detectados — haz click en ella para ir al panel de configuración
4. En la pestaña **Servidores**, introduce usuario y contraseña del login remoto y haz click en **"Conectar agente"**
5. Opcionalmente asigna un icono y la URL de su interfaz web

¡Listo! El servidor remoto ya está sincronizado, ahora se podrán gestionar remotamente sus compose, desplegar nuevos stack, ver sus métricas, recibir sus actualizaciones pendientes, y actualizarlas desde el central de forma masiva.

👉 Haciendo click en cada una de las tarjetas de métricas se pueden filtrar la lista de stack para mostrar solo los stack de ese servidor, sus favoritos y sus actualizaciones pendientes, y volver a mostrar todos haciendo click de nuevo en la que esta seleccionada.

---

## ✏️ Modo edición

Desde el botón **✏️** del header accedes al panel de configuración unificado con varias pestañas:

- **Stacks** - Asigna iconos SVG a tus stacks desde URL o archivo local, y configura la URL de su servicio para lanzarlo con un click, y marcalos como favoritos para anclarlos en el dashboard
- **Links** - Crea y organiza categorías de links con iconos autodetectados o personalizados
- **Servidores** - Conecta y gestiona hosts remotos, asignales un icono y la url de su interfaz web

💡 **Tip:** Encuentra iconos en [Self-Hosted Dashboard Icons](https://selfh.st/icons/)

## 📐 Modo organizar

Desde el botón **⠿** del header accedes al modo organizar donde puedes personalizar el dashboard:

- Arrastra los bloques (métricas, favoritos, categorías) para reordenarlos
- Redimensiona el ancho de cada bloque desde la esquina superior derecha y su altura se ajustara para mostrar todo su contenido
- Tambien puedes ajustar el ancho de la columna de stacks de la izquierda
- Guarda la disposición como un perfil con nombre para recuperarla cuando quieras
- Crea distintos perfiles para cada dispositivo o tamaño de pantalla — Dockme recuerda automáticamente cuál usar en cada uno

👉 Los perfiles se guardan en el servidor, por lo que están disponibles desde cualquier navegador.

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
