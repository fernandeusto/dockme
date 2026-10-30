// Used by the existing shell callbacks; credentials never appear in command lines.
import { readPeers, peerOrigin } from './security.js';

const [url, body] = process.argv.slice(2);
const token = readPeers()[peerOrigin(url)];
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Dockme-Peer': token } : {}) }, body
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    process.exit(0);
  } catch (error) {
    if (attempt === 2) { console.error(`No se pudo enviar el callback: ${error.message}`); process.exit(1); }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
