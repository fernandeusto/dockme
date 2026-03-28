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
      // Reemplazar bloque existente
      currentData[existingIndex] = {
        hostname,
        endpoint,
        uiUrl: currentData[existingIndex].uiUrl || '',
        updates: updates.map(u => ({
          stack: u.stack,
          dockers: u.dockers
        }))
      };
    } else {
      // Nuevo host
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
    const { stack, type } = req.body;
    if (!stack || !type) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }
    if (!['url', 'upload'].includes(type)) {
      return res.status(400).json({ error: 'Tipo inválido' });
    }
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
      const svgText = await response.text();
      if (
        !contentType.includes('image/svg+xml') &&
        !svgText.trim().startsWith('<svg')
      ) {
        return res.status(400).json({
          error: 'La URL no contiene un SVG válido'
        });
      }
      const iconsDir = '/app/data/icons';
      const iconPath = path.join(iconsDir, `${stack}.svg`);
      fs.mkdirSync(iconsDir, { recursive: true });
      fs.writeFileSync(iconPath, svgText, 'utf8');
      return res.json({
        success: true,
        stack,
        message: 'Icono actualizado desde URL'
      });
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
      const iconsDir = '/app/data/icons';
      const iconPath = path.join(iconsDir, `${stack}.svg`);
      fs.mkdirSync(iconsDir, { recursive: true });
      fs.writeFileSync(iconPath, svg, 'utf8');
      return res.json({
        success: true,
        stack,
        message: 'Icono actualizado desde archivo local'
      });
    }

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
        const raw = fs.readFileSync(updatesPath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
            const host = data.find(h => (h.endpoint || '').toLowerCase() === 'actual');
            if (host) host.release = version;
            fs.writeFileSync(updatesPath, JSON.stringify(data, null, 2));
        }
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
    const { name, endpoint, url, favorite, order, _delete } = req.body;
    if (!name || !endpoint) {
      return res.status(400).json({ error: "Faltan parámetros 'name' o 'endpoint'" });
    }
    const data = readStacksFile();
    const idx = data.findIndex(s =>
      s.name.toLowerCase() === name.toLowerCase() &&
      s.endpoint.toLowerCase() === endpoint.toLowerCase()
    );
    if (idx >= 0) {
      if (_delete) {
        data.splice(idx, 1);
      } else {
        if (url      !== undefined) data[idx].url      = url;
        if (favorite !== undefined) data[idx].favorite = favorite;
        if (order    !== undefined) data[idx].order    = order;
      }
    } else if (!_delete) {
      data.push({
        name,
        endpoint,
        url:      url      !== undefined ? url      : '',
        favorite: favorite !== undefined ? favorite : false,
        order:    order    !== undefined ? order    : null
      });
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
app.post('/api/run-check', (req, res) => {
    // Comprobar si ya hay un check en curso
    if (fs.existsSync('/tmp/check-progress.json')) {
        try {
            const progress = JSON.parse(fs.readFileSync('/tmp/check-progress.json', 'utf8'));
            if (progress.status === 'checking') {
                return res.status(409).json({ success: false, message: 'Ya hay un check en curso' });
            }
        } catch {}
    }

    console.log('🔍 Lanzando check-updates manual...');

    exec('/tools/check-updates.sh manual 2>&1 | tee -a /tmp/updates-check.log > /proc/1/fd/1', 
        { detached: true, shell: true }, (error) => {
        if (error) {
            console.error('❌ Error en check-updates:', error);
        } else {
            console.log('✅ check-updates finalizado');
        }
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
    const { profileName, deviceId, blocks } = req.body;
    if (!profileName || !deviceId || !Array.isArray(blocks)) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }
    const layouts = readLayoutsFile();
    if (profileName === 'default') {
      return res.status(403).json({ error: 'No se puede modificar el perfil por defecto' });
    }
    layouts[profileName] = { name: profileName, deviceId, blocks };
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
// Servidor
// ============================
app.listen(port, () => {
  console.log(`✅ API Node lista en puerto ${port}`);
});