import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec, spawn } from 'child_process';
import http from 'http';
import { io } from 'socket.io-client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Añadir timestamp a todos los logs
const _origLog   = console.log;
const _origWarn  = console.warn;
const _origError = console.error;
const _ts = () => new Date().toLocaleString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' }).replace(',', '');
console.log   = (...a) => _origLog(`[${_ts()}]`,   ...a);
console.warn  = (...a) => _origWarn(`[${_ts()}]`,  ...a);
console.error = (...a) => _origError(`[${_ts()}]`, ...a);

const app = express();
const port = 5002;

app.use(express.json({ limit: '2mb' }));

// Servir xterm.js y xterm.css desde /custom
app.get('/api/xterm.js',  (req, res) => res.sendFile('/custom/xterm.js'));
app.get('/api/xterm.css', (req, res) => res.sendFile('/custom/xterm.css'));

const updatesPath  = "/app/data/config/updates.json";
const stacksPath   = "/app/data/config/stacks.json";
const linksPath    = "/app/data/config/links.json";
const layoutsPath  = "/app/data/config/layouts.json";
const settingsPath = "/app/data/config/settings.json";
const telegramBotStatePath = "/app/data/config/telegram-bot-state.json";

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

function readTelegramBotState() {
  if (!fs.existsSync(telegramBotStatePath)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(telegramBotStatePath, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function saveTelegramBotMessageId(chatId, messageId) {
  const state = readTelegramBotState();
  state[String(chatId)] = { messageId: Number(messageId) };
  fs.writeFileSync(telegramBotStatePath, JSON.stringify(state, null, 2));
}

function getTelegramBotMessageId(chatId) {
  const messageId = Number(readTelegramBotState()?.[String(chatId)]?.messageId);
  return Number.isInteger(messageId) && messageId > 0 ? messageId : null;
}

function saveTelegramDockgeToken(token) {
  const state = readTelegramBotState();
  state.dockgeToken = String(token || '').trim();
  fs.writeFileSync(telegramBotStatePath, JSON.stringify(state, null, 2));
}

function getTelegramDockgeToken() {
  return String(readTelegramBotState().dockgeToken || '').trim();
}

const defaultSettings = {
  centralUrl:          '',
  migration_2_1_shown: false,
  primaryHost:         '',
  release:             '',
  notifications: {
    urls:    [],
    updates: true,
    dockerEvents: true,
    excludeActiveStack: true
  },
  telegramBot: {
    enabled: false,
    token: '',
    authorizedChatIds: []
  },
  checkTime: '09:00',
  pruneMode: 'conservative'
};

function readSettingsFile() {
  if (!fs.existsSync(settingsPath)) return { ...defaultSettings };
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const merged = {
      ...defaultSettings,
      ...data,
      notifications: {
        ...defaultSettings.notifications,
        ...(data.notifications || {})
      },
      telegramBot: {
        ...defaultSettings.telegramBot,
        ...(data.telegramBot || {})
      }
    };
    delete merged.notifications.enabled;
    return merged;
  } catch {
    return { ...defaultSettings };
  }
}

function writeSettingsFile(data) {
  const clean = {
    ...data,
    notifications: {
      ...(data.notifications || {})
    },
    telegramBot: {
      ...(data.telegramBot || {})
    }
  };
  delete clean.notifications.enabled;
  fs.writeFileSync(settingsPath, JSON.stringify(clean, null, 2));
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
// POST /api/reorder-servers
// ============================
app.post('/api/reorder-servers', (req, res) => {
  try {
    const { endpoints } = req.body;
    if (!Array.isArray(endpoints) || endpoints.some(endpoint => typeof endpoint !== 'string')) {
      return res.status(400).json({ error: "El campo 'endpoints' debe ser un array de texto" });
    }

    const normalizedEndpoints = endpoints.map(endpoint => endpoint.toLowerCase());
    if (new Set(normalizedEndpoints).size !== normalizedEndpoints.length) {
      return res.status(400).json({ error: 'La lista contiene servidores duplicados' });
    }

    const currentData = readUpdatesFile();
    const entriesByEndpoint = new Map(
      currentData.map(entry => [(entry.endpoint || 'Actual').toLowerCase(), entry])
    );
    const missingEndpoint = normalizedEndpoints.find(endpoint => !entriesByEndpoint.has(endpoint));
    if (missingEndpoint) {
      return res.status(404).json({ error: `Servidor no encontrado: ${missingEndpoint}` });
    }

    const requested = new Set(normalizedEndpoints);
    const reorderedData = [
      ...normalizedEndpoints.map(endpoint => entriesByEndpoint.get(endpoint)),
      ...currentData.filter(entry => !requested.has((entry.endpoint || 'Actual').toLowerCase()))
    ];

    writeUpdatesFile(reorderedData);
    res.json({ success: true, data: reorderedData });
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
app.post('/api/save-settings', async (req, res) => {
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
      },
      telegramBot: {
        ...current.telegramBot,
        ...(incoming.telegramBot || {})
      }
    };
    const telegramConfigChanged = incoming.telegramBot && (
      incoming.telegramBot.enabled === false ||
      (incoming.telegramBot.token !== undefined &&
        String(incoming.telegramBot.token || '').trim() !== String(current.telegramBot?.token || '').trim())
    );
    if (telegramConfigChanged) {
      if (current.telegramBot?.token) {
        await clearTelegramBotCommands(current.telegramBot).catch(err => {
          console.warn(`⚠️ [Telegram] No se pudo limpiar el menú anterior: ${err.message}`);
        });
      }
      saveTelegramDockgeToken('');
    }
    writeSettingsFile(merged);

    // Si cambió la hora del check, relanzar scheduler
    if (incoming.checkTime && incoming.checkTime !== current.checkTime) {
      setupScheduler();
    }

    if (incoming.telegramBot) {
      restartTelegramBot();
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
    // Si viene testUrl en el body, usarla sin guardar
    const testUrl = req.body?.testUrl?.trim();
    let url;
    if (testUrl) {
      url = testUrl;
    } else {
      const settings = readSettingsFile();
      const notif = settings.notifications || {};
      const urls = Array.isArray(notif.urls) ? notif.urls.filter(Boolean) : [];
      if (urls.length === 0) {
        return res.status(400).json({ success: false, message: 'No hay URLs de notificación configuradas' });
      }
      url = urls[0];
    }
    const customMessage = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    const msg = customMessage || '🔔 DockMe — Notificación de prueba.';
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
// POST /api/test-telegram-bot
// ============================
app.post('/api/test-telegram-bot', async (req, res) => {
  try {
    const saved = readSettingsFile().telegramBot || {};
    const token = String(req.body?.token ?? saved.token ?? '').trim();
    const chatIds = normalizeTelegramChatIds(req.body?.authorizedChatIds ?? saved.authorizedChatIds);
    if (!token) {
      return res.status(400).json({ success: false, message: 'Falta el token del bot' });
    }
    if (chatIds.size === 0) {
      return res.status(400).json({ success: false, message: 'Añade al menos un chat ID autorizado' });
    }

    const signal = AbortSignal.timeout(10000);
    const bot = await telegramApi(token, 'getMe', {}, signal);
    const results = await Promise.allSettled([...chatIds].map(chatId =>
      telegramApi(token, 'sendMessage', {
        chat_id: chatId,
        text: '✅ Dockme Bot conectado correctamente.'
      }, signal)
    ));
    const sent = results.filter(result => result.status === 'fulfilled').length;
    if (sent === 0) {
      const firstError = results.find(result => result.status === 'rejected')?.reason;
      throw firstError || new Error('No se pudo enviar el mensaje de prueba');
    }
    res.json({
      success: true,
      message: `Bot @${bot.username || bot.id} conectado. Prueba enviada a ${sent} chat(s).`,
      sent,
      failed: results.length - sent
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Guarda fuera de settings.json la sesión necesaria para que el bot invoque
// exactamente el mismo evento updateStack que utiliza la UI de Dockme.
app.post('/api/telegram-dockge-session', (req, res) => {
  try {
    const settings = readSettingsFile();
    const botToken = String(req.body?.botToken || '').trim();
    const dockgeToken = String(req.body?.dockgeToken || '').trim();
    if (!settings.telegramBot?.enabled || !botToken || botToken !== String(settings.telegramBot.token || '').trim()) {
      return res.status(403).json({ success: false, message: 'Configuración del bot no autorizada' });
    }
    if (!dockgeToken) {
      return res.status(400).json({ success: false, message: 'No se encontró la sesión de Dockme' });
    }
    saveTelegramDockgeToken(dockgeToken);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================
// POST /api/suppress-docker-notification
// Gestiona exclusiones Docker locales para stacks abiertos en Dockme.
// ============================
app.post('/api/suppress-docker-notification', (req, res) => {
  try {
    const { action = 'add', endpoint = 'Actual', stack, source = 'default' } = req.body || {};
    if (!stack || typeof stack !== 'string') {
      return res.status(400).json({ success: false, message: 'Falta stack' });
    }

    if (!['add', 'remove'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Acción inválida' });
    }

    const normalizedEndpoint = endpoint || 'Actual';
    const expiresAt = action === 'add'
      ? addDockerEventExclusion(normalizedEndpoint, stack, source)
      : removeDockerEventExclusion(normalizedEndpoint, stack, source);
    res.json({ success: true, action, expiresAt });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================
// POST /api/docker-event
// Ingesta centralizada de eventos Docker locales/remotos.
// ============================
app.post('/api/docker-event', async (req, res) => {
  try {
    const result = await processDockerEvent(req.body || {});
    res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    console.error(`❌ [Docker events] Error procesando evento: ${err.message}`);
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
    const newSet = new Set(endpoints.map(e => e.toLowerCase()));
    // Solo loguear si la lista cambia
    const changed = newSet.size !== connectedEndpoints.size ||
      [...newSet].some(e => !connectedEndpoints.has(e));
    connectedEndpoints = newSet;
    if (changed) console.log(`🔗 [Connected] Endpoints activos: [${[...connectedEndpoints].join(', ') || 'ninguno'}]`);

    // Migración automática: marcar loggedIn=true para agentes conectados que no lo tengan
    const data = readUpdatesFile();
    let migrated = false;
    data.forEach(h => {
      const ep = (h.endpoint || '').toLowerCase();
      if (ep !== 'actual' && newSet.has(ep) && h.loggedIn !== true) {
        h.loggedIn = true;
        migrated = true;
        console.log(`🔑 [Agent] ${h.hostname} (${h.endpoint}) loggedIn=true (migración automática)`);
      }
    });
    if (migrated) writeUpdatesFile(data);

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
// POST /api/set-agent-logged
// Marca un agente como logueado (login correcto desde el tab Servidores)
// ============================
app.post('/api/set-agent-logged', (req, res) => {
  try {
    const { endpoint, loggedIn } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'Falta endpoint' });
    const data = readUpdatesFile();
    const entry = data.find(h => h.endpoint?.toLowerCase() === endpoint.toLowerCase());
    if (!entry) return res.status(404).json({ error: 'Agente no encontrado' });
    entry.loggedIn = loggedIn !== false; // true por defecto
    writeUpdatesFile(data);
    console.log(`🔑 [Agent] ${entry.hostname} (${endpoint}) loggedIn=${entry.loggedIn}`);
    res.json({ success: true });
  } catch (err) {
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
    exec(`/tools/check-updates.sh ${mode} 2>&1 | tee -a /tmp/updates-check.log > /proc/1/fd/1`,
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
    const { profileName, deviceId, blocks, sidebarWidth, minWidth } = req.body;
    if (!profileName || !deviceId || !Array.isArray(blocks)) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }
    const layouts = readLayoutsFile();
    if (profileName === 'default') {
      return res.status(403).json({ error: 'No se puede modificar el perfil por defecto' });
    }
    const layout = { name: profileName, deviceId, blocks };
    if (sidebarWidth != null) layout.sidebarWidth = sidebarWidth;
    if (minWidth != null)     layout.minWidth      = minWidth;
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

    // Cargar sources.json para asignar repos al crear entradas nuevas
    const sourcesPath = '/custom/sources.json';
    const sources = fs.existsSync(sourcesPath)
      ? JSON.parse(fs.readFileSync(sourcesPath, 'utf8'))
      : {};

    const updated = readStacksFile();
    let changed = false;
    const toDownload = [];

    for (const name of allNames) {
      // Si ya tiene icono en disco, saltar
      const existing = updated.find(s => s.name.toLowerCase() === name);
      if (existing?.icon && fs.existsSync(path.join(iconsDir, existing.icon))) continue;
      toDownload.push(name);
    }

    if (toDownload.length === 0) return;
    console.log(`🔍 Buscando iconos en CDN para ${toDownload.length} stack(s) sin icono...`);

    for (const name of toDownload) {
      // Si ya existe nombre.svg en disco, usarlo directamente sin descargar
      const svgOnDisk = `${name}.svg`;
      const iconFile = fs.existsSync(path.join(iconsDir, svgOnDisk))
        ? svgOnDisk
        : await tryDownloadIconFromCDN(name);
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

// ============================
// Bot de Telegram (fase 1: conexión, autorización y menú básico)
// ============================
let telegramBotController = null;
let telegramBotGeneration = 0;
const telegramBotSessions = new Map();
const telegramBotActionLocks = new Set();
const telegramBotMenuResetTimers = new Map();
let telegramBotUpdateQueueRunning = false;
const TELEGRAM_MENU_RESET_MS = 2 * 60 * 1000;

function normalizeTelegramChatIds(values) {
  const items = Array.isArray(values)
    ? values
    : String(values || '').split(/[\s,;]+/);
  return new Set(items.map(value => String(value).trim()).filter(Boolean));
}

async function telegramApi(token, method, payload = {}, signal) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: signal || AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const retryAfter = Number(data?.parameters?.retry_after || 0);
    const error = new Error(data?.description || `Telegram respondió HTTP ${response.status}`);
    error.retryAfter = retryAfter;
    throw error;
  }
  return data.result;
}

async function clearTelegramBotCommands(config) {
  const token = String(config?.token || '').trim();
  if (!token) return;
  const requests = [telegramApi(token, 'deleteMyCommands')];
  for (const chatId of normalizeTelegramChatIds(config?.authorizedChatIds)) {
    requests.push(telegramApi(token, 'deleteMyCommands', {
      scope: { type: 'chat', chat_id: chatId }
    }));
  }
  const results = await Promise.allSettled(requests);
  const failed = results.filter(result => result.status === 'rejected');
  if (failed.length === results.length) throw failed[0].reason;
  console.log(`🧹 [Telegram] Menú anterior eliminado (${results.length - failed.length}/${results.length} ámbitos)`);
}

function telegramButtonRows(buttons, columns = 2) {
  const rows = [];
  for (let index = 0; index < buttons.length; index += columns) {
    rows.push(buttons.slice(index, index + columns));
  }
  return rows;
}

function telegramButtonVerticalColumns(buttons) {
  const rowCount = Math.ceil(buttons.length / 2);
  return Array.from({ length: rowCount }, (_, index) => [
    buttons[index],
    buttons[index + rowCount]
  ].filter(Boolean));
}

function telegramStackDisplayName(stack) {
  const name = String(stack || '');
  return name ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : name;
}

function getTelegramServers() {
  const updates = readUpdatesFile();
  const hasLoggedAgents = updates.some(item =>
    String(item.endpoint || 'Actual').toLowerCase() !== 'actual' && item.loggedIn === true
  );
  const servers = updates
    .filter(item => {
      const endpoint = String(item.endpoint || 'Actual');
      if (endpoint.toLowerCase() === 'actual') return true;
      return hasLoggedAgents ? item.loggedIn === true : true;
    })
    .map(item => ({
      endpoint: String(item.endpoint || 'Actual'),
      name: String(item.hostname || item.endpoint || 'Actual')
    }));

  if (!servers.some(server => server.endpoint.toLowerCase() === 'actual')) {
    servers.unshift({ endpoint: 'Actual', name: process.env.HOSTNAME || 'Servidor actual' });
  }

  const seen = new Set();
  return servers.filter(server => {
    const key = server.endpoint.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getTelegramPendingUpdates() {
  const pending = [];
  for (const server of readUpdatesFile()) {
    const endpoint = String(server.endpoint || 'Actual');
    const hostname = String(server.hostname || endpoint);
    for (const update of (Array.isArray(server.updates) ? server.updates : [])) {
      const stack = String(update.stack || '').trim();
      if (!stack || stack.toLowerCase() === 'dockme') continue;
      pending.push({
        endpoint,
        hostname,
        stack,
        dockers: Array.isArray(update.dockers) ? update.dockers.map(String) : []
      });
    }
  }
  return pending.sort((a, b) =>
    a.hostname.localeCompare(b.hostname, 'es', { sensitivity: 'base' }) ||
    a.stack.localeCompare(b.stack, 'es', { sensitivity: 'base' })
  );
}

function telegramUpdateKey(update) {
  return `${update.endpoint.toLowerCase()}|${update.stack.toLowerCase()}`;
}

function getTelegramStacks(endpoint) {
  const normalizedEndpoint = String(endpoint || 'Actual').toLowerCase();
  const names = readStacksFile()
    .filter(stack => String(stack.endpoint || 'Actual').toLowerCase() === normalizedEndpoint)
    .map(stack => String(stack.name || '').trim())
    .filter(Boolean);

  if (normalizedEndpoint === 'actual') {
    const stacksDir = process.env.DOCKGE_STACKS_DIR || '/opt/stacks';
    try {
      for (const entry of fs.readdirSync(stacksDir, { withFileTypes: true })) {
        if (entry.isDirectory()) names.push(entry.name);
      }
    } catch {}
  }

  return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
}

function telegramStatusFromComposeText(status) {
  const value = String(status || '').toLowerCase();
  if (value.startsWith('running') && !value.includes('exited')) return 'running';
  if (value.startsWith('created') || value.includes('exited')) return 'stopped';
  return 'unknown';
}

function telegramStatusFromContainers(containers) {
  if (!Array.isArray(containers) || containers.length === 0) return 'unknown';
  const states = containers.map(container => String(container.state || '').toLowerCase());
  const health = containers.map(container => String(container.health || '').toLowerCase());
  if (states.every(state => state === 'running') && health.some(value => value === 'starting')) return 'starting';
  if (states.every(state => state === 'running') && health.some(value => value === 'unhealthy')) return 'failed';
  if (states.every(state => state === 'running')) return 'running';
  if (states.some(state => state === 'running')) return 'partial';
  if (states.some(state => ['exited', 'stopped', 'created', 'dead'].includes(state))) return 'stopped';
  return 'unknown';
}

function telegramStackDetailsFromContainers(containers) {
  const list = Array.isArray(containers) ? containers : [];
  const isRunning = container => String(container.state || '').toLowerCase() === 'running';
  const isReady = container => {
    if (!isRunning(container)) return false;
    const health = String(container.health || '').toLowerCase();
    return health === '' || health === 'healthy';
  };
  return {
    status: telegramStatusFromContainers(list),
    running: list.filter(isRunning).length,
    ready: list.filter(isReady).length,
    total: list.length
  };
}

function runTelegramDockerComposeStatusList() {
  return new Promise(resolve => {
    const proc = spawn('docker', ['compose', 'ls', '--all', '--format', 'json']);
    let stdout = '';
    proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
    proc.on('error', () => resolve(new Map()));
    proc.on('close', code => {
      if (code !== 0) return resolve(new Map());
      try {
        const parsed = JSON.parse(stdout || '[]');
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        resolve(new Map(rows.map(row => [
          String(row.Name || '').toLowerCase(),
          telegramStatusFromComposeText(row.Status)
        ])));
      } catch {
        try {
          const rows = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
          resolve(new Map(rows.map(row => [
            String(row.Name || '').toLowerCase(),
            telegramStatusFromComposeText(row.Status)
          ])));
        } catch {
          resolve(new Map());
        }
      }
    });
  });
}

async function getTelegramStackStatuses(endpoint, stacks) {
  const normalizedEndpoint = String(endpoint || 'Actual').toLowerCase();
  if (normalizedEndpoint === 'actual') {
    const composeStatuses = await runTelegramDockerComposeStatusList();
    return new Map(stacks.map(stack => [stack, composeStatuses.get(stack.toLowerCase()) || 'unknown']));
  }

  const entries = await Promise.all(stacks.map(async stack => {
    try {
      const response = await fetch(
        `http://${endpoint}/api/stack-containers/${encodeURIComponent(stack)}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!response.ok) return [stack, 'unknown'];
      const data = await response.json();
      return [stack, telegramStatusFromContainers(data.containers)];
    } catch {
      return [stack, 'unknown'];
    }
  }));
  return new Map(entries);
}

async function getTelegramServerMetrics(endpoint) {
  const targetEndpoint = String(endpoint || 'Actual').toLowerCase() === 'actual'
    ? '127.0.0.1:5000'
    : endpoint;
  try {
    const response = await fetch(`http://${targetEndpoint}/metrics`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function telegramServerMetricsText(metrics) {
  if (!metrics) return '⚠️ Métricas no disponibles';
  const percent = value => {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? `${number < 10 ? number.toFixed(1) : Math.round(number)}%` : '—';
  };
  const temperature = Number.parseFloat(metrics.temp_cpu);
  const temperatureText = Number.isFinite(temperature) ? `${Math.round(temperature)}°C` : '—';
  const uptimeSeconds = Number(metrics.uptime_seconds);
  let uptimeText = '—';
  if (Number.isFinite(uptimeSeconds) && uptimeSeconds >= 0) {
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    uptimeText = days > 0
      ? `${days} ${days === 1 ? 'día' : 'días'}`
      : hours > 0 ? `${hours}h` : `${Math.max(1, minutes)} min`;
  }
  const lines = [`📊 RAM ${percent(metrics.memory)} · Temp. CPU ${temperatureText}`];
  if (String(metrics.ups || '').trim() && metrics.ups_state !== 'unknown') {
    lines.push(`🔋 SAI: ${String(metrics.ups).trim()}`);
  }
  lines.push(`⏱️ Activo: ${uptimeText}`);
  return lines.join('\n');
}

function telegramServerContainerCount(metrics) {
  if (!metrics) return '▶ — / ■ —';
  const running = Number(metrics.docker_running);
  const stopped = Number(metrics.docker_stopped);
  return `▶ ${Number.isFinite(running) ? running : '—'} / ■ ${Number.isFinite(stopped) ? stopped : '—'}`;
}

function telegramStackStatusIcon(status) {
  if (status === 'running') return '🟢';
  if (status === 'stopped') return '🔴';
  if (['partial', 'starting'].includes(status)) return '🟠';
  if (status === 'failed') return '❌';
  return '⚪';
}

function telegramStackStatusLabel(status) {
  if (status === 'running') return 'En funcionamiento';
  if (status === 'stopped') return 'Parado';
  if (status === 'partial') return 'Parcial';
  if (status === 'starting') return 'Iniciando';
  if (status === 'failed') return 'Con errores';
  return 'Inactivo';
}

function findTelegramComposeFile(stack) {
  const stackDir = path.join(process.env.DOCKGE_STACKS_DIR || '/opt/stacks', stack);
  for (const filename of ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']) {
    const composePath = path.join(stackDir, filename);
    if (fs.existsSync(composePath)) return composePath;
  }
  return null;
}

function runTelegramProcess(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} finalizó con código ${code}`));
    });
  });
}

async function runTelegramStackAction(endpoint, stack, action) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Acción no permitida');
  if (!getTelegramStacks(endpoint).includes(stack)) throw new Error('El stack ya no existe');
  if (stack.toLowerCase() === 'dockme') throw new Error('Dockme no puede gestionarse desde su propio bot');

  const normalizedEndpoint = String(endpoint || 'Actual').toLowerCase();
  addDockerEventExclusion(endpoint, stack, 'telegram-bot');

  if (normalizedEndpoint === 'actual') {
    const composePath = findTelegramComposeFile(stack);
    if (!composePath) throw new Error('No se encontró el archivo Compose');
    const args = ['compose', '-f', composePath];
    if (action === 'start') args.push('up', '-d', '--remove-orphans');
    else args.push(action);
    await runTelegramProcess('docker', args);
    return;
  }

  const containersResponse = await fetch(
    `http://${endpoint}/api/stack-containers/${encodeURIComponent(stack)}`,
    { signal: AbortSignal.timeout(8000) }
  );
  const containersData = await containersResponse.json().catch(() => ({}));
  if (!containersResponse.ok || !Array.isArray(containersData.containers) || containersData.containers.length === 0) {
    throw new Error(containersData.message || 'No se encontraron contenedores remotos');
  }

  for (const container of containersData.containers) {
    const response = await fetch(`http://${endpoint}/api/container-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: container.name, action }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.message || `No se pudo ejecutar ${action}`);
  }
}

async function getTelegramDetailedStackStatus(endpoint, stack) {
  const normalizedEndpoint = String(endpoint || 'Actual').toLowerCase();
  const baseUrl = normalizedEndpoint === 'actual' ? 'http://localhost:5002' : `http://${endpoint}`;
  try {
    const response = await fetch(`${baseUrl}/api/stack-containers/${encodeURIComponent(stack)}`, {
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return { status: 'unknown', running: 0, ready: 0, total: 0 };
    const data = await response.json();
    return telegramStackDetailsFromContainers(data.containers);
  } catch {
    return { status: 'unknown', running: 0, ready: 0, total: 0 };
  }
}

async function waitForTelegramStackAction(endpoint, stack, action, onProgress, timeoutMs = 90000) {
  const targetStatus = action === 'stop' ? 'stopped' : 'running';
  const startedAt = Date.now();
  let lastStatus = 'unknown';
  let stableMatches = 0;
  let failureMatches = 0;
  let lastDetails = { status: 'unknown', running: 0, ready: 0, total: 0 };

  while (Date.now() - startedAt < timeoutMs) {
    lastDetails = await getTelegramDetailedStackStatus(endpoint, stack);
    lastStatus = lastDetails.status;
    if (onProgress) await onProgress(lastDetails);
    if (lastStatus === targetStatus) {
      stableMatches += 1;
      if (stableMatches >= 2) return { success: true, status: lastStatus, details: lastDetails };
    } else {
      stableMatches = 0;
    }
    if (action !== 'stop' && lastStatus === 'stopped') {
      failureMatches += 1;
      if (failureMatches >= 3) {
        return { success: false, status: lastStatus, details: lastDetails, message: 'los contenedores se han detenido durante el arranque' };
      }
    } else {
      failureMatches = 0;
    }
    if (action !== 'stop' && lastStatus === 'failed') {
      return { success: false, status: lastStatus, details: lastDetails, message: 'uno o más contenedores están unhealthy' };
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  return {
    success: false,
    status: lastStatus,
    details: lastDetails,
    timedOut: true,
    message: `el stack continúa en estado ${telegramStackStatusLabel(lastStatus).toLowerCase()}`
  };
}

function telegramStackActionProgressText(session, stack, action, details) {
  const labels = {
    start: { verb: 'Iniciando', icon: '▶️' },
    stop: { verb: 'Deteniendo', icon: '⏹️' },
    restart: { verb: 'Reiniciando', icon: '🔄' }
  };
  let current = labels[action];
  let completed = action === 'stop' ? Math.max(0, details.total - details.running) : (details.ready ?? details.running);
  if (action === 'restart') {
    if (details.running < details.total) {
      current = labels.stop;
      completed = Math.max(0, details.total - details.running);
    } else if ((details.ready ?? details.running) < details.total) {
      current = labels.start;
      completed = details.ready ?? details.running;
    }
  }
  const services = details.total > 0
    ? ` ${completed} de ${details.total} ${details.total === 1 ? 'servicio' : 'servicios'}`
    : '';
  return `📦 ${telegramStackDisplayName(stack)}\n🖥️ ${session.selectedServer.name}\n\n🟠 Estado: ${current.verb}${services}\n\n${current.icon} ${current.verb} stack…`;
}

function createTelegramSession(chatId) {
  const session = {
    servers: getTelegramServers(),
    selectedServer: null,
    stacks: [],
    messageId: getTelegramBotMessageId(chatId)
  };
  telegramBotSessions.set(String(chatId), session);
  return session;
}

function setTelegramSessionMessageId(session, chatId, messageId) {
  session.messageId = messageId;
  saveTelegramBotMessageId(chatId, messageId);
}

async function moveTelegramMenuToBottom(token, chatId, callbackMessage) {
  if (!callbackMessage?.message_id || !callbackMessage?.text) return callbackMessage;
  try {
    const sentMessage = await telegramApi(token, 'sendMessage', {
      chat_id: chatId,
      text: callbackMessage.text,
      ...(callbackMessage.reply_markup ? { reply_markup: callbackMessage.reply_markup } : {})
    });
    await telegramApi(token, 'deleteMessage', {
      chat_id: chatId,
      message_id: callbackMessage.message_id
    }).catch(err => console.warn(`⚠️ [Telegram] No se pudo borrar el menú anterior: ${err.message}`));
    saveTelegramBotMessageId(chatId, sentMessage.message_id);
    return sentMessage;
  } catch (err) {
    console.warn(`⚠️ [Telegram] No se pudo mover el menú al final: ${err.message}`);
    return callbackMessage;
  }
}

function telegramServersView(session) {
  const buttons = session.servers.map((server, index) => ({
    text: `🖥️ ${server.name}`,
    callback_data: `dm:s:${index}`
  }));
  const pendingCount = getTelegramPendingUpdates().length;
  if (pendingCount > 0) buttons.push({
    text: `⬆️ Actualizaciones pendientes (${pendingCount})`,
    callback_data: 'dm:updates'
  });
  buttons.push({ text: '📊 Métricas de servidores', callback_data: 'dm:metrics' });
  return {
    text: '🐋 Dockme\n\nSelecciona un servidor:',
    reply_markup: { inline_keyboard: telegramButtonRows(buttons, 1) }
  };
}

async function selectTelegramServer(session, index) {
  const server = session.servers[index];
  if (!server) return null;
  session.selectedServer = server;
  session.stacks = getTelegramStacks(server.endpoint);
  session.stackStatuses = await getTelegramStackStatuses(server.endpoint, session.stacks);
  return server;
}

function telegramStacksView(session) {
  const server = session.selectedServer;
  const manageableStacks = session.stacks
    .map((stack, index) => ({ stack, index }))
    .filter(item => item.stack.toLowerCase() !== 'dockme');
  const activeStacks = manageableStacks
    .filter(item => session.stackStatuses?.get(item.stack) !== 'unknown');
  const inactiveCount = manageableStacks.length - activeStacks.length;
  const buttons = activeStacks.map(({ stack, index }) => ({
    text: `${telegramStackStatusIcon(session.stackStatuses?.get(stack))} ${telegramStackDisplayName(stack)}`,
    callback_data: `dm:k:${index}`
  }));
  const rows = telegramButtonVerticalColumns(buttons);
  if (inactiveCount > 0) {
    rows.push([{
      text: `⚪ Stacks inactivos (${inactiveCount})`,
      callback_data: 'dm:inactive'
    }]);
  }
  const pendingCount = getTelegramPendingUpdates().length;
  if (pendingCount > 0) {
    rows.push([{
      text: `⬆️ Actualizaciones pendientes (${pendingCount})`,
      callback_data: 'dm:updates'
    }]);
  }
  if (session.servers.length > 1) {
    rows.push([{ text: '⬅️ Servidores', callback_data: 'dm:servers' }]);
  }
  return {
    text: buttons.length > 0
      ? `🖥️ ${server.name}\n\nSelecciona un stack para consultar su estado y las acciones disponibles:`
      : `🖥️ ${server.name}\n\nNo hay stacks activos o parados.`,
    reply_markup: { inline_keyboard: rows }
  };
}

async function telegramMetricsView(session) {
  session.servers = getTelegramServers();
  const results = await Promise.all(session.servers.map(async server => ({
    server,
    metrics: await getTelegramServerMetrics(server.endpoint)
  })));
  const maxNameLength = Math.max(0, ...results.map(({ server }) => String(server.name).length));
  const blocks = results.map(({ server, metrics }) => {
    const paddedName = String(server.name).padEnd(maxNameLength, '\u2007');
    return `🖥️ ${paddedName}\u2007\u2007\u2007${telegramServerContainerCount(metrics)}\n${telegramServerMetricsText(metrics)}`;
  });
  return {
    text: `📊 Métricas de servidores\n\n${blocks.join('\n\n')}`,
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Actualizar', callback_data: 'dm:metrics' }],
        [{ text: '⬅️ Volver', callback_data: 'dm:home' }]
      ]
    }
  };
}

function refreshTelegramUpdatesSession(session) {
  const previous = session.selectedUpdates || new Set();
  session.updates = getTelegramPendingUpdates();
  const validKeys = new Set(session.updates.map(telegramUpdateKey));
  session.selectedUpdates = new Set([...previous].filter(key => validKeys.has(key)));
}

function telegramUpdatesView(session) {
  refreshTelegramUpdatesSession(session);
  const buttons = session.updates.map((update, index) => {
    const selected = session.selectedUpdates.has(telegramUpdateKey(update));
    return {
      text: `${selected ? '✅' : '⬜'} ${telegramStackDisplayName(update.stack)} — ${update.hostname}`,
      callback_data: `dm:u:${index}`
    };
  });
  const rows = telegramButtonRows(buttons, 1);
  if (session.selectedUpdates.size > 0) {
    rows.push([{
      text: `🚀 Comenzar actualizaciones (${session.selectedUpdates.size})`,
      callback_data: 'dm:urun'
    }]);
  }
  rows.push([{ text: '⬅️ Volver', callback_data: 'dm:home' }]);
  return {
    text: session.updates.length > 0
      ? '⬆️ Actualizaciones pendientes\n\n⚠️ Actualizar servicios de forma remota conlleva cierto riesgo. Para contenedores críticos se recomienda realizar la actualización desde el panel web de Dockme.\n\nSelecciona los stacks que quieres actualizar:'
      : '✅ No hay actualizaciones pendientes.',
    reply_markup: { inline_keyboard: rows }
  };
}

function removeTelegramPendingUpdate(update) {
  const data = readUpdatesFile();
  const host = data.find(item =>
    String(item.endpoint || 'Actual').toLowerCase() === update.endpoint.toLowerCase()
  );
  if (!host || !Array.isArray(host.updates)) return;
  host.updates = host.updates.filter(item => String(item.stack || '').toLowerCase() !== update.stack.toLowerCase());
  writeUpdatesFile(data);
}

function telegramUpdateQueueText(items, currentIndex, progress = '') {
  const lines = items.map((item, index) => {
    const icon = item.result === 'success' ? '✅'
      : item.result === 'warning' ? '⚠️'
        : item.result === 'error' ? '❌'
          : index === currentIndex ? '🔄' : '⬜';
    return `${icon} ${telegramStackDisplayName(item.stack)} — ${item.hostname}`;
  });
  const currentItem = items[currentIndex];
  const currentStack = progress && currentItem && !currentItem.result
    ? `\n\n📦 Stack actual: ${telegramStackDisplayName(currentItem.stack)} — ${currentItem.hostname}`
    : '';
  return `⬆️ Actualizaciones (${Math.min(currentIndex + 1, items.length)}/${items.length})\n\n${lines.join('\n')}${currentStack}${progress ? `\n${progress}` : ''}`;
}

async function editTelegramUpdateQueue(token, chatId, messageId, items, currentIndex, progress = '', replyMarkup) {
  await telegramApi(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: telegramUpdateQueueText(items, currentIndex, progress),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function requestDockmeStackUpdate(update) {
  const dockgeToken = getTelegramDockgeToken();
  if (!dockgeToken) {
    throw new Error('Falta la sesión de Dockme. Vuelve a pulsar “Probar bot” en Ajustes');
  }
  const endpoint = String(update.endpoint || 'Actual').toLowerCase() === 'actual'
    ? ''
    : String(update.endpoint);

  await new Promise((resolve, reject) => {
    const client = io('http://127.0.0.1:5001', {
      reconnection: false,
      timeout: 10000
    });
    const timer = setTimeout(() => {
      finish(new Error('La actualización superó el límite de 3 minutos'));
    }, 3 * 60 * 1000);
    let finished = false;
    let updateSent = false;
    let authenticated = false;
    let agentReadyTimer = null;
    const agentStatuses = new Map();
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (agentReadyTimer) clearTimeout(agentReadyTimer);
      client.disconnect();
      error ? reject(error) : resolve();
    };

    const sendUpdate = () => {
      if (finished || updateSent) return;
      updateSent = true;
      // Mismo evento, endpoint y callback utilizados por BulkUpdatePanel en custom.js.
      client.emit('agent', endpoint, 'updateStack', update.stack, result => {
        if (!result?.ok) return finish(new Error(String(result?.msg || 'Actualización fallida')));
        finish();
      });
    };

    client.on('connect_error', finish);
    client.on('agentStatus', status => {
      const statusEndpoint = String(status?.endpoint || '');
      const state = String(status?.status || '').toLowerCase();
      if (!statusEndpoint) return;
      agentStatuses.set(statusEndpoint.toLowerCase(), state);
      if (endpoint && statusEndpoint.toLowerCase() === endpoint.toLowerCase()) {
        if (state === 'online' && authenticated) sendUpdate();
        else if (state === 'offline' && authenticated) finish(new Error(`El servidor ${update.hostname || endpoint} no está disponible`));
      }
    });
    client.on('connect', () => {
      client.emit('loginByToken', dockgeToken, loginResult => {
        if (!loginResult?.ok) {
          return finish(new Error('La sesión de Dockme ha caducado. Vuelve a pulsar “Probar bot”'));
        }
        authenticated = true;
        if (!endpoint) return sendUpdate();

        // afterLogin inicia connectAll() sin esperarlo. Para agentes remotos hay que
        // aguardar su agentStatus antes de usar el mismo proxy que utiliza la UI.
        const knownStatus = agentStatuses.get(endpoint.toLowerCase());
        if (knownStatus === 'online') sendUpdate();
        else if (knownStatus === 'offline') finish(new Error(`El servidor ${update.hostname || endpoint} no está disponible`));
        else {
          agentReadyTimer = setTimeout(() => {
            finish(new Error(`No se pudo conectar con ${update.hostname || endpoint}`));
          }, 30000);
        }
      });
    });
  });
}

async function runTelegramUpdateQueue(token, chatId, messageId, selectedUpdates) {
  const items = selectedUpdates.map(update => ({ ...update, result: null }));
  telegramBotUpdateQueueRunning = true;

  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const lockKey = `${item.endpoint.toLowerCase()}|${item.stack.toLowerCase()}`;
      if (telegramBotActionLocks.has(lockKey)) {
        item.result = 'error';
        item.message = 'Hay otra acción en curso';
        continue;
      }

      telegramBotActionLocks.add(lockKey);
      addDockerEventExclusion(item.endpoint, item.stack, 'telegram-update');
      let timer = null;
      try {
        const before = await getTelegramDetailedStackStatus(item.endpoint, item.stack);
        const wasRunning = ['running', 'starting', 'partial', 'failed'].includes(before.status);
        let seconds = 0;
        await editTelegramUpdateQueue(token, chatId, messageId, items, index, '⬇️ Descargando imágenes y actualizando stack…');
        timer = setInterval(() => {
          seconds += 3;
          editTelegramUpdateQueue(
            token, chatId, messageId, items, index,
            `⬇️ Descargando imágenes y actualizando stack… ${seconds}s`
          ).catch(() => {});
        }, 3000);
        await requestDockmeStackUpdate(item);
        clearInterval(timer);
        timer = null;
        removeTelegramPendingUpdate(item);

        if (wasRunning) {
          const result = await waitForTelegramStackAction(
            item.endpoint,
            item.stack,
            'restart',
            details => editTelegramUpdateQueue(
              token, chatId, messageId, items, index,
              `🟠 Iniciando ${details.ready ?? details.running} de ${details.total} ${details.total === 1 ? 'servicio' : 'servicios'}…`
            ).catch(() => {})
          );
          item.result = result.success ? 'success' : 'warning';
          item.message = result.success ? '' : result.message;
        } else {
          item.result = 'success';
        }
      } catch (error) {
        if (timer) clearInterval(timer);
        item.result = 'error';
        item.message = String(error instanceof Error ? error.message : error).slice(0, 300);
      } finally {
        telegramBotActionLocks.delete(lockKey);
      }
    }
  } finally {
    telegramBotUpdateQueueRunning = false;
  }

  const successes = items.filter(item => item.result === 'success').length;
  const warnings = items.filter(item => item.result === 'warning').length;
  const errors = items.filter(item => item.result === 'error').length;
  const successText = `${successes} ${successes === 1 ? 'correcta' : 'correctas'}`;
  const warningText = warnings ? `, ${warnings} con ${warnings === 1 ? 'aviso' : 'avisos'}` : '';
  const errorText = errors ? `, ${errors} con ${errors === 1 ? 'error' : 'errores'}` : '';
  const summary = `Finalizado: ${successText}${warningText}${errorText}.`;
  const pendingCount = getTelegramPendingUpdates().length;
  const finalButtons = [];
  if (pendingCount > 0) {
    finalButtons.push({ text: `⬆️ Pendientes (${pendingCount})`, callback_data: 'dm:updates' });
  }
  finalButtons.push({ text: '🏠 Menú', callback_data: 'dm:home' });
  await editTelegramUpdateQueue(token, chatId, messageId, items, items.length - 1, summary, {
    inline_keyboard: [finalButtons]
  });
}

function telegramInactiveStacksView(session) {
  const buttons = session.stacks
    .map((stack, index) => ({ stack, index }))
    .filter(item => item.stack.toLowerCase() !== 'dockme')
    .filter(item => session.stackStatuses?.get(item.stack) === 'unknown')
    .map(({ stack, index }) => ({
      text: `⚪ ${telegramStackDisplayName(stack)}`,
      callback_data: `dm:k:${index}`
    }));
  const rows = telegramButtonVerticalColumns(buttons);
  rows.push([{ text: '⬅️ Stacks', callback_data: 'dm:stacks' }]);
  return {
    text: `🖥️ ${session.selectedServer.name}\n\nStacks inactivos:`,
    reply_markup: { inline_keyboard: rows }
  };
}

function telegramStackView(session, stack, notice = '') {
  const status = session.stackStatuses?.get(stack) || 'unknown';
  const details = session.stackDetails?.get(stack);
  const isInactive = status === 'unknown';
  const isProtected = stack.toLowerCase() === 'dockme';
  const rows = [];
  if (!isProtected && status === 'stopped') {
    rows.push([{ text: '▶️ Iniciar', callback_data: `dm:a:start:${session.stacks.indexOf(stack)}` }]);
  } else if (!isProtected && ['running', 'partial', 'failed'].includes(status)) {
    rows.push([
      { text: '⏹️ Detener', callback_data: `dm:a:stop:${session.stacks.indexOf(stack)}` },
      { text: '🔄 Reiniciar', callback_data: `dm:a:restart:${session.stacks.indexOf(stack)}` }
    ]);
  }
  rows.push([
    { text: '⬅️ Stacks', callback_data: isInactive ? 'dm:inactive' : 'dm:stacks' },
    { text: '🏠 Menú', callback_data: 'dm:home' }
  ]);
  const protectionText = isProtected ? '\n\n🔒 Dockme no puede gestionarse desde su propio bot.' : '';
  const noticeText = notice ? `\n\n${notice}` : '';
  const displayedServices = status === 'starting' ? (details?.ready ?? details?.running) : details?.running;
  const servicesText = details?.total > 0
    ? ` ${displayedServices} de ${details.total} ${details.total === 1 ? 'servicio' : 'servicios'}`
    : '';
  const statusText = status === 'stopped' && details?.total > 0
    ? `${details.total} ${details.total === 1 ? 'servicio detenido' : 'servicios detenidos'}`
    : `${telegramStackStatusLabel(status)}${servicesText}`;
  return {
    text: `📦 ${telegramStackDisplayName(stack)}\n🖥️ ${session.selectedServer.name}\n\n${telegramStackStatusIcon(status)} Estado: ${statusText}${protectionText}${noticeText}`,
    reply_markup: { inline_keyboard: rows }
  };
}

async function showTelegramHome(token, chatId, callbackMessage, commandMessageId, forceNew = false) {
  const previousSession = telegramBotSessions.get(String(chatId));
  const session = createTelegramSession(chatId);
  let view;
  if (session.servers.length === 1) {
    await selectTelegramServer(session, 0);
    view = telegramStacksView(session);
  } else {
    view = telegramServersView(session);
  }

  const activeMessageId = callbackMessage?.message_id || previousSession?.messageId || session.messageId;
  if (forceNew) {
    const sentMessage = await telegramApi(token, 'sendMessage', { chat_id: chatId, ...view });
    setTelegramSessionMessageId(session, chatId, sentMessage.message_id);
    if (activeMessageId && activeMessageId !== commandMessageId && activeMessageId !== sentMessage.message_id) {
      await telegramApi(token, 'deleteMessage', {
        chat_id: chatId,
        message_id: activeMessageId
      }).catch(() => {});
    }
    if (commandMessageId) {
      await telegramApi(token, 'deleteMessage', {
        chat_id: chatId,
        message_id: commandMessageId
      }).catch(() => {});
    }
    return;
  }

  if (activeMessageId) {
    try {
      await telegramApi(token, 'editMessageText', {
        chat_id: chatId,
        message_id: activeMessageId,
        ...view
      });
      setTelegramSessionMessageId(session, chatId, activeMessageId);
    } catch (error) {
      if (String(error.message || '').toLowerCase().includes('message is not modified')) {
        setTelegramSessionMessageId(session, chatId, activeMessageId);
      } else {
        const sentMessage = await telegramApi(token, 'sendMessage', { chat_id: chatId, ...view });
        setTelegramSessionMessageId(session, chatId, sentMessage.message_id);
      }
    }
  } else {
    const sentMessage = await telegramApi(token, 'sendMessage', { chat_id: chatId, ...view });
    setTelegramSessionMessageId(session, chatId, sentMessage.message_id);
  }

}

async function refreshTelegramBotMenus() {
  const config = readSettingsFile().telegramBot || {};
  const token = String(config.token || '').trim();
  const chatIds = normalizeTelegramChatIds(config.authorizedChatIds);
  if (!config.enabled || !token || chatIds.size === 0 || IS_AGENT) return;
  if (telegramBotActionLocks.size > 0 || telegramBotUpdateQueueRunning) {
    console.log('⏸️ [Telegram] Menú no actualizado porque hay una acción en curso');
    return;
  }

  await Promise.allSettled([...chatIds].map(async chatId => {
    const messageId = getTelegramBotMessageId(chatId);
    if (!messageId) return;
    const session = createTelegramSession(chatId);
    let view;
    if (session.servers.length === 1) {
      await selectTelegramServer(session, 0);
      view = telegramStacksView(session);
    } else {
      view = telegramServersView(session);
    }
    try {
      await telegramApi(token, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        ...view
      });
      setTelegramSessionMessageId(session, chatId, messageId);
    } catch (err) {
      if (!String(err.message || '').toLowerCase().includes('message is not modified')) {
        console.warn(`⚠️ [Telegram] No se pudo refrescar el menú del chat ${chatId}: ${err.message}`);
      }
    }
  }));
}

function scheduleTelegramMenuReset(chatId) {
  const key = String(chatId);
  const previousTimer = telegramBotMenuResetTimers.get(key);
  if (previousTimer) clearTimeout(previousTimer);
  const timer = setTimeout(async () => {
    telegramBotMenuResetTimers.delete(key);
    if (telegramBotActionLocks.size > 0 || telegramBotUpdateQueueRunning) {
      scheduleTelegramMenuReset(chatId);
      return;
    }

    const config = readSettingsFile().telegramBot || {};
    const token = String(config.token || '').trim();
    if (!config.enabled || !token || !normalizeTelegramChatIds(config.authorizedChatIds).has(key)) return;
    const messageId = getTelegramBotMessageId(chatId);
    if (!messageId) return;

    const session = createTelegramSession(chatId);
    let view;
    if (session.servers.length === 1) {
      await selectTelegramServer(session, 0);
      view = telegramStacksView(session);
    } else {
      view = telegramServersView(session);
    }
    try {
      await telegramApi(token, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        ...view
      });
      setTelegramSessionMessageId(session, chatId, messageId);
    } catch (err) {
      if (!String(err.message || '').toLowerCase().includes('message is not modified')) {
        console.warn(`⚠️ [Telegram] No se pudo volver al menú principal: ${err.message}`);
      }
    }
  }, TELEGRAM_MENU_RESET_MS);
  telegramBotMenuResetTimers.set(key, timer);
}

async function handleTelegramUpdate(token, authorizedChatIds, update) {
  const message = update?.message;
  const callback = update?.callback_query;
  const chatId = message?.chat?.id ?? callback?.message?.chat?.id;
  const currentConfig = readSettingsFile().telegramBot || {};
  const currentAuthorizedChatIds = normalizeTelegramChatIds(currentConfig.authorizedChatIds);
  if (!currentConfig.enabled || String(currentConfig.token || '').trim() !== token) return;
  if (chatId === undefined || !authorizedChatIds.has(String(chatId)) || !currentAuthorizedChatIds.has(String(chatId))) return;

  if (message) {
    const command = String(message.text || '').trim().split(/\s+/)[0].split('@')[0].toLowerCase();
    if (command !== '/start' && command !== '/menu') return;
    await showTelegramHome(token, chatId, null, command === '/menu' ? message.message_id : null, true);
    scheduleTelegramMenuReset(chatId);
    return;
  }

  if (!callback || !String(callback.data || '').startsWith('dm:')) return;

  // Al marcar/desmarcar varias actualizaciones se edita la tarjeta en su sitio.
  // Recrearla en cada pulsación provoca parpadeos y saltos visuales en Telegram.
  const isUpdateSelection = /^dm:u:\d+$/.test(String(callback.data));
  if (!isUpdateSelection) {
    callback.message = await moveTelegramMenuToBottom(token, chatId, callback.message);
  }
  scheduleTelegramMenuReset(chatId);

  let session = telegramBotSessions.get(String(chatId));
  if (session) session.messageId = callback.message.message_id;
  if (!session || callback.data === 'dm:home') {
    await telegramApi(token, 'answerCallbackQuery', { callback_query_id: callback.id });
    await showTelegramHome(token, chatId, callback.message);
    return;
  }

  let view = null;
  const serverMatch = callback.data.match(/^dm:s:(\d+)$/);
  const stackMatch = callback.data.match(/^dm:k:(\d+)$/);
  const updateMatch = callback.data.match(/^dm:u:(\d+)$/);
  const actionMatch = callback.data.match(/^dm:a:(start|stop|restart):(\d+)$/);
  if (callback.data === 'dm:metrics') {
    await telegramApi(token, 'answerCallbackQuery', { callback_query_id: callback.id });
    await telegramApi(token, 'editMessageText', {
      chat_id: chatId,
      message_id: callback.message.message_id,
      ...(await telegramMetricsView(session))
    });
    return;
  }
  if (callback.data === 'dm:updates') {
    await telegramApi(token, 'answerCallbackQuery', { callback_query_id: callback.id });
    await telegramApi(token, 'editMessageText', {
      chat_id: chatId,
      message_id: callback.message.message_id,
      ...telegramUpdatesView(session)
    });
    return;
  }

  if (updateMatch) {
    const update = session.updates?.[Number(updateMatch[1])];
    const stillPending = update && getTelegramPendingUpdates().some(item =>
      telegramUpdateKey(item) === telegramUpdateKey(update)
    );
    if (!stillPending) {
      await telegramApi(token, 'answerCallbackQuery', {
        callback_query_id: callback.id,
        text: 'Esta actualización ya no está pendiente.',
        show_alert: true
      });
      return;
    }
    const key = telegramUpdateKey(update);
    if (session.selectedUpdates.has(key)) session.selectedUpdates.delete(key);
    else session.selectedUpdates.add(key);
    await telegramApi(token, 'answerCallbackQuery', { callback_query_id: callback.id });
    await telegramApi(token, 'editMessageText', {
      chat_id: chatId,
      message_id: callback.message.message_id,
      ...telegramUpdatesView(session)
    });
    return;
  }

  if (callback.data === 'dm:urun') {
    refreshTelegramUpdatesSession(session);
    const selected = session.updates.filter(update => session.selectedUpdates.has(telegramUpdateKey(update)));
    if (telegramBotUpdateQueueRunning || selected.length === 0) {
      await telegramApi(token, 'answerCallbackQuery', {
        callback_query_id: callback.id,
        text: telegramBotUpdateQueueRunning ? 'Ya hay una cola de actualizaciones en curso.' : 'No hay stacks seleccionados.',
        show_alert: true
      });
      return;
    }
    await telegramApi(token, 'answerCallbackQuery', {
      callback_query_id: callback.id,
      text: `Iniciando ${selected.length} actualización(es)…`
    });
    await runTelegramUpdateQueue(token, chatId, callback.message.message_id, selected);
    return;
  }

  if (actionMatch && session.selectedServer) {
    const action = actionMatch[1];
    const stack = session.stacks[Number(actionMatch[2])];
    const endpoint = session.selectedServer.endpoint;
    const lockKey = `${String(endpoint).toLowerCase()}|${String(stack || '').toLowerCase()}`;
    if (!stack || !getTelegramStacks(endpoint).includes(stack)) {
      await telegramApi(token, 'answerCallbackQuery', {
        callback_query_id: callback.id,
        text: 'El stack ya no está disponible.',
        show_alert: true
      });
      return;
    }
    if (telegramBotActionLocks.has(lockKey)) {
      await telegramApi(token, 'answerCallbackQuery', {
        callback_query_id: callback.id,
        text: 'Ya hay una acción en curso para este stack.'
      });
      return;
    }

    session.stackStatuses = await getTelegramStackStatuses(endpoint, session.stacks);
    const currentStatus = session.stackStatuses.get(stack) || 'unknown';
    const allowed = (action === 'start' && currentStatus === 'stopped') ||
      (['stop', 'restart'].includes(action) && ['running', 'partial', 'failed'].includes(currentStatus));
    if (!allowed || stack.toLowerCase() === 'dockme') {
      await telegramApi(token, 'answerCallbackQuery', {
        callback_query_id: callback.id,
        text: 'La acción ya no está disponible para el estado actual.',
        show_alert: true
      });
      return;
    }

    telegramBotActionLocks.add(lockKey);
    await telegramApi(token, 'answerCallbackQuery', {
      callback_query_id: callback.id,
      text: 'Procesando…'
    });
    const initialDetails = await getTelegramDetailedStackStatus(endpoint, stack);
    const initialProgressText = telegramStackActionProgressText(session, stack, action, initialDetails);
    await telegramApi(token, 'editMessageText', {
      chat_id: chatId,
      message_id: callback.message.message_id,
      text: initialProgressText
    });

    let notice;
    let observedStatus = null;
    let observedDetails = null;
    let lastProgressText = initialProgressText;
    const updateProgress = async details => {
      const progressText = telegramStackActionProgressText(session, stack, action, details);
      if (progressText === lastProgressText) return;
      lastProgressText = progressText;
      await telegramApi(token, 'editMessageText', {
        chat_id: chatId,
        message_id: callback.message.message_id,
        text: progressText
      }).catch(err => console.warn(`⚠️ [Telegram] No se pudo actualizar el progreso: ${err.message}`));
    };
    let actionRunning = true;
    const actionMonitor = (async () => {
      while (actionRunning) {
        const details = await getTelegramDetailedStackStatus(endpoint, stack);
        await updateProgress(details);
        if (actionRunning) await new Promise(resolve => setTimeout(resolve, 1000));
      }
    })();
    try {
      try {
        await runTelegramStackAction(endpoint, stack, action);
      } finally {
        actionRunning = false;
        await actionMonitor;
      }
      const result = await waitForTelegramStackAction(endpoint, stack, action, updateProgress);
      observedStatus = result.status;
      observedDetails = result.details;
      if (result.success) {
        const labels = { start: 'iniciado', stop: 'detenido', restart: 'reiniciado' };
        notice = `✅ Stack ${labels[action]} correctamente.`;
        console.log(`🤖 [Telegram] ${action} ${stack} en ${endpoint}`);
      } else if (result.timedOut) {
        notice = `⚠️ Acción enviada, pero ${result.message}.`;
        console.warn(`⚠️ [Telegram] Timeout esperando ${action} de ${stack} en ${endpoint}: ${result.status}`);
      } else {
        notice = `❌ La acción terminó con problemas: ${result.message}.`;
        console.warn(`⚠️ [Telegram] Estado incorrecto tras ${action} de ${stack} en ${endpoint}: ${result.status}`);
      }
    } catch (err) {
      actionRunning = false;
      notice = `❌ No se pudo completar la acción: ${String(err.message || err).slice(0, 500)}`;
      console.warn(`⚠️ [Telegram] ${action} ${stack} en ${endpoint}: ${err.message}`);
    } finally {
      telegramBotActionLocks.delete(lockKey);
    }

    session.stackStatuses = await getTelegramStackStatuses(endpoint, session.stacks);
    if (observedStatus) session.stackStatuses.set(stack, observedStatus);
    if (observedDetails) {
      if (!session.stackDetails) session.stackDetails = new Map();
      session.stackDetails.set(stack, observedDetails);
    }
    await telegramApi(token, 'editMessageText', {
      chat_id: chatId,
      message_id: callback.message.message_id,
      ...telegramStackView(session, stack, notice)
    });
    return;
  }

  if (serverMatch) {
    const selected = session.servers[Number(serverMatch[1])];
    const stillExists = selected && getTelegramServers().some(server =>
      server.endpoint.toLowerCase() === selected.endpoint.toLowerCase()
    );
    if (stillExists && await selectTelegramServer(session, Number(serverMatch[1]))) view = telegramStacksView(session);
  } else if (stackMatch) {
    const stack = session.stacks[Number(stackMatch[1])];
    if (stack && getTelegramStacks(session.selectedServer.endpoint).includes(stack)) {
      const details = await getTelegramDetailedStackStatus(session.selectedServer.endpoint, stack);
      if (!session.stackDetails) session.stackDetails = new Map();
      session.stackDetails.set(stack, details);
      session.stackStatuses.set(stack, details.status);
      view = telegramStackView(session, stack);
    }
  } else if (callback.data === 'dm:servers') {
    session = createTelegramSession(chatId);
    view = telegramServersView(session);
  } else if (callback.data === 'dm:stacks' && session.selectedServer) {
    session.stacks = getTelegramStacks(session.selectedServer.endpoint);
    session.stackStatuses = await getTelegramStackStatuses(session.selectedServer.endpoint, session.stacks);
    view = telegramStacksView(session);
  } else if (callback.data === 'dm:inactive' && session.selectedServer) {
    session.stacks = getTelegramStacks(session.selectedServer.endpoint);
    session.stackStatuses = await getTelegramStackStatuses(session.selectedServer.endpoint, session.stacks);
    view = telegramInactiveStacksView(session);
  }

  if (!view) {
    await telegramApi(token, 'answerCallbackQuery', {
      callback_query_id: callback.id,
      text: 'Menú caducado. Usa /menu.',
      show_alert: true
    }).catch(() => {});
    return;
  }

  await telegramApi(token, 'answerCallbackQuery', { callback_query_id: callback.id });
  await telegramApi(token, 'editMessageText', {
    chat_id: chatId,
    message_id: callback.message.message_id,
    ...view
  });
}

async function runTelegramBot(generation, controller, config) {
  const token = String(config.token || '').trim();
  const authorizedChatIds = normalizeTelegramChatIds(config.authorizedChatIds);
  if (!config.enabled || !token || authorizedChatIds.size === 0 || IS_AGENT) return;

  let initDelay = 1000;
  while (!controller.signal.aborted && generation === telegramBotGeneration) {
    try {
      const initSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
      const bot = await telegramApi(token, 'getMe', {}, initSignal);
      // El bot anterior puede haber dejado callbacks pendientes; no deben reproducirse en Dockme.
      await telegramApi(token, 'deleteWebhook', { drop_pending_updates: true }, initSignal);
      const commands = [
        { command: 'menu', description: 'Mostrar menú de Dockme' }
      ];
      await telegramApi(token, 'setMyCommands', { commands }, initSignal);
      console.log(`🤖 [Telegram] Bot @${bot.username || bot.id} conectado (${authorizedChatIds.size} chat(s) autorizado(s))`);
      break;
    } catch (err) {
      if (controller.signal.aborted || generation !== telegramBotGeneration) return;
      console.warn(`⚠️ [Telegram] No se pudo iniciar el bot: ${err.message}; reintento en ${Math.ceil(initDelay / 1000)}s`);
      await new Promise(resolve => setTimeout(resolve, initDelay));
      initDelay = Math.min(initDelay * 2, 30000);
    }
  }

  let offset = 0;
  let errorDelay = 1000;
  let pollingHadErrors = false;
  while (!controller.signal.aborted && generation === telegramBotGeneration) {
    try {
      const pollingSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(40000)]);
      const updates = await telegramApi(token, 'getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query']
      }, pollingSignal);
      if (pollingHadErrors) {
        console.log('✅ [Telegram] Polling recuperado');
        pollingHadErrors = false;
      }
      errorDelay = 1000;
      for (const update of updates) {
        offset = Math.max(offset, Number(update.update_id) + 1);
        try {
          await handleTelegramUpdate(token, authorizedChatIds, update);
        } catch (err) {
          if (err.name !== 'AbortError') console.warn(`⚠️ [Telegram] Actualización ignorada: ${err.message}`);
        }
      }
    } catch (err) {
      if (controller.signal.aborted || generation !== telegramBotGeneration) break;
      pollingHadErrors = true;
      const waitMs = err.retryAfter > 0 ? err.retryAfter * 1000 : errorDelay;
      console.warn(`⚠️ [Telegram] Error de polling: ${err.message}; reintento en ${Math.ceil(waitMs / 1000)}s`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      errorDelay = Math.min(errorDelay * 2, 30000);
    }
  }
}

function restartTelegramBot() {
  telegramBotGeneration += 1;
  telegramBotController?.abort();
  telegramBotController = null;
  for (const timer of telegramBotMenuResetTimers.values()) clearTimeout(timer);
  telegramBotMenuResetTimers.clear();

  const config = readSettingsFile().telegramBot || {};
  if (!config.enabled || IS_AGENT) {
    if (config.enabled && IS_AGENT) console.log('🤖 [Telegram] Polling omitido en agente remoto');
    return;
  }

  telegramBotController = new AbortController();
  runTelegramBot(telegramBotGeneration, telegramBotController, config)
    .catch(err => console.error(`❌ [Telegram] Error inesperado: ${err.message}`));
}

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
        results.push({ hostname: serverAfter.hostname, endpoint: serverAfter.endpoint || 'Actual', stack: stackAfter.stack });
      } else {
        const newDockers = stackAfter.dockers.filter(d => !(stackBefore.dockers || []).includes(d));
        if (newDockers.length > 0) {
          results.push({ hostname: serverAfter.hostname, endpoint: serverAfter.endpoint || 'Actual', stack: stackAfter.stack });
        }
      }
    }
  }
  return results;
}

function isDockmeUpdate(update) {
  return String(update?.stack || '').toLowerCase() === 'dockme';
}

function getCentralDockmeUpdateEntry(updates = []) {
  const central = updates.find(h => String(h.endpoint || 'Actual').toLowerCase() === 'actual');
  return central?.updates?.find(update => isDockmeUpdate(update)) || null;
}

function dockmeUpdateNotificationKey(update) {
  if (!update) return '';
  const dockers = Array.isArray(update.dockers) ? [...update.dockers].sort().join(',') : '';
  return `dockme|${dockers || 'update'}`;
}

function capitalizeStackName(stack) {
  const name = String(stack || '').trim();
  if (!name) return '';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function formatSpanishList(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} y ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

function buildMessage(newUpdates, timedOut = []) {
  const uniqueStacks = [];
  const seenStacks = new Set();
  for (const item of newUpdates) {
    if (isDockmeUpdate(item)) continue;
    const stack = String(item.stack || '').trim();
    const key = stack.toLowerCase();
    if (!stack || seenStacks.has(key)) continue;
    seenStacks.add(key);
    uniqueStacks.push(capitalizeStackName(stack));
  }

  let msg = '';
  if (uniqueStacks.length > 0) {
    const stackList = formatSpanishList(uniqueStacks);
    const verb = uniqueStacks.length === 1 ? 'tiene' : 'tienen';
    msg += `🐋 ${stackList} ${verb} actualización`;
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

function buildDockmeUpdateMessage() {
  return [
    '🐋 Dockme tiene actualización',
    'https://github.com/fernandeusto/dockme/releases/latest'
  ].join('\n');
}

async function maybeNotifyCentralDockmeUpdate(snapshotAfter) {
  const settings = readSettingsFile();
  const dockmeUpdate = getCentralDockmeUpdateEntry(snapshotAfter);

  if (!dockmeUpdate) {
    if (settings.dockmeUpdateNotifiedKey) {
      delete settings.dockmeUpdateNotifiedKey;
      writeSettingsFile(settings);
    }
    return;
  }

  const key = dockmeUpdateNotificationKey(dockmeUpdate);
  if (settings.dockmeUpdateNotifiedKey === key) {
    console.log('📭 [Cycle] Actualización de Dockme central ya notificada');
    return;
  }

  console.log('📬 [Cycle] Enviando notificación de actualización de Dockme central');
  const sent = await sendNotification(buildDockmeUpdateMessage());
  if (!sent) {
    console.log('📭 [Cycle] No se marca Dockme como notificado porque no se pudo enviar');
    return;
  }
  settings.dockmeUpdateNotifiedKey = key;
  writeSettingsFile(settings);
}

async function sendNotification(message) {
  if (!message) return false;
  const settings = readSettingsFile();
  const notif = settings.notifications || {};
  const urls = Array.isArray(notif.urls) ? notif.urls.filter(Boolean) : [];
  if (urls.length === 0) {
    console.log('📵 [Notif] Sin URLs configuradas');
    return false;
  }
  let sent = false;
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
          else {
            sent = true;
            console.log(`✅ [Notif] Enviado a ${url.split('://')[0]}`);
          }
          resolve();
        }
      );
    });
  }
  return sent;
}

const dockerEventDedupe = new Map();
const dockerEventSuppressions = new Map();
const STACK_VIEW_EXCLUSION_MS = 5 * 60 * 1000;
let dockerEventReconnectTimer = null;

function dockerEventFilters() {
  return encodeURIComponent(JSON.stringify({
    type: ['container'],
    event: ['start', 'stop', 'die']
  }));
}

function dockerEventContainerName(event) {
  const attrs = event?.Actor?.Attributes || {};
  return attrs.name || event?.Actor?.ID?.slice(0, 12) || event?.id?.slice(0, 12) || 'desconocido';
}

function dockerEventStackName(event) {
  const attrs = event?.Actor?.Attributes || {};
  return attrs['com.docker.compose.project'] || attrs['com.docker.compose.service'] || attrs.name || '';
}

function dockerEventServiceName(event) {
  const attrs = event?.Actor?.Attributes || {};
  return attrs['com.docker.compose.service'] || '';
}

function dockerEventSuppressionKey(endpoint, stack) {
  return `${(endpoint || 'Actual').toLowerCase()}|${(stack || '').toLowerCase()}`;
}

function isDockmeInternalDockerEvent(event) {
  const names = [
    event?.stack,
    event?.service,
    event?.container,
    dockerEventStackName(event),
    dockerEventServiceName(event),
    dockerEventContainerName(event)
  ].filter(Boolean).map(value => String(value).toLowerCase());

  return names.some(name => name === 'dockme' || name === 'dockme-auto-update');
}

function addDockerEventExclusion(endpoint, stack, source = 'default') {
  const key = dockerEventSuppressionKey(endpoint, stack);
  const expiresAt = Date.now() + STACK_VIEW_EXCLUSION_MS;
  const entries = dockerEventSuppressions.get(key) || new Map();
  entries.set(source, expiresAt);
  dockerEventSuppressions.set(key, entries);
  return expiresAt;
}

function removeDockerEventExclusion(endpoint, stack, source = 'default') {
  const key = dockerEventSuppressionKey(endpoint, stack);
  const entries = dockerEventSuppressions.get(key);
  if (!entries) return null;
  entries.delete(source);
  if (entries.size === 0) dockerEventSuppressions.delete(key);
  return null;
}

function isDockerEventSuppressed(event) {
  const settings = readSettingsFile();
  if (settings.notifications?.excludeActiveStack === false) return false;

  const now = Date.now();
  for (const [key, entries] of dockerEventSuppressions) {
    for (const [source, expiresAt] of entries) {
      if (expiresAt <= now) entries.delete(source);
    }
    if (entries.size === 0) dockerEventSuppressions.delete(key);
  }

  const stack = event?.stack || dockerEventStackName(event);
  const endpoint = event?.endpoint || 'Actual';
  if (!stack) return false;
  const entries = dockerEventSuppressions.get(dockerEventSuppressionKey(endpoint, stack));
  return !!entries && [...entries.values()].some(expiresAt => expiresAt > now);
}

function dockerEventMessage(event) {
  const action = event?.Action || event?.status;
  const container = dockerEventContainerName(event);

  if (action === 'start') {
    return {
      state: 'started',
      text: `🟢 El contenedor ${container} se ha iniciado`
    };
  }

  if (action === 'stop' || action === 'die') {
    return {
      state: 'stopped',
      text: `🔴 El contenedor ${container} se ha detenido`
    };
  }

  return null;
}

function dockerEventHostname(endpoint, fallback = '') {
  const normalizedEndpoint = endpoint || 'Actual';
  const updates = readUpdatesFile();
  const host = updates.find(h =>
    (h.endpoint || 'Actual').toLowerCase() === normalizedEndpoint.toLowerCase()
  );
  return host?.hostname || fallback || normalizedEndpoint;
}

function normalizeDockerEvent(event) {
  const normalized = dockerEventMessage(event);
  if (!normalized) return null;

  const endpoint = process.env.ENDPOINT && process.env.ENDPOINT !== 'Actual'
    ? process.env.ENDPOINT
    : 'Actual';

  return {
    endpoint,
    hostname: process.env.HOSTNAME || '',
    stack: dockerEventStackName(event),
    service: dockerEventServiceName(event),
    container: dockerEventContainerName(event),
    action: event?.Action || event?.status,
    state: normalized.state,
    text: normalized.text,
    time: event?.time || Math.floor(Date.now() / 1000)
  };
}

function centralDockerEventUrl() {
  if (!IS_AGENT) return 'http://localhost:5002/api/docker-event';

  const central = process.env.CENTRAL_URL || process.env.WEBHOOK_URL || '';
  if (!central) return '';

  // Mismo criterio que check-updates.sh:
  // - URL legacy completa con /api/...: sustituir el endpoint final.
  // - URL con protocolo sin path: añadir /api/docker-event.
  // - Host:puerto sin protocolo: añadir http:// y /api/docker-event.
  if (/^https?:\/\/[^/]+\/.+/.test(central)) {
    const base = central.replace(/\/api\/.*$/, '').replace(/\/$/, '');
    return `${base}/api/docker-event`;
  }
  if (/^https?:\/\//.test(central)) {
    return `${central.replace(/\/$/, '')}/api/docker-event`;
  }
  return `http://${central.replace(/\/$/, '')}/api/docker-event`;
}

async function postDockerEventToCentral(event) {
  const url = centralDockerEventUrl();
  if (!url) {
    console.warn('⚠️ [Docker events] Sin central configurado para enviar evento');
    return;
  }

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000)
    });
  } catch (err) {
    console.warn(`⚠️ [Docker events] No se pudo enviar evento al central: ${err.message}`);
  }
}

async function handleDockerEvent(event) {
  const normalized = normalizeDockerEvent(event);
  if (!normalized) return;

  await postDockerEventToCentral(normalized);
}

async function processDockerEvent(event) {
  if (!event?.container || !event?.state) {
    return { success: false, message: 'Evento Docker inválido' };
  }

  const settings = readSettingsFile();
  if (settings.notifications?.dockerEvents === false) {
    console.log('📵 [Docker events] Notificaciones Docker desactivadas');
    return { success: true, ignored: true };
  }

  if (isDockmeInternalDockerEvent(event)) {
    console.log('🔕 [Docker events] Evento interno de Dockme ignorado');
    return { success: true, ignored: true, internal: true };
  }

  if (isDockerEventSuppressed(event)) {
    const stack = event.stack;
    const container = event.container;
    console.log(`🔕 [Docker events] Silenciado por vista abierta: ${stack || container}`);
    return { success: true, suppressed: true };
  }

  const endpoint = event.endpoint || 'Actual';
  const container = event.container;
  const dedupeKey = `${endpoint}:${container}:${event.state}`;
  const now = Date.now();
  const lastSeen = dockerEventDedupe.get(dedupeKey) || 0;

  // Docker suele emitir die + stop para una parada normal. Evita duplicados.
  if (now - lastSeen < 15000) {
    console.log(`🔕 [Docker events] Duplicado ignorado: ${dedupeKey}`);
    return { success: true, duplicate: true };
  }

  dockerEventDedupe.set(dedupeKey, now);
  for (const [key, ts] of dockerEventDedupe) {
    if (now - ts > 60000) dockerEventDedupe.delete(key);
  }

  const hostname = dockerEventHostname(endpoint, event.hostname);
  const host = hostname ? ` en ${hostname}` : '';
  const text = event.state === 'started'
    ? `🟢 El contenedor ${container} se ha iniciado${host}`
    : `🔴 El contenedor ${container} se ha detenido${host}`;

  console.log(`🐳 [Docker events] ${text}`);
  await sendNotification(text);
  return { success: true };
}

function scheduleDockerEventReconnect() {
  if (dockerEventReconnectTimer) return;
  dockerEventReconnectTimer = setTimeout(() => {
    dockerEventReconnectTimer = null;
    startDockerEventWatcher();
  }, 5000);
}

function startDockerEventWatcher() {
  const since = Math.floor(Date.now() / 1000);
  const eventPath = `/events?since=${since}&filters=${dockerEventFilters()}`;
  let buffer = '';

  console.log(`👂 [Docker events] Escuchando cambios locales de contenedores (${IS_AGENT ? 'agente' : 'central'})...`);

  const req = http.request(
    { socketPath: '/var/run/docker.sock', path: eventPath, method: 'GET' },
    res => {
      res.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            handleDockerEvent(JSON.parse(trimmed));
          } catch (err) {
            console.warn(`⚠️ [Docker events] Evento inválido: ${err.message}`);
          }
        }
      });

      res.on('end', () => {
        console.warn('⚠️ [Docker events] Stream cerrado, reintentando...');
        scheduleDockerEventReconnect();
      });
    }
  );

  req.on('error', err => {
    console.warn(`⚠️ [Docker events] No se pudo escuchar Docker: ${err.message}`);
    scheduleDockerEventReconnect();
  });

  req.end();
}

async function runScheduledChecks(notify = true) {
  console.log(`🕒 [Cycle] Iniciando — ${new Date().toISOString()}`);

  const snapshotBefore = JSON.parse(JSON.stringify(readUpdatesFile()));
  const updates  = readUpdatesFile();
  const settings = readSettingsFile();
  const pruneMode = settings.pruneMode || 'disabled';

  // Incluir: Actual siempre + agentes con loggedIn=true en updates.json
  // Si ningún agente tiene loggedIn (instalaciones antiguas), usar todos como fallback
  const hasAnyLogged = updates.some(h => h.endpoint?.toLowerCase() !== 'actual' && h.loggedIn === true);
  const servers = updates
    .filter(h => {
      const ep = (h.endpoint || '').toLowerCase();
      if (ep === 'actual') return true;
      if (hasAnyLogged) return h.loggedIn === true;
      return true; // fallback: ningún agente tiene loggedIn aún (instalación antigua)
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

    // Refrescar primero la tarjeta existente: editMessageText no crea un mensaje
    // nuevo ni una segunda notificación push en Telegram.
    if (newUpdates.length > 0) {
      await refreshTelegramBotMenus();
    }

    // Dockme central se notifica como excepción de mantenimiento aunque
    // el usuario haya desactivado las notificaciones generales de updates.
    await maybeNotifyCentralDockmeUpdate(snapshotAfter);

    if (settings.notifications?.updates === false) {
      console.log('📵 [Cycle] Notificaciones de actualizaciones desactivadas');
      return;
    }

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
// ============================
// GET /api/stack-containers/:stack
// Devuelve la lista de contenedores de un stack (local o proxy remoto)
// ============================
app.get('/api/stack-containers/:stack', async (req, res) => {
  const { stack } = req.params;
  const { endpoint } = req.query;

  // Proxy al agente remoto
  if (endpoint && endpoint.toLowerCase() !== 'actual') {
    try {
      const response = await fetch(`http://${endpoint}/api/stack-containers/${encodeURIComponent(stack)}`, {
        signal: AbortSignal.timeout(5000)
      });
      const data = await response.json();
      return res.json(data);
    } catch (err) {
      return res.status(502).json({ success: false, message: err.message });
    }
  }

  // Local
  const stacksDir = process.env.DOCKGE_STACKS_DIR || '/opt/stacks';
  const composePath = path.join(stacksDir, stack, 'compose.yaml');
  if (!fs.existsSync(composePath)) {
    return res.status(404).json({ success: false, message: 'Stack no encontrado' });
  }

  exec(`docker compose -f ${composePath} ps --all --format json`, (err, stdout) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    try {
      const containers = stdout.trim().split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .map(c => {
          // Deduplicar puertos — preferir entrada con IP específica sobre 0.0.0.0
          const seen = new Map();
          (c.Publishers || [])
            .filter(p => p.PublishedPort > 0)
            .forEach(p => {
              const key = p.PublishedPort;
              const hasSpecificIP = p.URL && p.URL !== '0.0.0.0' && p.URL !== '::';
              if (!seen.has(key) || hasSpecificIP) {
                seen.set(key, { host: p.URL || '0.0.0.0', published: p.PublishedPort, target: p.TargetPort, protocol: p.Protocol });
              }
            });
          return { name: c.Names, service: c.Service, state: c.State, health: c.Health || '', ports: Array.from(seen.values()) };
        });
      res.json({ success: true, containers });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });
});

// ============================
// GET /api/logs/:stack  — SSE streaming de logs Docker
// Query params: ?endpoint=IP:PORT  &container=NOMBRE  &tail=200
// Si endpoint es remoto, hace pipe del SSE del agente al frontend.
// ============================
app.get('/api/logs/:stack', (req, res) => {
  const { stack } = req.params;
  const { container, tail = '200', endpoint } = req.query;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Proxy SSE al agente remoto
  if (endpoint && endpoint.toLowerCase() !== 'actual') {
    const [agentHost, agentPort = '5002'] = endpoint.split(':');
    const qs = new URLSearchParams({ tail, ...(container ? { container } : {}) }).toString();
    const agentPath = `/api/logs/${encodeURIComponent(stack)}?${qs}`;

    console.log(`📡 [Logs] Proxy → ${endpoint}${agentPath}`);

    const agentReq = http.request(
      { host: agentHost, port: agentPort, path: agentPath, method: 'GET' },
      agentRes => { agentRes.pipe(res); }
    );
    agentReq.on('error', err => {
      res.write(`data: ❌ Error conectando con el agente: ${err.message}\n\n`);
      res.end();
    });
    req.on('close', () => agentReq.destroy());
    agentReq.end();
    return;
  }

  // Local: lanzar docker compose logs
  const stacksDir = process.env.DOCKGE_STACKS_DIR || '/opt/stacks';
  const composePath = path.join(stacksDir, stack, 'compose.yaml');

  if (!fs.existsSync(composePath)) {
    res.write(`data: ❌ Stack no encontrado: ${stack}\n\n`);
    res.end();
    return;
  }

  const args = ['compose', '-f', composePath, 'logs', '--timestamps', '--follow', '--tail', tail];
  if (container) args.push(container);

  console.log(`📋 [Logs] Iniciando stream: ${stack}${container ? ` (${container})` : ''}`);
  const proc = spawn('docker', args);

  const sendLine = line => {
    if (line.trim()) res.write(`data: ${line}\n\n`);
  };

  proc.stdout.on('data', chunk => chunk.toString().split('\n').forEach(sendLine));
  proc.stderr.on('data', chunk => chunk.toString().split('\n').forEach(sendLine));

  req.on('close', () => {
    console.log(`📋 [Logs] Cliente desconectado: ${stack}`);
    proc.kill();
  });
  proc.on('close', () => res.end());
});

// ============================
// GET /api/compose/:stack — Lee el compose.yaml de un stack
// POST /api/compose/:stack — Guarda el compose.yaml de un stack
// Query param: ?endpoint=IP:PORT para remotos
// ============================
app.get('/api/compose/:stack', async (req, res) => {
  const { stack } = req.params;
  const { endpoint } = req.query;

  // Proxy al agente remoto
  if (endpoint && endpoint.toLowerCase() !== 'actual') {
    try {
      const response = await fetch(`http://${endpoint}/api/compose/${encodeURIComponent(stack)}`, {
        signal: AbortSignal.timeout(5000)
      });
      const data = await response.json();
      return res.json(data);
    } catch (err) {
      return res.status(502).json({ success: false, message: err.message });
    }
  }

  // Local
  const stacksDir = process.env.DOCKGE_STACKS_DIR || '/opt/stacks';
  const composePath = path.join(stacksDir, stack, 'compose.yaml');
  const envPath     = path.join(stacksDir, stack, '.env');

  if (!fs.existsSync(composePath)) {
    return res.status(404).json({ success: false, message: 'compose.yaml no encontrado' });
  }
  try {
    const compose = fs.readFileSync(composePath, 'utf8');
    const env     = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    res.json({ success: true, content: compose, env });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/compose/:stack', async (req, res) => {
  const { stack } = req.params;
  const { endpoint } = req.query;
  const { content, env } = req.body;

  if (!content || typeof content !== 'string') {
    return res.status(400).json({ success: false, message: 'Falta el contenido del compose' });
  }

  // Proxy al agente remoto
  if (endpoint && endpoint.toLowerCase() !== 'actual') {
    try {
      const response = await fetch(`http://${endpoint}/api/compose/${encodeURIComponent(stack)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, env }),
        signal: AbortSignal.timeout(5000)
      });
      const data = await response.json();
      return res.json(data);
    } catch (err) {
      return res.status(502).json({ success: false, message: err.message });
    }
  }

  // Local
  const stacksDir = process.env.DOCKGE_STACKS_DIR || '/opt/stacks';
  const composePath = path.join(stacksDir, stack, 'compose.yaml');
  const envPath     = path.join(stacksDir, stack, '.env');

  if (!fs.existsSync(path.dirname(composePath))) {
    return res.status(404).json({ success: false, message: 'Stack no encontrado' });
  }
  try {
    fs.writeFileSync(composePath, content, 'utf8');
    // Guardar .env solo si tiene contenido o ya existía
    if (env !== undefined) {
      if (env.trim()) {
        fs.writeFileSync(envPath, env, 'utf8');
      } else if (fs.existsSync(envPath)) {
        fs.unlinkSync(envPath); // borrar si está vacío y existía
      }
    }
    console.log(`💾 [Compose] Guardado: ${stack}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================
// GET /api/deploy/:stack — Ejecuta docker compose up -d con streaming SSE
// ============================
app.get('/api/deploy/:stack', (req, res) => {
  const { stack } = req.params;
  const { endpoint } = req.query;

  addDockerEventExclusion(endpoint || 'Actual', stack, 'dockme-compose-action');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Proxy SSE al agente remoto
  if (endpoint && endpoint.toLowerCase() !== 'actual') {
    const [agentHost, agentPort = '5002'] = endpoint.split(':');
    const agentPath = `/api/deploy/${encodeURIComponent(stack)}`;
    const agentReq = http.request(
      { host: agentHost, port: agentPort, path: agentPath, method: 'GET' },
      agentRes => { agentRes.pipe(res); }
    );
    agentReq.on('error', err => {
      res.write(`data: ❌ Error conectando con el agente: ${err.message}\n\n`);
      res.end();
    });
    req.on('close', () => agentReq.destroy());
    agentReq.end();
    return;
  }

  // Local
  const stacksDir = process.env.DOCKGE_STACKS_DIR || '/opt/stacks';
  const composePath = path.join(stacksDir, stack, 'compose.yaml');
  if (!fs.existsSync(composePath)) {
    res.write(`data: ❌ Stack no encontrado: ${stack}\n\n`);
    res.end();
    return;
  }

  console.log(`🚀 [Deploy] Iniciando: ${stack}`);
  const proc = spawn('docker', ['compose', '-f', composePath, 'up', '-d', '--remove-orphans']);

  const sendLine = line => {
    if (line.trim()) res.write(`data: ${line}\n\n`);
  };

  proc.stdout.on('data', chunk => chunk.toString().split('\n').forEach(sendLine));
  proc.stderr.on('data', chunk => chunk.toString().split('\n').forEach(sendLine));

  proc.on('close', (code) => {
    res.write(`data: ${code === 0 ? '✅ Deploy completado' : '❌ Deploy finalizado con errores'}\n\n`);
    res.end();
    console.log(`${code === 0 ? '✅' : '❌'} [Deploy] ${stack} finalizado (code ${code})`);
  });

  req.on('close', () => proc.kill());
});

function runDockerJsonLines(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(stderr.trim() || `docker ${args.join(' ')} finalizó con código ${code}`));
      try {
        const rows = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        resolve(rows);
      } catch (err) {
        reject(new Error(`No se pudo interpretar la salida de Docker: ${err.message}`));
      }
    });
  });
}

function runCommandText(command, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(stderr.trim() || `${command} finalizó con código ${code}`));
      resolve(stdout.trim());
    });
  });
}

let cpuNormalizationFactorCache = null;

async function getCpuNormalizationFactor() {
  if (cpuNormalizationFactorCache) return cpuNormalizationFactorCache;
  try {
    const output = await runCommandText('nproc');
    const count = parseInt(output, 10);
    cpuNormalizationFactorCache = Number.isFinite(count) && count > 0 ? count : 1;
    return cpuNormalizationFactorCache;
  } catch (err) {
    console.warn(`⚠️ [ContainerStats] nproc falló: ${err.message}`);
    return 1;
  }
}

function parseCpuPercent(value) {
  const n = parseFloat(String(value || '0').replace('%', '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function parseDockerSizeToBytes(value) {
  const match = String(value || '').trim().match(/^([\d.,]+)\s*([KMGTPE]?i?B|B)?/i);
  if (!match) return 0;
  const amount = parseFloat(match[1].replace(',', '.'));
  if (!Number.isFinite(amount)) return 0;
  const unit = (match[2] || 'B').toUpperCase();
  const multipliers = {
    B: 1,
    KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, TB: 1000 ** 4, PB: 1000 ** 5,
    KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4, PIB: 1024 ** 5
  };
  return Math.round(amount * (multipliers[unit] || 1));
}

function parseDockerLabels(labels) {
  if (!labels) return {};
  if (typeof labels === 'object') return labels;
  return String(labels).split(',').reduce((acc, item) => {
    const idx = item.indexOf('=');
    if (idx > 0) acc[item.slice(0, idx)] = item.slice(idx + 1);
    return acc;
  }, {});
}

function normalizeContainerName(value) {
  return String(value || '').replace(/^\//, '');
}

// ============================
// GET /api/container-stats — lista contenedores Docker con CPU/RAM y stack
// ============================
app.get('/api/container-stats', async (req, res) => {
  const { endpoint } = req.query;

  if (endpoint && endpoint.toLowerCase() !== 'actual') {
    try {
      const response = await fetch(`http://${endpoint}/api/container-stats`, {
        signal: AbortSignal.timeout(8000)
      });
      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (err) {
      return res.status(502).json({ success: false, message: err.message });
    }
  }

  try {
    const [statsRows, psRows, cpuNormalizationFactor] = await Promise.all([
      runDockerJsonLines(['stats', '--no-stream', '--format', 'json']).catch(err => {
        console.warn(`⚠️ [ContainerStats] docker stats falló: ${err.message}`);
        return [];
      }),
      runDockerJsonLines(['ps', '-a', '--format', 'json']),
      getCpuNormalizationFactor()
    ]);

    const statsByName = new Map();
    statsRows.forEach(row => {
      const name = normalizeContainerName(row.Name || row.Container || row.NameRaw);
      if (!name) return;
      statsByName.set(name, row);
    });

    const containers = psRows.map(row => {
      const name = normalizeContainerName(row.Names || row.Name);
      const labels = parseDockerLabels(row.Labels);
      const stack = labels['com.docker.compose.project'] || '';
      const stats = statsByName.get(name) || {};
      const cpuValue = parseCpuPercent(stats.CPUPerc) / cpuNormalizationFactor;
      const ram = stats.MemUsage ? String(stats.MemUsage).split('/')[0].trim() : '';
      const ramBytes = parseDockerSizeToBytes(ram);
      const status = row.State || row.Status || '';

      return {
        name,
        stack,
        status,
        cpu: cpuValue ? `${cpuValue.toFixed(cpuValue >= 10 ? 1 : 2)}%` : '0%',
        cpuValue,
        ram: ram || '-',
        ramBytes,
        uptime: row.Status || '',
        image: row.Image || '',
        ports: row.Ports || '',
        unmanaged: !stack
      };
    }).filter(c => c.name);

    res.json({ success: true, containers });
  } catch (err) {
    console.error(`❌ [ContainerStats] ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================
// GET /api/container-stats/live — refresco ligero de CPU/RAM
// ============================
app.get('/api/container-stats/live', async (req, res) => {
  const { endpoint } = req.query;

  if (endpoint && endpoint.toLowerCase() !== 'actual') {
    try {
      const response = await fetch(`http://${endpoint}/api/container-stats/live`, {
        signal: AbortSignal.timeout(8000)
      });
      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (err) {
      return res.status(502).json({ success: false, message: err.message });
    }
  }

  try {
    const [statsRows, cpuNormalizationFactor] = await Promise.all([
      runDockerJsonLines(['stats', '--no-stream', '--format', 'json']),
      getCpuNormalizationFactor()
    ]);

    const containers = statsRows.map(row => {
      const name = normalizeContainerName(row.Name || row.Container || row.NameRaw);
      const cpuValue = parseCpuPercent(row.CPUPerc) / cpuNormalizationFactor;
      const ram = row.MemUsage ? String(row.MemUsage).split('/')[0].trim() : '';
      const ramBytes = parseDockerSizeToBytes(ram);

      return {
        name,
        cpu: cpuValue ? `${cpuValue.toFixed(cpuValue >= 10 ? 1 : 2)}%` : '0%',
        cpuValue,
        ram: ram || '-',
        ramBytes
      };
    }).filter(c => c.name);

    res.json({ success: true, containers });
  } catch (err) {
    console.error(`❌ [ContainerStatsLive] ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================
// POST /api/container-action — start/stop/restart/remove de un contenedor individual
// ============================
app.post('/api/container-action', async (req, res) => {
  const { container, action } = req.body;
  const { endpoint } = req.query;

  if (!container || !['start', 'stop', 'restart', 'remove'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Parámetros inválidos' });
  }

  // Las acciones iniciadas desde la tabla de Dockme no deben generar una
  // segunda notificación Docker. En contenedores sin Compose, stack === nombre.
  addDockerEventExclusion(endpoint || 'Actual', container, 'dockme-container-action');

  // Proxy al agente remoto
  if (endpoint && endpoint.toLowerCase() !== 'actual') {
    try {
      const response = await fetch(`http://${endpoint}/api/container-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container, action }),
        signal: AbortSignal.timeout(10000)
      });
      const data = await response.json();
      return res.json(data);
    } catch (err) {
      return res.status(502).json({ success: false, message: err.message });
    }
  }

  // Local
  const dockerArgs = action === 'remove'
    ? ['rm', '-f', container]
    : [action, container];
  const proc = spawn('docker', dockerArgs);
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
  proc.on('error', err => res.status(500).json({ success: false, message: err.message }));
  proc.on('close', code => {
    if (code !== 0) return res.status(500).json({ success: false, message: stderr.trim() || `docker ${dockerArgs.join(' ')} finalizó con código ${code}` });
    console.log(`🐳 [Container] ${action} ${container}`);
    res.json({ success: true });
  });
});

// ============================
// POST /api/create-stack — Crea un nuevo stack (carpeta + compose.yaml + .env opcional)
// ============================
app.post('/api/create-stack', async (req, res) => {
  const { stack, content, env, endpoint } = req.body;

  if (!stack || !content) {
    return res.status(400).json({ success: false, message: 'Falta nombre o contenido del compose' });
  }

  // Validar nombre — solo letras, números, guiones y guiones bajos
  if (!/^[a-zA-Z0-9_-]+$/.test(stack)) {
    return res.status(400).json({ success: false, message: 'Nombre inválido — solo letras, números, - y _' });
  }

  // Proxy al agente remoto
  if (endpoint && endpoint.toLowerCase() !== 'actual') {
    try {
      const response = await fetch(`http://${endpoint}/api/create-stack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stack, content, env }),
        signal: AbortSignal.timeout(10000)
      });
      const data = await response.json();
      return res.json(data);
    } catch (err) {
      return res.status(502).json({ success: false, message: err.message });
    }
  }

  // Local
  const stacksDir = process.env.DOCKGE_STACKS_DIR || '/opt/stacks';
  const stackDir   = path.join(stacksDir, stack);
  const composePath = path.join(stackDir, 'compose.yaml');
  const envPath     = path.join(stackDir, '.env');

  if (fs.existsSync(stackDir)) {
    return res.status(409).json({ success: false, message: `El stack "${stack}" ya existe` });
  }

  try {
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(composePath, content, 'utf8');
    if (env && env.trim()) fs.writeFileSync(envPath, env, 'utf8');
    console.log(`✨ [Create] Stack creado: ${stack}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(port, () => {
  console.log(`✅ API Node lista`);
  console.log(`🔗 [Connected] Endpoints activos: [ninguno — pendiente sincronización del frontend]`);
  setupScheduler();
  startDockerEventWatcher();
  restartTelegramBot();
});
