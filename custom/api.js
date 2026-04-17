import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 5002;

app.use(express.json({ limit: '2mb' }));

const updatesPath  = "/app/data/config/updates.json";
const stacksPath   = "/app/data/config/stacks.json";
const linksPath    = "/app/data/config/links.json";
const layoutsPath  = "/app/data/config/layouts.json";
const settingsPath = "/app/data/config/settings.json";

// ============================
// Funciones auxiliares
// ============================
function readUpdatesFile() {
  if (!fs.existsSync(updatesPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(updatesPath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeUpdatesFile(data) {
  fs.writeFileSync(updatesPath, JSON.stringify(data, null, 2));
}

const defaultSettings = {
  centralUrl:          '',
  migration_2_1_shown: false,
  primaryHost:         '',
  release:             '',
  notifications: {
    enabled: false,
    urls:    []
  },
  checkTime: '09:00',
  pruneMode: 'conservative'
};

function readSettingsFile() {
  if (!fs.existsSync(settingsPath)) return { ...defaultSettings };
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return { ...defaultSettings };
  }
}

function writeSettingsFile(data) {
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
}

// ============================
// POST /api/set-updates
// ============================
app.post('/api/set-updates', (req, res) => {
  try {
    const { hostname, endpoint, updates } = req.body;

    if (!hostname || !endpoint || !Array.isArray(updates)) {
      return res.status(400).json({ error: "Faltan parámetros o formato incorrecto" });
    }

    const currentData = readUpdatesFile();
    const existingIndex = currentData.findIndex(h => 
      h.endpoint?.toLowerCase() === endpoint.toLowerCase()
    );

    if (existingIndex >= 0) {
      // Preservar todos los campos existentes (uiUrl, etc.)
      // Sobreescribir solo hostname, endpoint y updates.
      // Eliminar primaryHost y release si llegaran por error — viven en settings.json.
      const preserved = { ...currentData[existingIndex] };
      delete preserved.primaryHost;
      delete preserved.release;
      currentData[existingIndex] = {
        ...preserved,
        hostname,
        endpoint,
        updates: updates.map(u => ({
          stack: u.stack,
          dockers: u.dockers
        }))
      };
    } else {
      currentData.push({
        hostname,
        endpoint,
        updates: updates.map(u => ({
          stack: u.stack,
          dockers: u.dockers
        }))
      });
    }

    writeUpdatesFile(currentData);

    // Si hay un ciclo activo, marcar este endpoint como respondido
    if (activeCycle && activeCycle.pending.has(endpoint.toLowerCase())) {
      activeCycle.pending.delete(endpoint.toLowerCase());
      const updateCount = updates.length;
      const stackNames  = updates.map(u => u.stack).join(', ') || 'ninguna';
      console.log(`📥 [Cycle] ${hostname} (${endpoint}) respondió — ${updateCount} update(s): [${stackNames}] — pendientes: ${activeCycle.pending.size}`);
      if (activeCycle.pending.size === 0) {
        activeCycle.resolve([]);
      }
    }

    res.json({ success: true, data: currentData });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// POST /api/set-server
// ============================
app.post('/api/set-server', async (req, res) => {
  try {
    const { endpoint, uiUrl, svg } = req.body;
    if (!endpoint) {
      return res.status(400).json({ error: "Falta parámetro 'endpoint'" });
    }
    const data = readUpdatesFile();
    const idx = data.findIndex(h =>
      h.endpoint?.toLowerCase() === endpoint.toLowerCase()
    );
    if (idx < 0) {
      return res.status(404).json({ error: "Servidor no encontrado" });
    }
    if (uiUrl !== undefined) data[idx].uiUrl = uiUrl;
    if (svg !== undefined) {
      if (!/<svg[\s>]/i.test(svg)) {
        return res.status(400).json({ error: 'El contenido no es un SVG válido' });
      }
      const hostname = data[idx].hostname;
      const iconsDir = '/app/data/icons';
      const iconPath = path.join(iconsDir, `server-${hostname}.svg`);
      fs.mkdirSync(iconsDir, { recursive: true });
      fs.writeFileSync(iconPath, svg, 'utf8');
    }
    writeUpdatesFile(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// GET /api/fetch-all-metrics
// ============================
app.get('/api/fetch-all-metrics', async (req, res) => {
  try {
    const currentData = readUpdatesFile();
    
    // Extraer lista única de hosts
    const hosts = currentData.map(h => ({
      hostname: h.hostname,
      endpoint: h.endpoint
    }));

    // Fetch paralelo de métricas
    const promises = hosts.map(async (host) => {
      try {
        const targetEndpoint = host.endpoint.toLowerCase() === 'actual' 
          ? '127.0.0.1:5000'
          : host.endpoint;
        
        const url = `http://${targetEndpoint}/metrics`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const metrics = await response.json();

        return {
          hostname: host.hostname,
          endpoint: host.endpoint,
          metrics,
          status: 'ok'
        };
      } catch (err) {
        return {
          hostname: host.hostname,
          endpoint: host.endpoint,
          status: 'error',
          error: err.message
        };
      }
    });

    const results = await Promise.all(promises);
    res.json({ hosts: results });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// POST /api/remove-update
// ============================
// Elimina un stack de un host concreto (case-insensitive)
app.post('/api/remove-update', (req, res) => {
  try {
    const { hostname, stack } = req.body;
    if (!hostname || !stack) {
      return res.status(400).json({ error: "Faltan parámetros 'hostname' o 'stack'" });
    }
    const data = readUpdatesFile();
    const hostEntry = data.find(h => 
      h.hostname.toLowerCase() === hostname.toLowerCase()
    );
    if (!hostEntry) {
      return res.status(404).json({ 
        success: false, 
        message: `No se encontrÃ³ el host '${hostname}'` 
      });
    }
    if (!Array.isArray(hostEntry.updates)) {
      return res.status(500).json({ 
        error: "El campo 'updates' del host no es un array" 
      });
    }
    const originalLength = hostEntry.updates.length;
    hostEntry.updates = hostEntry.updates.filter(u => 
      u.stack.toLowerCase() !== stack.toLowerCase()
    );
    writeUpdatesFile(data);
    if (hostEntry.updates.length < originalLength) {
      return res.json({ 
        success: true, 
        removed: stack, 
        hostname, 
        updates: hostEntry.updates 
      });
    } else {
      return res.json({ 
        success: false, 
        message: `No se encontró el stack '${stack}' en '${hostname}'` 
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// POST /api/stack-icon
// ============================
app.post('/api/stack-icon', async (req, res) => {
  try {
    const { stack, name, endpoint, filename, type } = req.body;
    // Soporte legacy (stack sin name/endpoint) y nuevo formato
    const stackName  = name  || stack;
    const stackEndpoint = endpoint || 'Actual';
    if (!stackName || !type) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }
    if (!['url', 'upload'].includes(type)) {
      return res.status(400).json({ error: 'Tipo inválido' });
    }

    const iconsDir = '/app/data/icons';
    fs.mkdirSync(iconsDir, { recursive: true });

    let svgText;
    let iconFile;

    // ICONO DESDE URL
    if (type === 'url') {
      const { url } = req.body;
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL no válida' });
      }
      const response = await fetch(url);
      if (!response.ok) {
        return res.status(400).json({
          error: `No se pudo descargar la URL (${response.status})`
        });
      }
      const contentType = response.headers.get('content-type') || '';
      svgText = await response.text();
      if (
        !contentType.includes('image/svg+xml') &&
        !svgText.trim().startsWith('<svg')
      ) {
        return res.status(400).json({ error: 'La URL no contiene un SVG válido' });
      }
      // Nombre del fichero: filename enviado, o último segmento de la URL, o {stack}.svg
      iconFile = filename
        || path.basename(new URL(url).pathname)
        || `${stackName}.svg`;
      if (!iconFile.toLowerCase().endsWith('.svg')) iconFile += '.svg';
    }

    // ICONO DESDE SVG LOCAL (TEXTO)
    if (type === 'upload') {
      const { svg } = req.body;
      if (!svg || typeof svg !== 'string') {
        return res.status(400).json({ error: 'SVG no válido' });
      }
      if (!/<svg[\s>]/i.test(svg)) {
        return res.status(400).json({ error: 'El contenido no es un SVG válido' });
      }
      svgText = svg;
      iconFile = filename || `${stackName}.svg`;
      if (!iconFile.toLowerCase().endsWith('.svg')) iconFile += '.svg';
    }

    // Sanear nombre de fichero (solo nombre, sin rutas)
    iconFile = path.basename(iconFile);

    // Borrar icono anterior si nadie más lo usa
    const stacks = readStacksFile();
    const entryIdx = stacks.findIndex(s =>
      s.name.toLowerCase() === stackName.toLowerCase() &&
      s.endpoint.toLowerCase() === stackEndpoint.toLowerCase()
    );
    if (entryIdx >= 0) {
      const oldIcon = stacks[entryIdx].icon;
      if (oldIcon && oldIcon !== iconFile) {
        const usedByOther = stacks.some((s, i) => i !== entryIdx && s.icon === oldIcon);
        if (!usedByOther) {
          const oldPath = path.join(iconsDir, oldIcon);
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
      }
    }

    // Guardar fichero SVG con nombre original
    fs.writeFileSync(path.join(iconsDir, iconFile), svgText, 'utf8');

    // Actualizar campo icon en stacks.json (no crear entradas para iconos de links)
    if (entryIdx >= 0) {
      stacks[entryIdx].icon = iconFile;
      writeStacksFile(stacks);
    } else if (!stackName.startsWith('link-') && !stackName.startsWith('server-')) {
      stacks.push({ name: stackName, endpoint: stackEndpoint, icon: iconFile, url: '', repo: '', favorite: false, order: null });
      writeStacksFile(stacks);
    }

    return res.json({ success: true, iconFile, message: 'Icono actualizado' });

  } catch (err) {
    console.error('Error en /api/stack-icon:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================
// Auto-update Dockme
// ============================
let dockmeUpdateInProgress = false;
let dockmeUpdateStartedAt = 0;
// 5 minutos de timeout de seguridad
const DOCKME_UPDATE_TIMEOUT = 5 * 60 * 1000;
app.post('/api/update-self', (req, res) => {
    const now = Date.now();
    // Si hay update en curso, comprobar timeout
    if (dockmeUpdateInProgress) {
        const elapsed = now - dockmeUpdateStartedAt;
        if (elapsed < DOCKME_UPDATE_TIMEOUT) {
            console.warn('⚠️ Auto-update de Dockme ya en curso');
            return res.status(409).json({
                success: false,
                message: 'Ya hay una actualización de Dockme en curso'
            });
        }
        // Timeout superado → liberar lock
        console.error('⏱️ Auto-update de Dockme superó el tiempo máximo, liberando bloqueo');
        dockmeUpdateInProgress = false;
    }
    console.log('🔄 Solicitud de auto-update de Dockme recibida');

    dockmeUpdateInProgress = true;
    dockmeUpdateStartedAt = now;

    const cmd = `
        docker rm -f dockme-auto-update 2>/dev/null || true
        docker run --rm --pull=always \
          --name dockme-auto-update \
          --volumes-from dockme \
          -v /var/run/docker.sock:/var/run/docker.sock \
          ghcr.io/fernandeusto/dockme-auto-update:latest
    `;

    exec(cmd, { detached: true }, (error) => {
        dockmeUpdateInProgress = false;

        if (error) {
            console.error('❌ Error lanzando dockme-auto-update:', error);
        } else {
            console.log('✅ Proceso dockme-auto-update finalizado');
        }
    });

    res.json({
        success: true,
        message: 'Dockme auto-update iniciado'
    });
});

// ============================
// Proxy auto-update Dockme remoto
// ============================
app.post('/api/update-dockme', async (req, res) => {
    const { endpoint } = req.body;

    if (!endpoint) {
        return res.status(400).json({
            success: false,
            message: 'Endpoint no especificado'
        });
    }

    const targetUrl = `http://${endpoint}/api/update-self`;

    console.log(`🔁 Proxy auto-update a Dockme remoto: ${targetUrl}`);

    try {
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('❌ Error desde Dockme remoto:', data);
            return res.status(response.status).json(data);
        }

        return res.json({
            success: true,
            proxied: true,
            endpoint,
            result: data
        });

    } catch (err) {
        console.error('❌ Error contactando Dockme remoto:', err);
        return res.status(500).json({
            success: false,
            message: 'No se pudo contactar con Dockme remoto'
        });
    }
});

// ============================
// GET /api/shoutrrr-services
// ============================
app.get('/api/shoutrrr-services', (req, res) => {
  try {
    const servicesPath = '/custom/shoutrrr-services.json';
    if (!fs.existsSync(servicesPath)) return res.json({ services: [] });
    res.json(JSON.parse(fs.readFileSync(servicesPath, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// GET /api/get-settings
// ============================
app.get('/api/get-settings', (req, res) => {
  try {
    res.json(readSettingsFile());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// POST /api/save-settings
// ============================
app.post('/api/save-settings', (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ error: 'Payload inválido' });
    }
    // Merge con valores actuales para no perder campos desconocidos
    const current = readSettingsFile();
    const merged = {
      ...current,
      ...incoming,
      notifications: {
        ...current.notifications,
        ...(incoming.notifications || {})
      }
    };
    writeSettingsFile(merged);

    // Si cambió la hora del check, relanzar scheduler
    if (incoming.checkTime && incoming.checkTime !== current.checkTime) {
      setupScheduler();
    }

    res.json({ success: true, settings: merged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// POST /api/mark-agents-migration-shown
// ============================
app.post('/api/mark-agents-migration-shown', (req, res) => {
  try {
    const settings = readSettingsFile();
    settings.migration_2_1_shown = true;
    writeSettingsFile(settings);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// POST /api/test-notification
// ============================
app.post('/api/test-notification', async (req, res) => {
  try {
    const settings = readSettingsFile();
    const notif = settings.notifications || {};
    const urls = Array.isArray(notif.urls) ? notif.urls.filter(Boolean) : [];
    if (urls.length === 0) {
      return res.status(400).json({ success: false, message: 'No hay URLs de notificación configuradas' });
    }
    const msg = '🔔 DockMe — Notificación de prueba.\n✅ Los saltos de línea funcionan correctamente.';
    const url = urls[0];
    const tmpFile = `/tmp/shoutrrr-test-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, msg);
    exec(`shoutrrr send --url ${JSON.stringify(url)} --message - < ${tmpFile}`,
      { shell: true },
      (err, stdout, stderr) => {
        fs.unlink(tmpFile, () => {});
        if (err) {
          console.error('❌ [Test notif]', err.message);
          return res.json({ success: false, message: err.message });
        }
        console.log('✅ [Test notif] Enviado');
        res.json({ success: true });
      }
    );
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================
// POST /api/set-connected-endpoints
// Sincroniza desde el frontend la lista de endpoints conectados en Dockge.
// Se guarda en memoria — no persiste entre reinicios (se resincroniza automáticamente).
// ============================
app.post('/api/set-connected-endpoints', (req, res) => {
  try {
    const { endpoints } = req.body;
    if (!Array.isArray(endpoints)) return res.status(400).json({ error: 'Se esperaba un array' });
    connectedEndpoints = new Set(endpoints.map(e => e.toLowerCase()));
    console.log(`🔗 [Connected] Endpoints activos: [${[...connectedEndpoints].join(', ') || 'ninguno'}]`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// GET /api/check-status
// ============================
app.get('/api/check-status', (req, res) => {
  try {
    const progressPath = '/app/data/config/check-progress.json';
    if (!fs.existsSync(progressPath)) return res.json({ status: 'idle', percent: 0 });
    res.json(JSON.parse(fs.readFileSync(progressPath, 'utf8')));
  } catch {
    res.json({ status: 'idle', percent: 0 });
  }
});

// ============================
// POST /api/run-prune
// ============================
app.post('/api/run-prune', async (req, res) => {
  const { endpoint, pruneMode } = req.body;

  // Proxy al agente remoto
  if (endpoint && endpoint.toLowerCase() !== 'actual') {
    try {
      const response = await fetch(`http://${endpoint}/api/run-prune`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pruneMode }),
        signal: AbortSignal.timeout(10000)
      });
      const data = await response.json();
      return res.json(data);
    } catch (err) {
      return res.status(502).json({ success: false, message: err.message });
    }
  }

  // Prune local — se ejecuta en background, responde inmediatamente
  const mode = pruneMode || readSettingsFile().pruneMode || 'disabled';
  exec(`/tools/prune.sh ${mode} 2>&1 | tee -a /tmp/prune.log`, { shell: true }, (err) => {
    if (err) console.error('❌ Error en prune local:', err.message);
    else     console.log('✅ Prune local completado');
  });
  res.json({ success: true, message: 'Prune iniciado' });
});

// ============================
// POST /api/set-updates-file
// ============================
// Reescribe completamente el updates.json(para cuando eliminamos un endpoint por ejemplo)
app.post('/api/set-updates-file', (req, res) => {
  try {
    const data = req.body;

    if (!Array.isArray(data)) {
      return res.status(400).json({ error: "Se esperaba un array" });
    }

    writeUpdatesFile(data);
    res.json({ success: true, data });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// GET /api/get-version
// ============================
app.get('/api/get-version', (req, res) => {
    res.sendFile('/tools/version.json');
});

// ============================
// POST /api/set-release-version
// ============================
app.post('/api/set-release-version', async (req, res) => {
    const { version } = req.body;
    if (!version) return res.status(400).json({ error: 'version requerida' });
    try {
        const settings = readSettingsFile();
        settings.release = version;
        writeSettingsFile(settings);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================
// POST /api/agent-alive
// ============================
// Registro de agente remoto al iniciar docker-agent
app.post('/api/agent-alive', (req, res) => {
  try {
    const { hostname, endpoint } = req.body;

    if (!hostname || !endpoint) {
      return res.status(400).json({ 
        error: "Faltan parámetros 'hostname' o 'endpoint'" 
      });
    }

    const currentData = readUpdatesFile();
    
    const existingIndex = currentData.findIndex(h => 
      h.endpoint?.toLowerCase() === endpoint.toLowerCase()
    );

    if (existingIndex >= 0) {
      // Ya existe → actualizar solo hostname (mantener updates)
      currentData[existingIndex].hostname = hostname;
      console.log(`✅ Agente actualizado: ${hostname} (${endpoint})`);
    } else {
      // No existe → crear nuevo con updates vacías
      currentData.push({
        hostname,
        endpoint,
        updates: []
      });
      console.log(`🆕 Nuevo agente registrado: ${hostname} (${endpoint})`);
    }

    writeUpdatesFile(currentData);
    res.json({ 
      success: true, 
      message: 'Agente registrado correctamente' 
    });

  } catch (err) {
    console.error('❌ Error en /api/agent-alive:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================
// Stacks config helpers
// ============================
function readStacksFile() {
  if (!fs.existsSync(stacksPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(stacksPath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeStacksFile(data) {
  fs.writeFileSync(stacksPath, JSON.stringify(data, null, 2));
}

// ============================
// GET /api/get-stack
// ============================
app.get('/api/get-stack', (req, res) => {
  try {
    const { name, endpoint } = req.query;
    if (!name || !endpoint) {
      return res.status(400).json({ error: "Faltan parámetros 'name' o 'endpoint'" });
    }
    const data = readStacksFile();
    const stack = data.find(s =>
      s.name.toLowerCase() === name.toLowerCase() &&
      s.endpoint.toLowerCase() === endpoint.toLowerCase()
    );
    res.json({ success: true, stack: stack || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// POST /api/set-stack
// ============================
app.post('/api/set-stack', (req, res) => {
  try {
    const { name, endpoint, url, repo, favorite, order, _delete, applyRepoToAll } = req.body;
    if (!name || !endpoint) {
      return res.status(400).json({ error: "Faltan parámetros 'name' o 'endpoint'" });
    }
    const data = readStacksFile();

    // Si repo viene con applyRepoToAll, actualizarlo en todas las entradas con ese nombre
    if (repo !== undefined && applyRepoToAll) {
      const matches = data.filter(s => s.name.toLowerCase() === name.toLowerCase());
      if (matches.length > 0) {
        matches.forEach(s => {
          s.repo = repo;
          // Si viene url, aplicarla solo a la entrada del endpoint actual
          if (url !== undefined && s.endpoint.toLowerCase() === endpoint.toLowerCase()) {
            s.url = url;
          }
        });
        // Si no existe entrada para este endpoint concreto, crearla
        const hasThisEndpoint = matches.some(s => s.endpoint.toLowerCase() === endpoint.toLowerCase());
        if (!hasThisEndpoint) {
          data.push({ name, endpoint, url: url || '', repo, favorite: false, order: null });
        }
      } else {
        // No existe ninguna entrada con ese nombre — crear la del endpoint actual
        data.push({ name, endpoint, url: url || '', repo, favorite: false, order: null });
      }
      writeStacksFile(data);
      return res.json({ success: true });
    }

    const idx = data.findIndex(s =>
      s.name.toLowerCase() === name.toLowerCase() &&
      s.endpoint.toLowerCase() === endpoint.toLowerCase()
    );
    if (idx >= 0) {
      if (_delete) {
        // Borrar icono si nadie más lo usa
        const oldIcon = data[idx].icon;
        if (oldIcon) {
          const usedByOther = data.some((s, i) => i !== idx && s.icon === oldIcon);
          if (!usedByOther) {
            const iconPath = path.join('/app/data/icons', oldIcon);
            if (fs.existsSync(iconPath)) fs.unlinkSync(iconPath);
          }
        }
        data.splice(idx, 1);
      } else {
        if (url      !== undefined) data[idx].url      = url;
        if (repo     !== undefined) data[idx].repo     = repo;
        if (favorite !== undefined) data[idx].favorite = favorite;
        if (order    !== undefined) data[idx].order    = order;
      }
    } else if (!_delete) {
      data.push({
        name,
        endpoint,
        url:      url      !== undefined ? url      : '',
        repo:     repo     !== undefined ? repo     : '',
        favorite: favorite !== undefined ? favorite : false,
        order:    order    !== undefined ? order    : null
      });
      // Intentar descargar icono del CDN si no tiene (async, no bloquea respuesta)
      tryDownloadIconFromCDN(name).then(iconFile => {
        if (!iconFile) return;
        const fresh = readStacksFile();
        fresh.filter(s => s.name.toLowerCase() === name.toLowerCase() && !s.icon)
             .forEach(s => { s.icon = iconFile; });
        writeStacksFile(fresh);
      }).catch(() => {});
    }
    writeStacksFile(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// POST /api/run-check
// ============================
app.post('/api/run-check', async (req, res) => {
    const { endpoint, pruneMode, fromCycle } = req.body;
    // fromCycle=true: viene del scheduler — usa el pruneMode configurado.
    // fromCycle falsy: check manual del usuario — prune siempre disabled.
    const mode = fromCycle ? (pruneMode || 'disabled') : 'disabled';

    // Si viene endpoint remoto, proxificar al agente
    if (endpoint && endpoint.toLowerCase() !== 'actual') {
        try {
            const response = await fetch(`http://${endpoint}/api/run-check`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pruneMode: mode, fromCycle }),
                signal: AbortSignal.timeout(10000)
            });
            const data = await response.json();
            return res.json(data);
        } catch (err) {
            return res.status(502).json({ success: false, message: `No se pudo contactar con el agente: ${err.message}` });
        }
    }

    // Check local — guard contra doble ejecución
    const progressPath = '/app/data/config/check-progress.json';
    if (fs.existsSync(progressPath)) {
        try {
            const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
            if (progress.status === 'checking') {
                return res.status(409).json({ success: false, message: 'Ya hay un check en curso' });
            }
        } catch {}
    }

    const isManual = !fromCycle;
    console.log(`🔍 Lanzando check ${isManual ? 'manual' : '[Cycle]'} (prune: ${mode})...`);
    // Siempre pasar 'manual' para bypass del cooldown de 12h —
    // el scheduler Node ya gestiona la frecuencia, el cooldown era para el viejo cron bash.
    exec(`/tools/check-updates.sh ${mode} manual 2>&1 | tee -a /tmp/updates-check.log > /proc/1/fd/1`,
        { detached: true, shell: true }, (error) => {
        if (error) console.error('❌ Error en check-updates:', error);
        else        console.log('✅ check-updates finalizado');
    });

    res.json({ success: true, message: 'Check iniciado' });
});

// ============================
// Links helpers
// ============================
function readLinksFile() {
  if (!fs.existsSync(linksPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(linksPath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeLinksFile(data) {
  fs.writeFileSync(linksPath, JSON.stringify(data, null, 2));
}

// ============================
// GET /api/sources
// ============================
app.get('/api/sources', (req, res) => {
  try {
    if (!fs.existsSync('/custom/sources.json')) return res.json({});
    const data = JSON.parse(fs.readFileSync('/custom/sources.json', 'utf8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/get-links
// ============================
app.get('/api/get-links', (req, res) => {
  try {
    res.json({ success: true, links: readLinksFile() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// POST /api/set-links
// ============================
app.post('/api/set-links', (req, res) => {
  try {
    const { links } = req.body;
    if (!Array.isArray(links)) {
      return res.status(400).json({ error: "Se esperaba un array en 'links'" });
    }
    // Borrar iconos de links eliminados
    const oldLinks = readLinksFile();
    const newIcons = new Set(links.flatMap(c => (c.links || []).map(l => l.icon)).filter(Boolean));
    oldLinks.forEach(cat => {
      (cat.links || []).forEach(link => {
        if (link.icon && !newIcons.has(link.icon)) {
          const iconPath = path.join('/app/data/icons', link.icon);
          if (fs.existsSync(iconPath)) fs.unlinkSync(iconPath);
        }
      });
    });
    writeLinksFile(links);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// POST /api/fetch-favicon
// ============================
app.post('/api/fetch-favicon', async (req, res) => {
  try {
    const { url, name } = req.body;
    if (!url || !name) {
      return res.status(400).json({ error: "Faltan parámetros" });
    }
    const hostname = new URL(url).hostname;
    const parts = hostname.split('.');
    const domain = parts.length > 2 ? parts.slice(-2).join('.') : hostname;
    const isLocalIP = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|localhost)/.test(hostname);
    const { protocol, host } = new URL(url);

    // 1. Intentar favicon directo en el servidor
    let buffer = null;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const directUrl = `${protocol}//${host}/favicon.ico`;
        const directRes = await fetch(directUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (directRes.ok) {
            buffer = await directRes.arrayBuffer();
        }
    } catch {}

    // 2. Si no, intentar Google Favicons (solo para dominios públicos)
    if (!buffer && !isLocalIP) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);
            const googleUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
            const googleRes = await fetch(googleUrl, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (googleRes.ok) {
                buffer = await googleRes.arrayBuffer();
            }
        } catch {}
    }

    if (!buffer) return res.json({ success: false });

    const iconsDir = '/app/data/icons';
    const iconPath = path.join(iconsDir, `link-${name}.png`);
    fs.mkdirSync(iconsDir, { recursive: true });
    fs.writeFileSync(iconPath, Buffer.from(buffer));
    res.json({ success: true, iconFile: `link-${name}.png` });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ============================
// Funciones layouts
// ============================
function readLayoutsFile() {
  if (!fs.existsSync(layoutsPath)) {
    fs.writeFileSync(layoutsPath, JSON.stringify({}, null, 2));
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(layoutsPath, 'utf8'));
  } catch {
    return { default: { name: 'Por defecto', deviceId: 'default', blocks: [] } };
  }
}

function writeLayoutsFile(data) {
  fs.writeFileSync(layoutsPath, JSON.stringify(data, null, 2));
}

// ============================
// GET /api/get-layouts
// ============================
app.get('/api/get-layouts', (req, res) => {
  try {
    res.json({ success: true, layouts: readLayoutsFile() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// POST /api/set-layout
// ============================
app.post('/api/set-layout', (req, res) => {
  try {
    const { profileName, deviceId, blocks, sidebarWidth } = req.body;
    if (!profileName || !deviceId || !Array.isArray(blocks)) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }
    const layouts = readLayoutsFile();
    if (profileName === 'default') {
      return res.status(403).json({ error: 'No se puede modificar el perfil por defecto' });
    }
    const layout = { name: profileName, deviceId, blocks };
    if (sidebarWidth != null) layout.sidebarWidth = sidebarWidth;
    layouts[profileName] = layout;
    writeLayoutsFile(layouts);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// POST /api/rename-layout
// ============================
app.post('/api/rename-layout', (req, res) => {
  try {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) return res.status(400).json({ error: 'Faltan parámetros' });
    if (oldName === 'default') return res.status(403).json({ error: 'No se puede renombrar el perfil por defecto' });
    const layouts = readLayoutsFile();
    if (!layouts[oldName]) return res.status(404).json({ error: 'Perfil no encontrado' });
    layouts[newName] = { ...layouts[oldName], name: newName };
    delete layouts[oldName];
    writeLayoutsFile(layouts);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// DELETE /api/delete-layout/:name
// ============================
app.delete('/api/delete-layout/:name', (req, res) => {
  try {
    const { name } = req.params;
    if (name === 'default') return res.status(403).json({ error: 'No se puede eliminar el perfil por defecto' });
    const layouts = readLayoutsFile();
    if (!layouts[name]) return res.status(404).json({ error: 'Perfil no encontrado' });
    delete layouts[name];
    writeLayoutsFile(layouts);
    // Si no quedan perfiles de usuario, limpiar order y width de links.json
    const userProfiles = Object.keys(layouts).filter(k => k !== 'default');
    if (userProfiles.length === 0) {
        const links = readLinksFile();
        links.forEach(b => { delete b.order; delete b.width; delete b.height; });
        writeLinksFile(links);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// ============================
// Migración automática al arrancar
// ============================
// Intenta descargar el icono de un stack desde el CDN de dashboard-icons
// Prueba: {name}.svg y {name}-home.svg
async function tryDownloadIconFromCDN(stackName) {
  const iconsDir = '/app/data/icons';
  const CDN_BASE = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg';
  const candidates = [
    `${stackName}.svg`,
    `${stackName}-home.svg`
  ];
  for (const filename of candidates) {
    try {
      const res = await fetch(`${CDN_BASE}/${filename}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const text = await res.text();
      if (!/<svg[\s>]/i.test(text)) continue;
      fs.mkdirSync(iconsDir, { recursive: true });
      fs.writeFileSync(path.join(iconsDir, filename), text, 'utf8');
      console.log(`✅ Icono descargado del CDN: ${stackName} → ${filename}`);
      return filename;
    } catch {
      // timeout o error de red — siguiente candidato
    }
  }
  return null;
}

// ============================
// ============================
// GET /api/auto-icon
// ============================
app.get('/api/auto-icon', async (req, res) => {
  try {
    const { name, endpoint } = req.query;
    if (!name) return res.status(400).json({ error: 'Falta parámetro name' });

    // Si ya tiene icono en disco, no hacer nada
    const stacks = readStacksFile();
    const entry = stacks.find(s =>
      s.name.toLowerCase() === name.toLowerCase() &&
      (endpoint ? s.endpoint.toLowerCase() === endpoint.toLowerCase() : true)
    );
    if (entry?.icon && fs.existsSync(path.join('/app/data/icons', entry.icon))) {
      return res.json({ success: false, reason: 'already-has-icon' });
    }

    const iconFile = await tryDownloadIconFromCDN(name);
    if (!iconFile) return res.json({ success: false, reason: 'not-found' });

    // Actualizar todas las entradas con ese nombre
    const fresh = readStacksFile();
    fresh.filter(s => s.name.toLowerCase() === name.toLowerCase())
         .forEach(s => { s.icon = iconFile; });
    writeStacksFile(fresh);

    res.json({ success: true, iconFile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/icon-version
// ============================
app.get('/api/icon-version', (req, res) => {
  try {
    const iconsDir = '/app/data/icons';
    if (!fs.existsSync(iconsDir)) return res.json({ version: 0 });
    const files = fs.readdirSync(iconsDir);
    const maxMtime = files.reduce((max, file) => {
      try {
        const mtime = fs.statSync(path.join(iconsDir, file)).mtimeMs;
        return mtime > max ? mtime : max;
      } catch { return max; }
    }, 0);
    res.json({ version: Math.floor(maxMtime) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// POST /api/set-primary-host
// ============================
app.post('/api/set-primary-host', (req, res) => {
  try {
    const { primaryHost, oldHostname } = req.body;
    if (!primaryHost) return res.status(400).json({ error: 'Falta parámetro primaryHost' });

    // Guardar en settings.json (fuente de verdad para primaryHost)
    const settings = readSettingsFile();
    const oldHost = settings.primaryHost || oldHostname;
    settings.primaryHost = primaryHost;
    writeSettingsFile(settings);

    // Actualizar URLs de stacks que usen el host anterior
    const stacks = readStacksFile();
    let changed = false;

    // 1. Sustituir URLs que usen el patrón http://{oldHost}:puerto
    if (oldHost && oldHost !== primaryHost) {
      const pattern = `http://${oldHost}:`;
      stacks.forEach(s => {
        if (s.url && s.url.startsWith(pattern)) {
          const port = s.url.slice(pattern.length);
          s.url = `http://${primaryHost}:${port}`;
          changed = true;
        }
      });
    }

    // 2. Rellenar stacks locales sin URL usando compose.yaml + nuevo primaryHost
    stacks.forEach(s => {
      if (!s.url && s.endpoint?.toLowerCase() === 'actual') {
        const port = getStackPort(s.name);
        if (port) {
          s.url = `http://${primaryHost}:${port}`;
          changed = true;
        }
      }
    });

    if (changed) writeStacksFile(stacks);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lee el primer puerto host del compose.yaml de un stack
function getStackPort(stackName) {
  try {
    const stacksDir = process.env.DOCKGE_STACKS_DIR || '/opt/stacks';
    const composePath = path.join(stacksDir, stackName, 'compose.yaml');
    if (!fs.existsSync(composePath)) return null;
    const content = fs.readFileSync(composePath, 'utf8');
    const match = content.match(/^\s*-\s*["']?(?:[\d.]+:)?(\d+):\d+/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// TODO: eliminar en v2.3 — migración temporal para rellenar icon/repo en stacks.json
function migrateStacksOnStartup() {
  try {
    const sourcesPath = "/custom/sources.json";
    const iconsDir    = "/app/data/icons";

    const stacks  = readStacksFile();
    const sources = fs.existsSync(sourcesPath)
      ? JSON.parse(fs.readFileSync(sourcesPath, "utf8"))
      : {};

    let changed = false;

    for (const entry of stacks) {
      // --- repo: migrar desde sources.json si no tiene
      if (!entry.repo) {
        const repoUrl = sources[entry.name] || sources[entry.name?.toLowerCase()];
        if (repoUrl) {
          entry.repo = repoUrl;
          changed = true;
        }
      }

      // --- icon: asignar {name}.svg si existe el fichero y no tiene icon
      if (!entry.icon) {
        const svgPath = path.join(iconsDir, `${entry.name}.svg`);
        if (fs.existsSync(svgPath)) {
          entry.icon = `${entry.name}.svg`;
          changed = true;
        }
      }


    }

    // Normalizar estructura de cada entrada (campos en orden consistente)
    const normalized = stacks.map(s => ({
      name:     s.name     || '',
      endpoint: s.endpoint || 'Actual',
      icon:     s.icon     || '',
      url:      s.url      || '',
      repo:     s.repo     || '',
      favorite: s.favorite || false,
      order:    s.order    ?? null
    }));

    // Escribir siempre para garantizar estructura normalizada
    writeStacksFile(normalized);
    if (changed) {
      console.log("✅ Migración stacks.json completada (icon/repo/url)");
    } else {
      console.log("✅ Migración stacks.json: estructura normalizada");
    }
  } catch (err) {
    console.error("❌ Error en migración stacks.json:", err.message);
  }
}

// Servidor
// ============================
migrateStacksOnStartup();

// Descarga async de iconos desde CDN para stacks sin icono (no bloquea el arranque)
// Los agentes remotos no necesitan iconos — los gestiona el central
(async () => {
  const _centralUrl = process.env.CENTRAL_URL || process.env.WEBHOOK_URL || '';
  if (_centralUrl && process.env.ENDPOINT !== 'Actual') return; // agente: no descargar iconos
  try {
    const stacksDir = process.env.DOCKGE_STACKS_DIR || '/opt/stacks';
    const iconsDir  = '/app/data/icons';

    // Leer nombres de stacks desde el filesystem (subcarpetas de /opt/stacks)
    let stackNamesFromFs = [];
    if (fs.existsSync(stacksDir)) {
      stackNamesFromFs = fs.readdirSync(stacksDir).filter(f =>
        fs.statSync(path.join(stacksDir, f)).isDirectory()
      );
    }

    // Combinar con los que ya están en stacks.json
    const stacks = readStacksFile();
    const namesFromJson = stacks.filter(s => !s.icon || !fs.existsSync(path.join(iconsDir, s.icon)))
                                .map(s => s.name.toLowerCase());
    const allNames = [...new Set([...stackNamesFromFs.map(n => n.toLowerCase()), ...namesFromJson])];

    if (allNames.length === 0) return;
    console.log(`🔍 Buscando iconos en CDN para ${allNames.length} stack(s)...`);

    // Cargar sources.json para asignar repos al crear entradas nuevas
    const sourcesPath = '/custom/sources.json';
    const sources = fs.existsSync(sourcesPath)
      ? JSON.parse(fs.readFileSync(sourcesPath, 'utf8'))
      : {};

    const updated = readStacksFile();
    let changed = false;

    for (const name of allNames) {
      // Si ya tiene icono en disco, saltar
      const existing = updated.find(s => s.name.toLowerCase() === name);
      if (existing?.icon && fs.existsSync(path.join(iconsDir, existing.icon))) continue;

      const iconFile = await tryDownloadIconFromCDN(name);
      if (!iconFile) continue;

      // Actualizar entradas existentes en stacks.json
      const matches = updated.filter(s => s.name.toLowerCase() === name);
      const repoFromSources = sources[name] || sources[name.toLowerCase()] || '';
      if (matches.length > 0) {
        matches.forEach(s => {
          s.icon = iconFile;
          if (!s.repo && repoFromSources) s.repo = repoFromSources;
        });
      } else {
        // Stack existe en filesystem pero no en stacks.json — crear entrada completa
        updated.push({ name, endpoint: 'Actual', icon: iconFile, url: '', repo: repoFromSources, favorite: false, order: null });
      }
      changed = true;
    }

    if (changed) writeStacksFile(updated);

    // Asignar URL de servicio para stacks locales sin url
    // Solo si ya hay primaryHost configurado — si no, el modal lo pedirá al usuario
    const localUpdates = readUpdatesFile();
    const localHost = localUpdates.find(h => h.endpoint?.toLowerCase() === 'actual');
    if (localHost?.primaryHost) {
      const updatedForUrl = readStacksFile();
      let urlChanged = false;
      for (const entry of updatedForUrl) {
        if (!entry.url && entry.endpoint?.toLowerCase() === 'actual') {
          const port = getStackPort(entry.name);
          if (port) {
            entry.url = `http://${localHost.primaryHost}:${port}`;
            urlChanged = true;
          }
        }
      }
      if (urlChanged) {
        writeStacksFile(updatedForUrl);
        console.log('✅ URLs de servicio asignadas desde compose.yaml');
      }
    }

  } catch (err) {
    console.error('❌ Error en descarga CDN de iconos:', err.message);
  }
})();

// ============================
// Scheduler Node (central/standalone)
// ============================
const IS_AGENT = !!(process.env.WEBHOOK_URL && process.env.ENDPOINT && process.env.ENDPOINT !== 'Actual');

let schedulerTimer = null;

// Estado del ciclo activo: se rellena al lanzar los checks y se limpia
// cuando todos los servidores han respondido vía set-updates (o timeout).
let activeCycle = null;

// Lista de endpoints conectados sincronizada desde el frontend.
// Vacío = sin info todavía (usar todos los de updates.json como fallback).
let connectedEndpoints = new Set();

// Lanza el check+prune en un endpoint sin esperar respuesta.
// El endpoint reportará al central via set-updates cuando termine.
async function launchCheck(endpoint, pruneMode) {
  if (endpoint.toLowerCase() === 'actual') {
    console.log(`🔍 [Cycle] Lanzando check local (prune: ${pruneMode})...`);
    // Llamar via HTTP al propio API (puerto 5002) para flujo uniforme con remotos.
    // check-updates.sh hará POST a set-updates al terminar (señal de fin de ciclo).
    try {
      await fetch(`http://localhost:5002/api/run-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pruneMode, fromCycle: true }),
        signal: AbortSignal.timeout(10000)
      });
    } catch (err) {
      console.error(`❌ [Cycle] Error lanzando check local: ${err.message}`);
      if (activeCycle) {
        activeCycle.pending.delete('actual');
        activeCycle.timedOut.push('Actual (local)');
        if (activeCycle.pending.size === 0) activeCycle.resolve(activeCycle.timedOut);
      }
    }
  } else {
    console.log(`🔍 [Cycle] Lanzando check en ${endpoint} (prune: ${pruneMode})...`);
    try {
      await fetch(`http://${endpoint}/api/run-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pruneMode, fromCycle: true }),
        signal: AbortSignal.timeout(10000)
      });
    } catch (err) {
      console.error(`❌ [Cycle] No se pudo contactar con ${endpoint}: ${err.message}`);
      // Si no se puede contactar, quitar de pendientes para no bloquear el ciclo
      if (activeCycle) {
        activeCycle.pending.delete(endpoint.toLowerCase());
        activeCycle.timedOut.push(endpoint);
        if (activeCycle.pending.size === 0) activeCycle.resolve(activeCycle.timedOut);
      }
    }
  }
}

function findNewUpdates(before, after) {
  const results = [];
  for (const serverAfter of after) {
    const serverBefore = before.find(h =>
      h.endpoint?.toLowerCase() === serverAfter.endpoint?.toLowerCase()
    );
    const stacksBefore = serverBefore?.updates || [];
    for (const stackAfter of (serverAfter.updates || [])) {
      const stackBefore = stacksBefore.find(u => u.stack === stackAfter.stack);
      if (!stackBefore) {
        results.push({ hostname: serverAfter.hostname, stack: stackAfter.stack });
      } else {
        const newDockers = stackAfter.dockers.filter(d => !(stackBefore.dockers || []).includes(d));
        if (newDockers.length > 0) {
          results.push({ hostname: serverAfter.hostname, stack: stackAfter.stack });
        }
      }
    }
  }
  return results;
}

function buildMessage(newUpdates, timedOut = []) {
  const byHost = {};
  for (const item of newUpdates) {
    if (!byHost[item.hostname]) byHost[item.hostname] = [];
    byHost[item.hostname].push(item.stack);
  }
  let msg = '';
  if (newUpdates.length > 0) {
    msg += '🐋 Nuevas actualizaciones en Dockme\n';
    for (const [hostname, stacks] of Object.entries(byHost)) {
      msg += `\n🖥 ${hostname}\n`;
      for (const stack of stacks) msg += `  • ${stack}\n`;
    }
  }
  if (timedOut.length > 0) {
    const updates = readUpdatesFile();
    for (const ep of timedOut) {
      const host = updates.find(h => h.endpoint?.toLowerCase() === ep.toLowerCase());
      const hostname = host?.hostname || ep;
      if (msg) msg += '\n';
      msg += `⚠️ ${hostname}\n`;
      msg += '  • Sin respuesta tras 10 min.\n';
    }
  }
  return msg.trim();
}

async function sendNotification(message) {
  if (!message) return;
  const settings = readSettingsFile();
  const notif = settings.notifications || {};
  if (!notif.enabled) {
    console.log('📵 [Notif] Notificaciones desactivadas');
    return;
  }
  const urls = Array.isArray(notif.urls) ? notif.urls.filter(Boolean) : [];
  if (urls.length === 0) {
    console.log('📵 [Notif] Sin URLs configuradas');
    return;
  }
  for (const url of urls) {
    await new Promise((resolve) => {
      // Escribir mensaje a fichero temporal para preservar saltos de línea
      const tmpFile = `/tmp/shoutrrr-msg-${Date.now()}.txt`;
      fs.writeFileSync(tmpFile, message);
      exec(`shoutrrr send --url ${JSON.stringify(url)} --message - < ${tmpFile}`,
        { shell: true },
        (err, stdout, stderr) => {
          fs.unlink(tmpFile, () => {});
          if (err) console.error(`❌ [Notif] Error enviando a ${url.split('://')[0]}: ${err.message}`);
          else     console.log(`✅ [Notif] Enviado a ${url.split('://')[0]}`);
          resolve();
        }
      );
    });
  }
}

async function runScheduledChecks(notify = true) {
  console.log(`🕒 [Cycle] Iniciando — ${new Date().toISOString()}`);

  const snapshotBefore = JSON.parse(JSON.stringify(readUpdatesFile()));
  const updates  = readUpdatesFile();
  const settings = readSettingsFile();
  const pruneMode = settings.pruneMode || 'disabled';

  // Solo incluir endpoints conectados (sincronizados desde el frontend).
  // Si la lista está vacía (aún no sincronizada), incluir todos como fallback.
  const servers = updates
    .filter(h => {
      const ep = (h.endpoint || '').toLowerCase();
      if (ep === 'actual') return true;
      if (connectedEndpoints.size > 0) return connectedEndpoints.has(ep);
      return true; // fallback: sin info de conexión todavía
    })
    .map(h => h.endpoint);

  if (servers.length === 0) {
    console.log('⚠️ [Cycle] No hay servidores registrados');
    return;
  }

  console.log(`🖥️ [Cycle] Servidores: ${servers.join(', ')} | Prune: ${pruneMode}`);

  // Crear ciclo: Promise que resuelve cuando todos respondan vía set-updates
  const cycleResult = await new Promise((resolve) => {
    const TIMEOUT_MS = 10 * 60 * 1000;
    const timer = setTimeout(() => {
      if (!activeCycle) return;
      const remaining = [...activeCycle.pending];
      console.warn(`⏱️ [Cycle] Timeout — sin respuesta de: ${remaining.join(', ')}`);
      activeCycle = null;
      resolve({ timedOut: remaining });
    }, TIMEOUT_MS);

    activeCycle = {
      pending:  new Set(servers.map(e => e.toLowerCase())),
      timedOut: [],
      resolve:  (timedOut = []) => {
        clearTimeout(timer);
        activeCycle = null;
        resolve({ timedOut });
      }
    };

    // Lanzar todos en paralelo (fire & forget — cada uno notificará al terminar)
    Promise.all(servers.map(ep => launchCheck(ep, pruneMode)));
  });

  console.log(`🎉 [Cycle] Completado — ${new Date().toISOString()}`);

  if (notify) {
    const snapshotAfter = readUpdatesFile();
    const newUpdates = findNewUpdates(snapshotBefore, snapshotAfter);
    console.log(`📊 [Cycle] Novedades: ${newUpdates.length} | Timeouts: ${JSON.stringify(cycleResult.timedOut)}`);
    const msg = buildMessage(newUpdates, cycleResult.timedOut);
    if (msg) {
      console.log(`📬 [Cycle] Enviando notificación (${newUpdates.length} novedad(es), ${cycleResult.timedOut.length} timeout(s))`);
      await sendNotification(msg);
    } else {
      console.log('📭 [Cycle] Sin novedades ni timeouts, no se notifica');
    }
  }
}

function setupScheduler() {
  if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = null; }
  if (IS_AGENT) return;

  const settings  = readSettingsFile();
  const checkTime = settings.checkTime || '09:00';
  const [hhStr, mmStr] = checkTime.split(':');
  const hh = parseInt(hhStr, 10);
  const mm = parseInt(mmStr, 10);

  if (isNaN(hh) || isNaN(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    console.warn(`⚠️ [Scheduler] Hora inválida "${checkTime}"`);
    return;
  }

  const scheduleNext = () => {
    const now  = new Date();
    const next = new Date();
    next.setHours(hh, mm, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next - now;
    console.log(`⏰ [Scheduler] Próximo check a las ${checkTime} (en ${Math.round(delay / 60000)} min)`);
    schedulerTimer = setTimeout(async () => {
      await runScheduledChecks(true);
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}

// ============================
// DEV — eliminar antes de release
// ============================
// Arranque
// ============================
app.listen(port, () => {
  console.log(`✅ API Node lista en puerto ${port}`);
  setupScheduler();
});