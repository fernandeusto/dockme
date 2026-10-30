import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function privateFile(name) {
  const privateDir = path.join(process.env.DOCKGE_DATA_DIR || '/app/data', 'security');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  return path.join(privateDir, name);
}

export function internalKey() {
  const file = privateFile('internal-key');
  try { fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (err) { if (err.code !== 'EEXIST') throw err; }
  return fs.readFileSync(file, 'utf8').trim();
}

export function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function peerOrigin(value) {
  const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Destino inválido');
  return url.origin;
}

export function readPeers() {
  try { return JSON.parse(fs.readFileSync(privateFile('peers.json'), 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
}

export function savePeer(origin, token) {
  const peers = readPeers();
  peers[peerOrigin(origin)] = token;
  const file = privateFile('peers.json');
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(peers), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function ensurePeer(origin) {
  const key = peerOrigin(origin);
  const token = readPeers()[key] || crypto.randomBytes(32).toString('hex');
  savePeer(key, token);
  return token;
}

export function removePeer(origin) {
  const peers = readPeers();
  delete peers[peerOrigin(origin)];
  fs.writeFileSync(privateFile('peers.json'), JSON.stringify(peers), { mode: 0o600 });
}

export function peerHeaders(target) {
  const token = readPeers()[peerOrigin(target)];
  if (!token) throw new Error('Agente sin vincular: inicia sesión en Dockme para conectar los agentes');
  return { 'X-Dockme-Peer': token };
}

export function validateStackName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(name)) throw new Error('Nombre de stack inválido');
  return name;
}

export function containedPath(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || name !== path.basename(name) || name === '.' || name === '..') {
    throw new Error('Nombre de archivo inválido');
  }
  const result = path.resolve(root, name);
  const realRoot = fs.realpathSync(root);
  if (fs.existsSync(result)) {
    const real = fs.realpathSync(result);
    if (!real.startsWith(realRoot + path.sep)) throw new Error('Ruta fuera del directorio permitido');
  } else {
    // existsSync follows symlinks and misses dangling ones.
    try { if (fs.lstatSync(result).isSymbolicLink()) throw new Error('Enlace no permitido'); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return result;
}

export function stackFile(root, stack, file) {
  validateStackName(stack);
  const dir = containedPath(root, stack);
  return fs.existsSync(dir) ? containedPath(dir, file) : path.join(dir, file);
}

export function pruneMode(value) {
  if (!['disabled', 'conservative', 'normal', 'aggressive'].includes(value)) throw new Error('Modo de limpieza inválido');
  return value;
}

// SVGs are served as documents too: scripts and embedded HTML must never run.
export function validateSvg(svg) {
  if (typeof svg !== 'string' || Buffer.byteLength(svg) > 512 * 1024 || !/<svg[\s>]/i.test(svg) ||
      /<!DOCTYPE|<!ENTITY|<\s*(?:script|foreignObject|iframe|object|embed|animate\w*|set)\b|\bon\w+\s*=|(?:javascript|data|vbscript)\s*:|\b(?:href|src)\s*=\s*["']?\s*(?!#)[^\s"'>]+|url\s*\(\s*[\"']?\s*(?!#)/i.test(svg)) {
    throw new Error('SVG no permitido: utiliza un icono estático sin contenido activo ni referencias externas');
  }
  return svg;
}

export async function downloadImage(url, type = 'svg') {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('URL de imagen inválida');
  // LAN/VPN destinations are intentional. No redirects, bounded time and size.
  const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok || Number(response.headers.get('content-length') || 0) > 512 * 1024) {
    await response.body?.cancel();
    throw new Error('Imagen no disponible o demasiado grande');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 512 * 1024) throw new Error('Imagen demasiado grande');
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  return type === 'svg' ? validateSvg(data.toString('utf8')) : data;
}
