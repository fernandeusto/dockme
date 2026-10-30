import crypto from 'node:crypto';
import { equalSecret, internalKey, peerOrigin, readPeers, validateStackName, stackFile, pruneMode } from './security.js';

const cookieName = req => 'dockme_session_' + crypto.createHash('sha256').update(req.get('Host') || '').digest('hex').slice(0, 12);
export async function validSession(token) {
  if (typeof token !== 'string' || !token || token.length > 4096) return false;
  try {
    const response = await fetch('http://127.0.0.1:5001/dockme-internal/auth', {
      headers: { Authorization: `Bearer ${token}`, 'X-Dockme-Internal': internalKey() },
      signal: AbortSignal.timeout(5000)
    });
    return response.ok;
  } catch { return false; }
}

function cookie(req) {
  const value = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName(req)}=`));
  return value ? value.slice(cookieName(req).length + 1) : '';
}

export function installAuth(app) {
  app.get('/api/public-info', (_req, res) => res.json({ isAgent: !!(process.env.CENTRAL_URL || process.env.WEBHOOK_URL) }));
  app.post('/api/session', async (req, res) => {
    const token = (req.get('Authorization') || '').replace(/^Bearer /, '');
    if (!await validSession(token)) return res.status(401).json({ error: 'Sesión no válida' });
    const secure = req.get('X-Forwarded-Proto') === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${cookieName(req)}=${token}; Path=/; HttpOnly; SameSite=Strict${secure}`);
    res.json({ success: true });
  });
  app.delete('/api/session', (req, res) => {
    res.setHeader('Set-Cookie', `${cookieName(req)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ success: true });
  });

  app.use(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.path === '/api/xterm.js' || req.path === '/api/xterm.css') return next();
    try {
      // Port 5002 binds exclusively to loopback. Nginx always sets this marker.
      const internal = !req.get('X-Dockme-Proxy') && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const peer = Object.entries(readPeers()).find(([, key]) => equalSecret(req.get('X-Dockme-Peer'), key));
      if (!internal && !peer) {
        // Legacy discovery only adds bounded, untrusted metadata; it grants no access.
        if (req.method === 'POST' && req.path === '/api/agent-alive') {
          req.discoveryOnly = true;
        } else {
          const token = (req.get('Authorization') || '').replace(/^Bearer /, '') || cookie(req);
          if (!await validSession(token)) return res.status(401).json({ error: 'Inicia sesión en Dockme' });
          // Protect cookie-authenticated writes (including the SSE deploy GET).
          if ((req.method !== 'GET' || req.path.startsWith('/api/deploy/')) && req.get('Origin') &&
              new URL(req.get('Origin')).host !== req.get('Host')) {
            return res.status(403).json({ error: 'Origen no permitido' });
          }
        }
      }
      if (peer && !internal) {
        const allowed = /^\/api\/(?:agent-alive|set-updates|docker-event|run-check|run-prune|update-self|stack-containers\/[^/]+|logs\/[^/]+|compose\/[^/]+|deploy\/[^/]+|create-stack|container-action|container-stats(?:\/live)?)$/.test(req.path) || req.path === '/metrics';
        if (!allowed) return res.sendStatus(403);
        if (['/api/set-updates', '/api/agent-alive', '/api/docker-event'].includes(req.path)) {
          if (peerOrigin(String(req.body?.endpoint || '')) !== peer[0]) return res.sendStatus(403);
        } else if (req.body?.endpoint && req.body.endpoint.toLowerCase() !== 'actual') {
          return res.sendStatus(403);
        }
      }
      const endpoint = req.query.endpoint || req.body?.endpoint;
      // Callback endpoints describe their sender; they are not proxy destinations.
      const callback = ['/api/set-updates', '/api/agent-alive', '/api/docker-event'].includes(req.path);
      if (!callback && endpoint && String(endpoint).toLowerCase() !== 'actual') {
        if (typeof endpoint !== 'string' || !/^[a-zA-Z0-9.\[\]:_-]{1,255}$/.test(endpoint) || !readPeers()[peerOrigin(endpoint)]) return res.status(400).json({ error: 'Agente no vinculado' });
        if (peer && !internal) return res.sendStatus(403);
      }
      if (/^\/api\/(?:stack-containers|logs|compose|deploy)\//.test(req.path)) {
        const name = decodeURIComponent(req.path.split('/')[3]);
        validateStackName(name);
        if (!endpoint || String(endpoint).toLowerCase() === 'actual') {
          stackFile(process.env.DOCKGE_STACKS_DIR || '/opt/stacks', name, 'compose.yaml');
          stackFile(process.env.DOCKGE_STACKS_DIR || '/opt/stacks', name, '.env');
        }
      }
      if (req.path === '/api/create-stack') validateStackName(req.body?.stack);
      if (req.path === '/api/container-action' && (typeof req.body?.container !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(req.body.container))) {
        return res.status(400).json({ error: 'Contenedor inválido' });
      }
      if (req.path.startsWith('/api/logs/')) {
        if (req.query.tail !== undefined && (typeof req.query.tail !== 'string' || !/^(?:[0-9]{1,4}|10000)$/.test(req.query.tail))) return res.status(400).json({ error: 'Límite de logs inválido' });
        if (req.query.container && (typeof req.query.container !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(req.query.container))) return res.status(400).json({ error: 'Contenedor inválido' });
      }
      if (req.body?.pruneMode !== undefined) pruneMode(req.body.pruneMode);
      if (req.path === '/api/save-settings' && req.body?.pruneMode !== undefined) pruneMode(req.body.pruneMode);
      next();
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
}
