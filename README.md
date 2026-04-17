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
- 🔔 **Detección de actualizaciones** - Chequeo automático programable y manual con notificaciones multi-servicio (Telegram, Discord, ntfy, Pushover y más), prune de imágenes antiguas para recuperar espacio en disco, sincronizado entre dispositivos y actualización masiva de todas las pendientes en múltiples servidores con un solo click.
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
| `TZ` | Zona horaria | `Europe/Madrid` |
| `AGENT_URL` | IP:Puerto deL servidor remoto | *(solo remotos)* |
| `CENTRAL_URL` | IP:Puerto del servidor central | *(solo remotos)* |

> ⚠️ **Variables deprecadas** — siguen funcionando pero serán eliminadas en futuras versiones. Sustitúyelas por las equivalentes nuevas o elimínalas si ya no las usas:
>
> | Variable deprecada | Sustituir por | Notas |
> |--------------------|---------------|-------|
> | `ENDPOINT` | `AGENT_URL` | Solo remotos |
> | `WEBHOOK_URL` | `CENTRAL_URL` | Solo remotos |
> | `TELEGRAM_TOKEN` | — | Configurar desde ✏️ Editar → General |
> | `TELEGRAM_CHATID` | — | Configurar desde ✏️ Editar → General |
> | `CHECK_TIMES` | — | Configurar desde ✏️ Editar → General |

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
  AGENT_URL: "192.168.1.200:5041"   # IP:Puerto del servidor remoto (sin http://) Asegurarse que desde el central se puede acceder a ella
  CENTRAL_URL: "192.168.1.100:5041" # IP:Puerto del servidor central (sin http://) Asegurarse que desde el servidor remoto se puede acceder a ella
```

1. **Levanta el Dockme remoto** con las variables `AGENT_URL` y `CENTRAL_URL`
2. **Antes de continuar**, accede a la interfaz web del remoto directamente (p.ej. `http://192.168.1.200:5041`) y crea el usuario y contraseña si no lo habias hecho antes.
3. **En el central**, espera unos segundos o recarga la página
4. **Aparecerá una alerta** indicando que hay servidores detectados — haz click en ella para ir al panel de configuración
5. En la pestaña **Servidores**, introduce usuario y contraseña del login remoto y haz click en **"Conectar agente"**
6. Opcionalmente asigna un icono y la URL de su interfaz web
7. Una vez conectado y para mayor seguridad si quieres puedes cerrar sesion desde el menu superior, ya que todo sera gestionado desde el central.

¡Listo! El servidor remoto ya está sincronizado, ahora se podrán gestionar remotamente sus compose, desplegar nuevos stacks, ver sus métricas, recibir sus actualizaciones pendientes, y actualizarlas desde el central de forma masiva.

👉 Haciendo click en cada una de las tarjetas de métricas se pueden filtrar la lista de stacks para mostrar solo los de ese servidor, sus favoritos y sus actualizaciones pendientes, y volver a mostrar todos haciendo click de nuevo en la que está seleccionada.

---

## ✏️ Modo edición

Desde el botón **✏️** del header accedes al panel de configuración unificado con varias pestañas:

- **📦 Stacks** - Asigna iconos a tus stacks desde URL o archivo local, configura la URL de su servicio para lanzarlo con un click, y márcalos como favoritos para anclarlos en el dashboard
- **🔗 Links** - Crea y organiza categorías de links con iconos autodetectados o personalizados para acceder a servicios externos o cualquier url de internet
- **🖥️ Servidores** - Conecta y gestiona hosts remotos, asígnales un icono y la URL de su interfaz web
- **⚙️ General** - Configura las notificaciones (Telegram, Discord, ntfy y más), programa la hora del check diario de actualizaciones, y ajusta el modo de limpieza automática de imágenes Docker

💡 **Tip:** DockMe descarga automáticamente iconos para más de 2800 servicios conocidos al arrancar. Si el tuyo no está incluido o quieres personalizarlo, puedes asignarlo manualmente desde la pestaña Stacks. Encuentra iconos adicionales en [Self-Hosted Dashboard Icons](https://selfh.st/icons/)

## 📐 Modo organizar

Desde el botón **⠿** del header accedes al modo organizar donde puedes personalizar el dashboard:

- Arrastra los bloques (métricas, favoritos, categorías) para reordenarlos
- Redimensiona el ancho de cada bloque desde la esquina superior derecha y su altura se ajustara para mostrar todo su contenido
- Tambien puedes ajustar el ancho de la columna de stacks de la izquierda
- Guarda la disposición como un perfil con nombre para recuperarla cuando quieras
- Crea distintos perfiles para cada dispositivo o tamaño de pantalla — Dockme recuerda automáticamente cuál usar en cada uno

👉 Los perfiles se guardan en el servidor, por lo que están disponibles desde cualquier navegador.

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
- [**dashboard-icons**](https://github.com/homarr-labs/dashboard-icons) - Iconos descargados automáticamente desde dashboard-icons por Homarr Labs (Apache License 2.0)

---

## 📜 Licencia

MIT License - Copyright (c) 2026 Fernandeusto

Este proyecto incorpora código de Dockge y docge-update-check, ambos bajo licencia MIT.
Ver [LICENSE](LICENSE) para más detalles.
