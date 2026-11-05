// A local stand-in for this project's GitHub releases, for update rehearsals (dev-tools/update-rehearsal.mjs) and tests.
// Binds 127.0.0.1 only. It serves one release: the files of --dir, a SHA256SUMS.txt over them and its Ed25519 signature
// made with a THROWAWAY key (never the real update key), the latest-release API, and GitHub's download redirect:
//
//   GET /repos/lwyq1209/mcp-for-novelai/releases/latest            {tag_name, html_url, draft, prerelease}
//   GET /lwyq1209/mcp-for-novelai/releases/download/<tag>/<file>    302 → /__assets/<tag>/<file>?token=<random>
//   GET /__assets/<tag>/<file>                                      the file (Range requests honoured)
//   GET /__fake/health | /__fake/requests      POST /__fake/config {faults}      POST /__fake/reset
//
// Faults (all off by default; POST /__fake/config replaces them): latestTag (the API names another tag: a downgrade, the
// same version, or a newer tag serving this release's files — a replay), badSignature (the signature of another key),
// tamper (one byte of every file but SHA256SUMS.txt(.sig) changed after signing), slowBytesPerSecond, dropAfterBytes +
// dropTimes (the connection is cut after that many bytes of a file download, that many times or "always"),
// foreignRedirect (the download redirects to http://localhost:<port>, which the app must refuse), status (every asset
// request answers that HTTP status).
import { createHash, generateKeyPairSync, randomBytes, sign, createPrivateKey } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const REPOSITORY = 'lwyq1209/mcp-for-novelai';
const SIGNATURE_FILES = new Set(['SHA256SUMS.txt', 'SHA256SUMS.txt.sig']);

/** SHA256SUMS.txt for these files (sha256sum's format, names sorted as the release workflow does). */
export function checksumsText(dir, names) {
  return names.slice().sort().map(name => `${createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')}  ${name}\n`).join('');
}

export async function startFakeRelease({ dir, tag, privateKeyPem, port = 0, faults = {} }) {
  if (!/^v[0-9A-Za-z.-]+$/.test(tag)) throw new Error(`not a release tag: ${tag}`);
  const names = fs.readdirSync(dir).filter(name => fs.statSync(path.join(dir, name)).isFile() && !SIGNATURE_FILES.has(name) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name));
  const checksums = Buffer.from(checksumsText(dir, names));
  const key = createPrivateKey(privateKeyPem);
  const signature = Buffer.from(`${sign(null, checksums, key).toString('base64')}\n`);
  const otherSignature = Buffer.from(`${sign(null, checksums, generateKeyPairSync('ed25519').privateKey).toString('base64')}\n`);
  let config = { ...faults }, drops = 0;
  const requests = [];
  const fileBytes = name => {
    if (name === 'SHA256SUMS.txt') return checksums;
    if (name === 'SHA256SUMS.txt.sig') return config.badSignature ? otherSignature : signature;
    if (!names.includes(name)) return null;
    const bytes = fs.readFileSync(path.join(dir, name));
    if (config.tamper) { const copy = Buffer.from(bytes); copy[Math.floor(copy.length / 2)] ^= 0x5a; return copy; }
    return bytes;
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const entry = { at: new Date().toISOString(), method: request.method, path: url.pathname, range: request.headers.range ?? null, status: 0 };
    requests.push(entry);
    const send = (status, headers = {}, body = '') => { entry.status = status; response.writeHead(status, headers); response.end(body); };
    if (url.pathname === '/__fake/health') return send(200, { 'content-type': 'application/json' }, JSON.stringify({ ok: true, tag, files: names }));
    if (url.pathname === '/__fake/requests') return send(200, { 'content-type': 'application/json' }, JSON.stringify(requests));
    if (url.pathname === '/__fake/config' && request.method === 'POST') {
      let text = ''; request.on('data', chunk => { text += chunk; });
      request.on('end', () => { try { config = JSON.parse(text || '{}'); drops = 0; send(200, { 'content-type': 'application/json' }, JSON.stringify(config)); } catch { send(400); } });
      return undefined;
    }
    if (url.pathname === '/__fake/reset' && request.method === 'POST') { requests.length = 0; config = {}; drops = 0; return send(200); }
    if (url.pathname === `/repos/${REPOSITORY}/releases/latest`) {
      const latest = config.latestTag ?? tag;
      return send(200, { 'content-type': 'application/json' }, JSON.stringify({ tag_name: latest, html_url: `https://github.com/${REPOSITORY}/releases/tag/${latest}`, draft: false, prerelease: false, assets: names.map(name => ({ name })) }));
    }
    const download = new RegExp(`^/${REPOSITORY}/releases/download/([^/]+)/([^/]+)$`).exec(url.pathname);
    if (download) {
      const location = config.foreignRedirect ? `http://localhost:${server.address().port}/__assets/${download[1]}/${download[2]}` : `/__assets/${download[1]}/${download[2]}?token=${randomBytes(8).toString('hex')}`;
      return send(302, { location });
    }
    const asset = /^\/__assets\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (asset) {
      if (config.status && !SIGNATURE_FILES.has(asset[2])) return send(Number(config.status));
      // Every tag is served with this release's files (a replayed manifest names them).
      const bytes = fileBytes(asset[2]);
      if (!bytes) return send(404);
      let start = 0;
      const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? '');
      if (range && Number(range[1]) < bytes.length) start = Number(range[1]);
      const headers = { 'content-type': 'application/octet-stream', 'content-length': bytes.length - start, 'accept-ranges': 'bytes', ...(start ? { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}) };
      entry.status = start ? 206 : 200;
      response.writeHead(entry.status, headers);
      const body = bytes.subarray(start);
      const dropAt = !SIGNATURE_FILES.has(asset[2]) && config.dropAfterBytes && (config.dropTimes === 'always' || drops < Number(config.dropTimes ?? 1)) ? Number(config.dropAfterBytes) : null;
      const rate = Number(config.slowBytesPerSecond) || 0;
      if (!dropAt && !rate) { response.end(body); return undefined; }
      let sent = 0;
      const chunk = rate ? Math.max(1024, Math.floor(rate / 10)) : 64 * 1024;
      const pump = () => {
        if (response.destroyed) return;
        if (dropAt !== null && sent >= dropAt) { drops++; entry.dropped = sent; response.destroy(); return; }
        if (sent >= body.length) { response.end(); return; }
        const end = Math.min(body.length, sent + chunk, dropAt ?? Infinity);
        response.write(body.subarray(sent, end));
        sent = end;
        setTimeout(pump, rate ? 100 : 0);
      };
      pump();
      return undefined;
    }
    return send(404);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, tag, files: names, checksums: checksums.toString('utf8'),
    requests: () => requests.slice(),
    setFaults(next) { config = { ...next }; drops = 0; },
    async close() { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); },
  };
}
