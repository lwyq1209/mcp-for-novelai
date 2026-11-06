// Local stand-in for the NovelAI endpoints the client calls (electron/ipc/nai.ts): account, request-price, generate
// (t2i / i2i / inpaint / enhance), the stream preview, upscale, Director (augment-image), encode-vibe and
// suggest-tags. Answers with placeholder PNGs of the requested size in the same envelopes (ZIP, framed MessagePack),
// records every request, and injects faults on the N-th matching request: built-in failures, or a status code with a
// response body of your own (text or JSON, any content type), or a fixed custom answer for a class of requests (e.g.
// the account route with a chosen balance). Binds 127.0.0.1 only. Nothing is charged.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { hashString, imageSize, placeholderPng, zipStored } from './images.mjs';
import { clientRequire } from './paths.mjs';

let msgpack = null;
try { msgpack = clientRequire('@msgpack/msgpack'); } catch { msgpack = null; }

/** Endpoint name and classes of a request path. */
export function classify(method, pathname) {
  const route = {
    'GET /user/data': ['account', ['account']],
    'GET /user/subscription': ['subscription', ['account']],
    'POST /ai/generate-image': ['generate-image', ['generation', 'generate', 'paid']],
    'POST /ai/generate-image-stream': ['generate-image-stream', ['generation', 'generate', 'stream', 'paid']],
    'POST /ai/generate-image/request-price': ['request-price', ['price']],
    'POST /ai/upscale': ['upscale', ['generation', 'paid']],
    'POST /ai/augment-image': ['augment-image', ['generation', 'director', 'paid']],
    'POST /ai/encode-vibe': ['encode-vibe', ['vibe', 'paid']],
    'GET /ai/generate-image/suggest-tags': ['suggest-tags', ['suggest']],
  }[`${method} ${pathname}`];
  return route ? { endpoint: route[0], classes: route[1] } : { endpoint: 'unknown', classes: [] };
}

/** Whether a fault rule's `match` selects this request: any, a class, an endpoint name, or a path ("/…"). */
export function matches(match, request) {
  if (!match || match === 'any') return true;
  if (match.startsWith('/')) return request.path === match || request.path.startsWith(`${match}/`);
  return request.endpoint === match || request.classes.includes(match);
}

const FAULT_KINDS = ['status', 'respond', 'hang', 'reset', 'bad-zip', 'bad-image', 'empty-zip', 'delay', 'stream-cut', 'stream-error'];
// Headers the service computes itself; a rule cannot set them.
const RESERVED_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'content-type']);

function parseTimes(value) {
  if (value === undefined || value === null) return 1;
  if (value === 'always' || value === '*' || value === Infinity) return 'always';
  return Number(value);
}

/**
 * Normalizes a fault rule. Accepts an object {match, nth, kind, times, status, delayMs, body, json, contentType,
 * headers}, its JSON text, or the CLI form "<match>:<nth>:<kind>[:<times>]" where kind is a status code (500, 429,
 * 402 …), respond, hang, reset, bad-zip, bad-image, empty-zip, stream-cut, stream-error or delay=<ms>. nth counts
 * matching requests from when the rule was added (1 = the next one); the rule applies to `times` consecutive matching
 * requests (default 1; "always" = every one from the nth on).
 *
 * A status fault (4xx/5xx) and a `respond` rule (any status 200–599, default 200: a fixed custom answer, e.g. a
 * success body for the account route) may carry their own response: `body` (text sent as is) or `json` (any JSON
 * value, serialized), `contentType` (default application/json for json, text/plain; charset=utf-8 for body) and
 * `headers` (extra response headers). A status fault without a body answers {statusCode, message} as before.
 * `delayMs` on a status/respond rule waits that long before answering.
 */
export function parseFault(input) {
  let rule = input;
  if (typeof input === 'string' && input.trim().startsWith('{')) {
    try { rule = JSON.parse(input); } catch (error) { throw new Error(`A JSON fault rule does not parse: ${error.message}`); }
  } else if (typeof input === 'string') {
    const [match, nth, kind, times] = input.split(':');
    rule = { match, nth: Number(nth), kind, times: times === undefined ? 1 : times };
  }
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('A fault is "<match>:<nth>:<kind>[:<times>]", a JSON rule or an object.');
  let kind = String(rule.kind ?? '');
  let status = rule.status === undefined ? undefined : Number(rule.status);
  let delayMs = rule.delayMs === undefined ? undefined : Number(rule.delayMs);
  if (!kind && status !== undefined) kind = status >= 400 ? 'status' : 'respond';
  if (/^\d{3}$/.test(kind)) { status = Number(kind); kind = 'status'; }
  if (/^delay=\d+$/.test(kind)) { delayMs = Number(kind.slice(6)); kind = 'delay'; }
  if (!FAULT_KINDS.includes(kind)) throw new Error(`Unknown fault kind "${rule.kind}" (status code, ${FAULT_KINDS.filter(value => value !== 'status').join(', ')}).`);
  if (kind === 'respond' && status === undefined) status = 200;
  if (kind === 'status' && !(Number.isInteger(status) && status >= 400 && status <= 599)) throw new Error('A status fault needs a 4xx/5xx code.');
  if (kind === 'respond' && !(Number.isInteger(status) && status >= 200 && status <= 599)) throw new Error('A respond rule needs a status of 200–599.');
  if (kind === 'delay' && !(delayMs >= 0)) throw new Error('A delay fault needs delay=<ms>.');
  if (delayMs !== undefined && !(Number.isFinite(delayMs) && delayMs >= 0)) throw new Error('delayMs is a number of milliseconds (0 or more).');
  const nth = rule.nth === undefined ? 1 : Number(rule.nth), times = parseTimes(rule.times);
  if (!Number.isInteger(nth) || nth < 1 || (times !== 'always' && (!Number.isInteger(times) || times < 1))) throw new Error('nth is a positive integer; times is a positive integer or "always".');

  const custom = {};
  const hasBody = rule.body !== undefined && rule.body !== null, hasJson = Object.hasOwn(rule, 'json') && rule.json !== undefined;
  if (hasBody || hasJson || rule.contentType !== undefined || rule.headers !== undefined) {
    if (kind !== 'status' && kind !== 'respond') throw new Error('body, json, contentType and headers belong to a status fault or a respond rule.');
    if (hasBody && hasJson) throw new Error('Give body (text) or json (a JSON value), not both.');
    if (hasBody) {
      if (typeof rule.body !== 'string') throw new Error('body is text; use json for a JSON value.');
      custom.body = rule.body;
    }
    if (hasJson) {
      let text;
      try { text = JSON.stringify(rule.json); } catch (error) { throw new Error(`json cannot be serialized: ${error.message}`); }
      if (text === undefined) throw new Error('json must be a JSON value.');
      custom.json = rule.json;
    }
    if (rule.contentType !== undefined) {
      if (typeof rule.contentType !== 'string' || !rule.contentType.trim() || /[\r\n]/.test(rule.contentType)) throw new Error('contentType is a single-line media type such as text/html; charset=utf-8.');
      custom.contentType = rule.contentType.trim();
    }
    if (rule.headers !== undefined) {
      if (!rule.headers || typeof rule.headers !== 'object' || Array.isArray(rule.headers)) throw new Error('headers is an object of header names and values.');
      custom.headers = {};
      for (const [name, value] of Object.entries(rule.headers)) {
        const key = name.toLowerCase();
        if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key)) throw new Error(`"${name}" is not a header name.`);
        if (RESERVED_HEADERS.has(key)) throw new Error(`The header ${key} is set by the service${key === 'content-type' ? ' (use contentType)' : ''}.`);
        if (/[\r\n]/.test(String(value))) throw new Error(`The header ${key} must be on one line.`);
        custom.headers[key] = String(value);
      }
    }
  }
  return { match: String(rule.match || 'any'), nth, times, kind, ...(status !== undefined ? { status } : {}), ...(delayMs !== undefined ? { delayMs } : {}), ...custom };
}

/** The bytes, content type and headers of a status/respond rule's own response (null without one). */
function customResponse(rule) {
  if (rule.body === undefined && rule.json === undefined && rule.kind !== 'respond') return null;
  const bytes = Buffer.from(rule.json !== undefined ? JSON.stringify(rule.json) : rule.body ?? '', 'utf8');
  const contentType = rule.contentType ?? (rule.json !== undefined ? 'application/json' : 'text/plain; charset=utf-8');
  return { bytes, headers: { ...(rule.status === 429 ? { 'retry-after': '1' } : {}), ...(rule.headers ?? {}), 'content-type': contentType, 'content-length': String(bytes.length) } };
}

const STATUS_TEXT = { 400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };
const FAULT_MESSAGES = { 402: 'Insufficient Anlas (fake-novelai fault).', 429: 'Concurrent generation is locked (fake-novelai fault).', 500: 'Internal server error (fake-novelai fault).' };

/** Replaces long base64-looking strings by a summary so request logs stay small and never repeat image bytes. */
function summarize(value, depth = 0) {
  if (depth > 8) return '[depth]';
  if (typeof value === 'string') {
    if (value.length <= 300) return value;
    const compact = value.replace(/^data:[^;]+;base64,/, '');
    if (/^[A-Za-z0-9+/=\s]+$/.test(compact.slice(0, 2000))) {
      const bytes = Buffer.from(compact, 'base64');
      const size = imageSize(bytes);
      return { $base64: compact.length, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16), ...(size ? { image: size } : {}) };
    }
    return `${value.slice(0, 300)}…(${value.length})`;
  }
  if (Array.isArray(value)) return value.map(item => summarize(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, summarize(item, depth + 1)]));
  return value;
}

/** Minimal multipart/form-data parser: [{name, filename, contentType, data}]. */
export function parseMultipart(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!boundary) return [];
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const parts = [];
  let start = body.indexOf(marker);
  while (start >= 0) {
    const next = body.indexOf(marker, start + marker.length);
    if (next < 0) break;
    const part = body.subarray(start + marker.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    if (split >= 0) {
      const head = part.subarray(0, split).toString('utf8');
      const disposition = /content-disposition:[^\r\n]*/i.exec(head)?.[0] ?? '';
      parts.push({ name: /name="([^"]*)"/.exec(disposition)?.[1] ?? '', filename: /filename="([^"]*)"/.exec(disposition)?.[1], contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1], data: part.subarray(split + 4) });
    }
    start = next;
  }
  return parts;
}

function readBody(request, limit = 256 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    request.on('data', chunk => { size += chunk.length; if (size > limit) { reject(new Error('body too large')); request.destroy(); } else chunks.push(chunk); });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clampInt = (value, min, max, fallback) => { const number = Math.round(Number(value)); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; };

/**
 * The size an Enhance Max✨ request (upscaled_enhance) comes back with, as the official web client expects it (src/nai-dimensions.ts
 * maxEnhanceOutputSize): each side floored to 16 and doubled, fitted into 3,145,728 pixels in steps of 32.
 */
function maxEnhanceSize(width, height) {
  const w = Math.floor(width / 16) * 32, h = Math.floor(height / 16) * 32, scale = Math.min(1, Math.sqrt(3_145_728 / (w * h)));
  let outW = 32 * Math.round((w * scale) / 32), outH = 32 * Math.round((h * scale) / 32);
  if (outW * outH > 3_145_728) { outW = 32 * Math.floor((w * scale) / 32); outH = 32 * Math.floor((h * scale) / 32); }
  return { width: Math.max(32, outW), height: Math.max(32, outH) };
}

/** The size of the image a request asks for (generate: width×height, Enhance Max✨ about 2× of it; upscale: 2× the source; Director: the source). */
function outputSize(endpoint, payload) {
  if (endpoint === 'upscale') {
    const source = typeof payload?.image === 'string' ? imageSize(Buffer.from(payload.image, 'base64')) : null;
    return source ? { width: Math.min(8192, source.width * 2), height: Math.min(8192, source.height * 2) } : { width: 128, height: 128 };
  }
  if (endpoint === 'augment-image') return { width: clampInt(payload?.width, 1, 8192, 512), height: clampInt(payload?.height, 1, 8192, 512) };
  const parameters = payload?.parameters ?? {};
  const size = { width: clampInt(parameters.width, 1, 8192, 832), height: clampInt(parameters.height, 1, 8192, 1216) };
  return parameters.upscaled_enhance === true ? maxEnhanceSize(size.width, size.height) : size;
}

function placeholderFor(endpoint, payload, sample, size) {
  const parameters = payload?.parameters ?? {};
  const seed = Number.isFinite(Number(parameters.seed)) ? Number(parameters.seed) + sample : hashString(JSON.stringify(summarize(payload)).slice(0, 4000)) + sample;
  const comment = { fake: true, endpoint, action: payload?.action ?? endpoint, prompt: typeof payload?.input === 'string' ? payload.input.slice(0, 1000) : undefined, seed: parameters.seed, steps: parameters.steps, width: size.width, height: size.height, scale: parameters.scale, sampler: parameters.sampler, n_samples: parameters.n_samples, request_type: endpoint };
  return placeholderPng(size.width, size.height, { seed: seed >>> 0, text: { Title: 'fake-novelai placeholder', Software: 'NovelAI', Source: 'fake-novelai (MCP for NovelAI dev-tools)', Comment: JSON.stringify(comment) } });
}

function frame(message) {
  const encoded = msgpack.encode(message);
  const header = Buffer.alloc(4); header.writeUInt32BE(encoded.byteLength);
  return Buffer.concat([header, Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength)]);
}
function sseFrame(event, message) {
  return Buffer.from(`event: ${event}\ndata: ${JSON.stringify({ ...message, image: message.image ? Buffer.from(message.image).toString('base64') : undefined })}\n\n`);
}

/**
 * Starts the fake service. Options: port (0 = random), delayMs (time a generation takes, default 250), streamSteps
 * (intermediate preview frames, default 3), stepDelayMs (default 80), streamFormat msgpack|sse, price (request-price
 * answer, default 0), anlas (account balance, default 10000), chargePerImage (taken from the balance per image,
 * default 0), tier (3 = Opus), faults (rules for parseFault).
 */
export async function startFakeNovelAI(options = {}) {
  const host = '127.0.0.1';
  const config = { delayMs: 250, streamSteps: 3, stepDelayMs: 80, streamFormat: msgpack ? 'msgpack' : 'sse', price: 0, anlas: 10_000, chargePerImage: 0, tier: 3, ...Object.fromEntries(Object.entries(options).filter(([key, value]) => value !== undefined && !['port', 'faults'].includes(key))) };
  if (config.streamFormat === 'msgpack' && !msgpack) config.streamFormat = 'sse';
  const records = [];
  let seq = 0;
  let faultId = 0;
  const rules = [];
  const sockets = new Set();
  const hanging = new Set();
  const addFault = input => { const rule = { id: ++faultId, ...parseFault(input), seen: 0, applied: 0 }; rules.push(rule); return rule; };
  for (const fault of options.faults ?? []) addFault(fault);

  const account = () => ({
    subscription: { tier: config.tier, active: config.tier > 0, expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400, trainingStepsLeft: { fixedTrainingStepsLeft: Math.max(0, Math.round(config.anlas)), purchasedTrainingSteps: 0 }, perks: { unlimitedImageGeneration: config.tier === 3 } },
    information: { emailVerified: true, trialActivated: false },
    fake: true,
  });

  async function control(request, response, url) {
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    const body = ['POST', 'PUT', 'DELETE'].includes(request.method) ? await readBody(request, 1024 * 1024) : Buffer.alloc(0);
    let input = {};
    if (body.length) { try { input = JSON.parse(body.toString('utf8')); } catch { return send(400, { ok: false, error: 'JSON body expected' }); } }
    const route = `${request.method} ${url.pathname}`;
    if (route === 'GET /__fake/health') return send(200, { ok: true, service: 'fake-novelai', url: api.url, pid: process.pid, requests: records.length, config });
    if (route === 'GET /__fake/requests') {
      const since = Number(url.searchParams.get('since') ?? 0), endpoint = url.searchParams.get('endpoint'), cls = url.searchParams.get('class');
      return send(200, { ok: true, requests: records.filter(record => record.seq > since && (!endpoint || record.endpoint === endpoint) && (!cls || record.classes.includes(cls))) });
    }
    if (route === 'POST /__fake/reset') { records.length = 0; if (input.faults) rules.length = 0; for (const rule of rules) { rule.seen = 0; rule.applied = 0; } return send(200, { ok: true }); }
    if (route === 'GET /__fake/faults') return send(200, { ok: true, faults: rules });
    if (route === 'POST /__fake/faults') {
      try { const added = (Array.isArray(input.rules) ? input.rules : [input]).map(addFault); return send(200, { ok: true, added }); }
      catch (error) { return send(400, { ok: false, error: error.message }); }
    }
    if (route === 'DELETE /__fake/faults') { rules.length = 0; return send(200, { ok: true }); }
    if (route === 'POST /__fake/config') {
      for (const key of ['delayMs', 'streamSteps', 'stepDelayMs', 'price', 'anlas', 'chargePerImage', 'tier']) if (input[key] !== undefined) config[key] = Number(input[key]);
      return send(200, { ok: true, config });
    }
    if (route === 'POST /__fake/release') { const count = hanging.size; for (const socket of hanging) socket.destroy(); hanging.clear(); return send(200, { ok: true, released: count }); }
    return send(404, { ok: false, error: 'unknown control route' });
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (url.pathname.startsWith('/__fake/')) return control(request, response, url);
    const started = Date.now();
    const body = await readBody(request);
    const { endpoint, classes } = classify(request.method, url.pathname);
    const contentType = String(request.headers['content-type'] ?? '');
    const authorization = String(request.headers.authorization ?? '');
    let payload = null, parts = [];
    if (contentType.startsWith('multipart/form-data')) {
      parts = parseMultipart(body, contentType);
      const json = parts.find(part => part.name === 'request');
      try { payload = json ? JSON.parse(json.data.toString('utf8')) : null; } catch { payload = null; }
    } else if (contentType.includes('json') && body.length) {
      try { payload = JSON.parse(body.toString('utf8')); } catch { payload = null; }
    }
    const record = {
      seq: ++seq, at: new Date(started).toISOString(), method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), endpoint, classes,
      auth: authorization.startsWith('Bearer ') ? (authorization.slice(7).startsWith('fake-dev-tools-') ? 'fake-token' : 'other-token') : 'none',
      // Which token it was, without keeping it: the first 8 hex digits of its SHA-256 (tell two tokens apart in a log).
      authHash: authorization.startsWith('Bearer ') ? createHash('sha256').update(authorization.slice(7)).digest('hex').slice(0, 8) : null,
      contentType: contentType.split(';')[0], bytes: body.length,
      ...(parts.length ? { parts: parts.map(part => ({ name: part.name, filename: part.filename, contentType: part.contentType, bytes: part.data.length, ...(imageSize(part.data) ? { image: imageSize(part.data) } : {}) })) } : {}),
      body: payload ? summarize(payload) : null,
      response: null,
    };
    records.push(record);
    const finish = (status, kind, extra = {}) => { record.response = { status, kind, ms: Date.now() - started, ...extra }; };

    // Faults: every matching rule counts this request; the first one whose window covers it applies.
    let fault = null;
    for (const rule of rules) {
      if (!matches(rule.match, record)) continue;
      rule.seen++;
      if (!fault && rule.seen >= rule.nth && (rule.times === 'always' || rule.seen < rule.nth + rule.times)) { fault = rule; rule.applied++; }
    }
    if (fault) record.fault = { id: fault.id, kind: fault.kind, ...(fault.status ? { status: fault.status } : {}) };
    if (fault?.delayMs !== undefined) await sleep(fault.delayMs);
    const json = (status, value, kind = 'ok') => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); finish(status, kind); };
    const custom = fault && (fault.kind === 'status' || fault.kind === 'respond') ? customResponse(fault) : null;
    if (custom) {
      response.writeHead(fault.status, custom.headers);
      response.end(custom.bytes);
      return finish(fault.status, `${fault.kind === 'respond' ? 'respond' : 'fault'}:${fault.status}`, { custom: true, contentType: custom.headers['content-type'], bytes: custom.bytes.length });
    }
    if (fault?.kind === 'status') {
      if (fault.status === 429) response.setHeader('retry-after', '1');
      return json(fault.status, { statusCode: fault.status, message: FAULT_MESSAGES[fault.status] ?? `${STATUS_TEXT[fault.status] ?? 'Error'} (fake-novelai fault).` }, `fault:${fault.status}`);
    }
    if (fault?.kind === 'hang') { hanging.add(request.socket); request.socket.once('close', () => { hanging.delete(request.socket); if (!record.response) finish(null, 'fault:hang', { note: 'the client closed the connection' }); }); return; }
    if (fault?.kind === 'reset') { request.socket.destroy(); return finish(null, 'fault:reset'); }

    if (endpoint === 'unknown') return json(404, { statusCode: 404, message: `fake-novelai does not implement ${request.method} ${url.pathname}` }, 'unknown');
    if (endpoint === 'account' || endpoint === 'subscription') return json(200, endpoint === 'account' ? account() : account().subscription);
    if (endpoint === 'request-price') return json(200, { price: config.price, fake: true });
    if (endpoint === 'suggest-tags') return json(200, { tags: [] });
    if (endpoint === 'encode-vibe') {
      await sleep(config.delayMs);
      const bytes = createHash('sha512').update(body).digest();
      response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(bytes);
      return finish(200, 'ok', { bytes: bytes.length });
    }

    // Image endpoints.
    const samples = endpoint === 'generate-image' || endpoint === 'generate-image-stream' ? clampInt(payload?.parameters?.n_samples, 1, 8, 1) : 1;
    const size = outputSize(endpoint, payload);
    if (fault?.kind === 'bad-zip') { await sleep(config.delayMs); response.writeHead(200, { 'content-type': 'application/zip' }); response.end(Buffer.from('this is not a zip archive (fake-novelai fault)')); return finish(200, 'fault:bad-zip'); }
    if (fault?.kind === 'empty-zip') { await sleep(config.delayMs); response.writeHead(200, { 'content-type': 'application/zip' }); response.end(zipStored([])); return finish(200, 'fault:empty-zip'); }
    if (fault?.kind === 'bad-image') {
      await sleep(config.delayMs);
      const broken = Buffer.concat([placeholderPng(8, 8).subarray(0, 16), Buffer.from('corrupted image bytes (fake-novelai fault)')]);
      response.writeHead(200, { 'content-type': 'application/zip' }); response.end(zipStored([{ name: 'image_0.png', data: broken }])); return finish(200, 'fault:bad-image');
    }
    const images = Array.from({ length: samples }, (_, index) => placeholderFor(endpoint, payload, index, size));
    if (config.chargePerImage) config.anlas = Math.max(0, config.anlas - config.chargePerImage * images.length);
    const imageFacts = images.map(image => ({ ...imageSize(image), bytes: image.length }));

    if (endpoint === 'generate-image-stream') {
      const sse = config.streamFormat === 'sse';
      response.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/x-msgpack' });
      response.flushHeaders();
      const steps = Math.max(0, config.streamSteps);
      const previewSize = { width: Math.max(1, Math.round(size.width / 4)), height: Math.max(1, Math.round(size.height / 4)) };
      for (let step = 0; step < steps; step++) {
        await sleep(Math.max(0, Math.round(config.delayMs / Math.max(1, steps + 1))) + config.stepDelayMs);
        const preview = placeholderPng(previewSize.width, previewSize.height, { seed: (Number(payload?.parameters?.seed) || 7) + step * 13 });
        const message = { event_type: 'intermediate', samp_ix: 0, step_ix: step, gen_id: String(record.seq), sigma: 1 - step / Math.max(1, steps), image: preview };
        await new Promise(resolve => response.write(sse ? sseFrame('intermediate', message) : frame(message), resolve));
        if (fault?.kind === 'stream-cut') { await sleep(30); request.socket.destroy(); return finish(200, 'fault:stream-cut', { framesSent: step + 1 }); }
      }
      if (fault?.kind === 'stream-error') {
        const message = { event_type: 'error', message: 'fake-novelai stream error (fault)' };
        response.end(sse ? sseFrame('error', message) : frame(message));
        return finish(200, 'fault:stream-error');
      }
      await sleep(config.stepDelayMs);
      for (const [index, image] of images.entries()) {
        const message = { event_type: 'final', samp_ix: index, gen_id: String(record.seq), image };
        response.write(sse ? sseFrame('final', message) : frame(message));
      }
      response.end();
      return finish(200, 'ok', { images: imageFacts, stream: config.streamFormat });
    }

    await sleep(config.delayMs);
    const archive = zipStored(images.map((image, index) => ({ name: `image_${index}.png`, data: image })));
    if (fault?.kind === 'stream-cut') {
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(archive.length) });
      await new Promise(resolve => response.write(archive.subarray(0, Math.floor(archive.length / 2)), resolve));
      await sleep(30); request.socket.destroy();
      return finish(200, 'fault:stream-cut');
    }
    response.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(archive.length) });
    response.end(archive);
    return finish(200, 'ok', { images: imageFacts });
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch(error => {
      if (!response.headersSent) { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ statusCode: 500, message: `fake-novelai internal error: ${error.message}` })); }
      else response.destroy();
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.requestTimeout = 0; server.headersTimeout = 60_000; server.keepAliveTimeout = 5_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(options.port ?? 0), host, resolve); });
  const port = server.address().port;
  const api = {
    url: `http://${host}:${port}`, port, server, config,
    requests: (filter = {}) => records.filter(record => (!filter.endpoint || record.endpoint === filter.endpoint) && (!filter.class || record.classes.includes(filter.class)) && (!filter.since || record.seq > filter.since)),
    clear: ({ faults = false } = {}) => { records.length = 0; if (faults) rules.length = 0; },
    addFault, faults: () => rules.map(rule => ({ ...rule })), clearFaults: () => { rules.length = 0; },
    release: () => { for (const socket of hanging) socket.destroy(); hanging.clear(); },
    close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
  };
  return api;
}

/** Talks to a running fake service's control routes (for scripts in other processes). */
export function fakeNovelAIControl(url) {
  const base = String(url).replace(/\/+$/, '');
  const call = async (method, route, body) => {
    const response = await fetch(`${base}/__fake/${route}`, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok || value.ok === false) throw new Error(`fake-novelai ${route}: ${value.error ?? response.status}`);
    return value;
  };
  return {
    health: () => call('GET', 'health'),
    requests: (filter = {}) => call('GET', `requests?${new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`).then(value => value.requests),
    clear: (faults = false) => call('POST', 'reset', { faults }),
    addFault: rule => call('POST', 'faults', rule).then(value => value.added),
    faults: () => call('GET', 'faults').then(value => value.faults),
    clearFaults: () => call('DELETE', 'faults'),
    config: values => call('POST', 'config', values).then(value => value.config),
    release: () => call('POST', 'release'),
  };
}
