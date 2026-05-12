#!/usr/bin/env node
/**
 * MetricsService.js — Reemplaza api_metrics.py + metrics.sh
 * Puerto 5000, endpoint GET /metrics
 * 
 * Modo standalone (test SSH): node MetricsService.js --once
 * Modo servicio:               node MetricsService.js
 */
'use strict';

const fs   = require('fs');
const net  = require('net');
const http = require('http');
const os   = require('os');

const ONCE = process.argv.includes('--once');

// ─── Helpers ────────────────────────────────────────────────────────────────

function readFile(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── CPU ────────────────────────────────────────────────────────────────────

let _cpuPrev = null;

function readCpuTick() {
  const line = readFile('/proc/stat')?.split('\n')[0];
  if (!line) return null;
  const nums = line.split(/\s+/).slice(1).map(Number);
  return { total: nums.reduce((a, b) => a + b, 0), idle: nums[3] };
}

function calcCpu(prev, curr) {
  if (!prev || !curr) return 0;
  const dt = curr.total - prev.total;
  const di = curr.idle  - prev.idle;
  return dt > 0 ? Math.round(100 * (dt - di) / dt) : 0;
}

// ─── Memoria ─────────────────────────────────────────────────────────────────

function getMemory() {
  const raw = readFile('/proc/meminfo');
  if (!raw) return 0;
  const m = {};
  for (const l of raw.split('\n')) {
    const [k, v] = l.split(':');
    if (k && v) m[k.trim()] = parseInt(v);
  }
  const total = m.MemTotal || 0;
  if (!total) return 0;
  const avail = m.MemAvailable || 0;
  let arc = 0;
  const arcRaw = readFile('/proc/spl/kstat/zfs/arcstats');
  if (arcRaw) {
    const match = arcRaw.match(/^size\s+\d+\s+(\d+)/m);
    if (match) arc = Math.floor(parseInt(match[1]) / 1024);
  }
  return Math.round(Math.max(0, total - avail - arc) * 100 / total);
}

// ─── Temperatura ─────────────────────────────────────────────────────────────

function getTemperatures() {
  let tempCpu = null, tempBoard = null;
  try {
    const hws = fs.readdirSync('/sys/class/hwmon');
    for (const hw of hws) {
      const name = readFile(`/sys/class/hwmon/${hw}/name`) || '';
      if (name.includes('coretemp')) {
        const files = fs.readdirSync(`/sys/class/hwmon/${hw}`)
          .filter(f => /^temp\d+_input$/.test(f));
        let sum = 0, n = 0;
        for (const f of files) {
          const v = parseInt(readFile(`/sys/class/hwmon/${hw}/${f}`));
          if (v > 0) { sum += v; n++; }
        }
        if (n > 0) tempCpu = Math.floor(sum / n / 1000);
        break;
      }
    }
  } catch {}
  const b = readFile('/sys/class/hwmon/hwmon0/temp1_input');
  if (b) tempBoard = Math.floor(parseInt(b) / 1000);

  // Temperatura discos — drivetemp (SATA) y nvme
  let tempDisk = null;
  try {
    const hws = fs.readdirSync('/sys/class/hwmon');
    for (const hw of hws) {
      const name = readFile(`/sys/class/hwmon/${hw}/name`) || '';
      if (name !== 'drivetemp' && name !== 'nvme') continue;
      const raw = readFile(`/sys/class/hwmon/${hw}/temp1_input`);
      if (!raw) continue;
      const t = Math.floor(parseInt(raw) / 1000);
      if (t > 0 && (tempDisk === null || t > tempDisk)) tempDisk = t;
    }
  } catch {}

  return { tempCpu, tempBoard, tempDisk };
}

// ─── Red ─────────────────────────────────────────────────────────────────────

let _netIface     = null;
let _netIfaceTime = 0;
let _netPrev      = null;
let _netPrevTime  = 0;

function detectIface() {
  const now = Date.now();
  if (_netIface && now - _netIfaceTime < 300_000) return _netIface;
  const base = fs.existsSync('/host/sys/class/net')
    ? '/host/sys/class/net' : '/sys/class/net';
  const patterns = [/^(eth|enp|eno|ens|em|igb|ixgbe|bond|wlan|wlp)/, /^tailscale/];
  try {
    const ifaces = fs.readdirSync(base);
    for (const pat of patterns) {
      for (const iface of ifaces) {
        if (!pat.test(iface)) continue;
        if (readFile(`${base}/${iface}/operstate`) === 'up') {
          _netIface = { iface, base };
          _netIfaceTime = now;
          return _netIface;
        }
      }
    }
  } catch {}
  return null;
}

function getNetwork() {
  const info = detectIface();
  if (!info) return { net_down: null, net_up: null };
  const { iface, base } = info;
  const rx = parseInt(readFile(`${base}/${iface}/statistics/rx_bytes`));
  const tx = parseInt(readFile(`${base}/${iface}/statistics/tx_bytes`));
  const now = Date.now();
  if (!_netPrev || isNaN(rx)) {
    _netPrev = { rx, tx }; _netPrevTime = now;
    return { net_down: null, net_up: null };
  }
  const el = (now - _netPrevTime) / 1000;
  if (el < 0.1) return { net_down: null, net_up: null };
  const fmt = v => {
    const mbps = Math.max(0, v * 8 / 1024 / 1000 / el);
    return mbps < 1 ? parseFloat(mbps.toFixed(1)) : Math.round(mbps);
  };
  const result = { net_down: fmt(rx - _netPrev.rx), net_up: fmt(tx - _netPrev.tx) };
  _netPrev = { rx, tx }; _netPrevTime = now;
  return result;
}

// ─── Espacio en disco ────────────────────────────────────────────────────────

const EXCLUDE_FS = new Set([
  'tmpfs','devtmpfs','ramfs','proc','sysfs','devpts','cgroup','cgroup2',
  'pstore','securityfs','debugfs','tracefs','hugetlbfs','mqueue','fusectl',
  'overlay','aufs','nsfs','squashfs','efivarfs','bpf','configfs'
]);

const DISK_REGEX = /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

function getDiskSpace() {
  const mounts = readFile('/proc/mounts');
  let freeBytes = 0;
  const seen = new Set();

  if (mounts) {
    for (const line of mounts.split('\n')) {
      const [device, mountpoint, fstype] = line.split(' ');
      if (!device || !mountpoint || !fstype) continue;
      if (EXCLUDE_FS.has(fstype)) continue;
      if (device === 'none' || /^\d/.test(device)) continue;
      const key = fstype === 'zfs' ? device.split('/')[0] : device;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const s = fs.statfsSync(mountpoint);
        freeBytes += s.bavail * s.bsize;
      } catch {}
    }
  }

  return {
    disk_free_gb: freeBytes > 0
      ? parseFloat((freeBytes / 1024 / 1024 / 1024).toFixed(1))
      : null,
  };
}




let _diskPrev     = {};
let _diskPrevTime = 0;
let _diskSnaps    = [];  // snapshots horarios: [{ts, sumIo}]
const SNAP_CACHE  = '/app/data/dockme_disk_snap.cache';

function getDisk() {
  const raw = readFile('/proc/diskstats');
  if (!raw) return { disk_util: null, disk_util_24h: null };

  const now = Date.now() / 1000;
  const curr = {};
  let sumIo = 0;
  for (const line of raw.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    const name = f[2];
    if (!DISK_REGEX.test(name)) continue;
    const io = parseInt(f[12]);
    curr[name] = io;
    sumIo += io;
  }

  // disk_util — máximo de todos los discos
  let maxUtil = 0;
  if (_diskPrevTime > 0) {
    const el = now - _diskPrevTime;
    if (el > 0) {
      for (const [d, io] of Object.entries(curr)) {
        if (_diskPrev[d] !== undefined) {
          const u = Math.min(100, Math.max(0, (io - _diskPrev[d]) / el / 10));
          if (u > maxUtil) maxUtil = u;
        }
      }
    }
  }
  _diskPrev = curr;
  _diskPrevTime = now;
  const disk_util = _diskPrevTime > 0 ? parseFloat(maxUtil.toFixed(1)) : null;

  // disk_util_24h — snapshots horarios
  const cutoff = now - 86400;
  _diskSnaps = _diskSnaps.filter(s => s.ts >= cutoff);
  const lastSnap = _diskSnaps[_diskSnaps.length - 1];
  if (!lastSnap || now - lastSnap.ts >= 3600) {
    _diskSnaps.push({ ts: now, sumIo });
    // Persistir a disco para sobrevivir reinicios
    try {
      fs.writeFileSync(SNAP_CACHE,
        _diskSnaps.map(s => `${Math.floor(s.ts)}:${s.sumIo}`).join('\n') + '\n');
    } catch {}
  }
  let disk_util_24h = null;
  if (_diskSnaps.length >= 2) {
    const oldest = _diskSnaps[0];
    const el24 = Math.max(1, now - oldest.ts);
    disk_util_24h = parseFloat(Math.max(0, (sumIo - oldest.sumIo) / el24 / 10).toFixed(1));
  }

  return { disk_util, disk_util_24h };
}

// ─── Docker ──────────────────────────────────────────────────────────────────

function dockerGet(path) {
  return new Promise(resolve => {
    const req = http.request(
      { socketPath: '/var/run/docker.sock', path, method: 'GET' },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function getDocker() {
  const list = await dockerGet('/containers/json?all=1');
  if (!list) return { docker_running: 0, docker_stopped: 0 };
  return {
    docker_running: list.filter(c => c.State === 'running').length,
    docker_stopped: list.filter(c => c.State === 'exited').length,
  };
}

// ─── UPS / NUT ───────────────────────────────────────────────────────────────

let _upsCache = { text: '', state: 'unknown' }, _upsCacheTs = 0;

function nutQuery(host, commands) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let buf = '';
    sock.setTimeout(2000);
    sock.connect(3493, host, () => sock.write(commands.join('\n') + '\n'));
    sock.on('data',    d => { buf += d.toString(); });
    sock.on('close',   () => resolve(buf));
    sock.on('error',   () => resolve(null));
    sock.on('timeout', () => { sock.destroy(); resolve(null); });
  });
}

async function getUps() {
  const now = Date.now();
  if (now - _upsCacheTs < 60_000) return _upsCache;

  const candidates = [];
  const _extractIp = url => url?.match(/(?:https?:\/\/)?([^:/]+)/)?.[1];

  // AGENT_URL del compose tiene la IP del central (NUT) — quitamos el puerto
  const _agentIp = _extractIp(process.env.AGENT_URL);
  if (_agentIp) candidates.push(_agentIp);

  // Fallbacks: primaryHost, centralUrl, localhost
  try {
    const s = JSON.parse(readFile('/app/data/config/settings.json') || '{}');
    const _ph = s.primaryHost;
    const _cu = _extractIp(s.centralUrl);
    if (_ph && !candidates.includes(_ph)) candidates.push(_ph);
    if (_cu && !candidates.includes(_cu)) candidates.push(_cu);
  } catch {}
  candidates.push('localhost');

  for (const host of candidates) {
    const r1 = await nutQuery(host, ['LIST UPS', 'LOGOUT']);
    if (!r1?.includes('BEGIN LIST UPS')) continue;
    const upsName = r1.match(/^UPS (\S+)/m)?.[1];
    if (!upsName) continue;
    const r2 = await nutQuery(host, [
      `GET VAR ${upsName} ups.status`,
      `GET VAR ${upsName} battery.charge`,
      `GET VAR ${upsName} battery.runtime`,
      'LOGOUT',
    ]);
    if (!r2) continue;
    const status  = r2.match(/VAR \S+ ups\.status "([^"]+)"/)?.[1]  || '';
    const charge  = parseInt(r2.match(/VAR \S+ battery\.charge "([^"]+)"/)?.[1]);
    const runtime = parseInt(r2.match(/VAR \S+ battery\.runtime "([^"]+)"/)?.[1]);
    _upsCache = formatUps(status, charge, runtime);
    _upsCacheTs = now;
    return _upsCache;
  }
  _upsCache = { text: '', state: 'unknown' };
  _upsCacheTs = now;
  return _upsCache;
}

function formatUps(status, charge, runtimeS) {
  const mins    = (runtimeS > 60 && runtimeS < 86400) ? Math.floor(runtimeS / 60) : null;
  const onBat   = status.includes('OB') || status.includes('LB');
  const onLine  = status.includes('OL');
  const charging = status.includes('CHRG') || (onLine && !isNaN(charge) && charge < 100);
  const chargeOk = !isNaN(charge) && charge >= 0;

  let text = '', state = 'unknown';

  if (onBat) {
    state = (!isNaN(charge) && charge <= 25) ? 'battery_low' : 'battery';
    if (chargeOk && mins)      text = `Bat. ${charge}% · ${mins}min`;
    else if (chargeOk)         text = `Batería · ${charge}%`;
    else                       text = 'Batería';
  } else if (onLine) {
    if (charging) {
      state = 'charging';
      text  = chargeOk ? `Cargando ${charge}%` : 'Cargando';
    } else {
      state = 'online';
      if (mins)           text = `Online · ${mins}min`;
      else if (chargeOk)  text = `Online · ${charge}%`;
      else                text = 'Online';
    }
  }

  return { text, state };
}

// ─── Config files ─────────────────────────────────────────────────────────────

function getCheckProgress() {
  try {
    const d = JSON.parse(readFile('/app/data/config/check-progress.json') || '{}');
    return {
      check_status:  d.status     || 'idle',
      check_percent: d.percent    || 0,
      prune_space:   d.pruneSpace || '',
      check_last:    d.lastCheck  || '',
    };
  } catch {
    return { check_status: 'idle', check_percent: 0, prune_space: '', check_last: '' };
  }
}

function getUpdates() {
  try {
    const data = JSON.parse(readFile('/app/data/config/updates.json') || '[]');
    const local = data.find(h => (h.endpoint || '').toLowerCase() === 'actual');
    return {
      updates_pending: local?.updates?.length ?? 0,
      total_updates:   data.reduce((s, h) => s + (h.updates?.length ?? 0), 0),
    };
  } catch { return { updates_pending: 0, total_updates: 0 }; }
}

function getVersion() {
  try { return JSON.parse(readFile('/tools/version.json') || '{}').version || 'unknown'; }
  catch { return 'unknown'; }
}

async function getVersionWithDev() {
  const base = getVersion();
  try {
    const info = await dockerGet('/containers/dockme/json');
    const image = info?.Config?.Image || '';
    if (image.includes(':dev') || image === 'dockme:dev') return 'DEV';
  } catch {}
  return base;
}

// ─── Colección principal ──────────────────────────────────────────────────────

let _current = null;
let _collecting = false;

async function collect() {
  if (_collecting) return;
  _collecting = true;
  try {
    const t0 = readCpuTick();
    const netBefore = detectIface() ? {
      rx: parseInt(readFile(`${_netIface.base}/${_netIface.iface}/statistics/rx_bytes`)),
      tx: parseInt(readFile(`${_netIface.base}/${_netIface.iface}/statistics/tx_bytes`)),
    } : null;

    await sleep(500);

    const t1 = readCpuTick();
    const cpu = calcCpu(_cpuPrev || t0, t1);
    _cpuPrev = t1;

    // Red — usar lecturas antes/después del sleep
    let net_down = null, net_up = null;
    if (netBefore && _netIface) {
      const rx2 = parseInt(readFile(`${_netIface.base}/${_netIface.iface}/statistics/rx_bytes`));
      const tx2 = parseInt(readFile(`${_netIface.base}/${_netIface.iface}/statistics/tx_bytes`));
      const el = 0.5;
      const fmt = v => {
        const mbps = Math.max(0, v * 8 / 1024 / 1000 / el);
        return mbps < 1 ? parseFloat(mbps.toFixed(1)) : Math.round(mbps);
      };
      net_down = fmt(rx2 - netBefore.rx);
      net_up   = fmt(tx2 - netBefore.tx);
    }

    const [docker, ups, version] = await Promise.all([getDocker(), getUps(), getVersionWithDev()]);

    const memory = getMemory();
    const { tempCpu, tempBoard, tempDisk } = getTemperatures();
    const { disk_util, disk_util_24h } = getDisk();
    const { disk_free_gb } = getDiskSpace();
    const uptime = parseInt(readFile('/proc/uptime')?.split(' ')[0]) || 0;
    const cp = getCheckProgress();
    const up = getUpdates();
    const hostname = process.env.HOSTNAME || os.hostname();

    _current = {
      hostname,
      version,
      timestamp:      new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      uptime_seconds: uptime,
      cpu,
      memory,
      temp_cpu:       tempCpu,
      temp_board:     tempBoard,
      temp_disk:      tempDisk,
      docker_running: docker.docker_running,
      docker_stopped: docker.docker_stopped,
      check_status:   cp.check_status,
      check_percent:  cp.check_percent,
      check_updates:  up.updates_pending,
      total_updates:  up.total_updates,
      check_last:     cp.check_last,
      prune_space:    cp.prune_space,
      ups:            ups.text,
      ups_state:      ups.state,
      net_down,
      net_up,
      disk_util,
      disk_util_24h,
      disk_free_gb,
    };
  } finally {
    _collecting = false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function loadSnapCache() {
  try {
    const cutoff = Date.now() / 1000 - 86400;
    const lines = (readFile(SNAP_CACHE) || '').split('\n').filter(Boolean);
    for (const line of lines) {
      const [ts, sumIo] = line.split(':').map(Number);
      if (ts >= cutoff && !isNaN(ts) && !isNaN(sumIo)) {
        _diskSnaps.push({ ts, sumIo });
      }
    }
  } catch {}
}

async function main() {
  // Cargar snapshots de disco previos para tener disk_util_24h desde el inicio
  loadSnapCache();

  // Precalentar iface
  detectIface();

  // Primera colección
  await collect();

  if (ONCE) {
    // Modo test SSH: imprimir JSON y salir
    console.log(JSON.stringify(_current, null, 2));
    process.exit(0);
  }

  // Modo servicio: loop de colección cada 2s
  setInterval(collect, 2000);

  // Servidor HTTP en puerto 5000 (igual que api_metrics.py)
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      const body = JSON.stringify(_current);
      res.writeHead(200, {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(5000, '0.0.0.0', () => {
    if (!ONCE) process.stderr.write('MetricsService escuchando en :5000\n');
  });
}

main().catch(e => { console.error(e); process.exit(1); });