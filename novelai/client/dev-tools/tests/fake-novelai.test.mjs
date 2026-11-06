import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeNovelAIControl, parseFault, parseMultipart, startFakeNovelAI } from '../lib/fake-novelai-server.mjs';
import { imageSize, placeholderPng, unzip } from '../lib/images.mjs';
import { clientDir, clientRequire } from '../lib/paths.mjs';
import { ruleFromOptions } from '../fake-novelai.mjs';
import { runCliAsync, tempDir } from './helpers.mjs';

const JSZip = clientRequire('jszip');
const sharp = clientRequire('sharp');
const streamModule = path.join(clientDir, 'dist-electron', 'electron', 'ipc', 'nai-stream.js');
const TOKEN = { authorization: 'Bearer fake-dev-tools-test' };

async function withService(t, options = {}) {
  const service = await startFakeNovelAI({ delayMs: 0, stepDelayMs: 0, ...options });
  t.after(() => service.close());
  return service;
}
const post = (service, route, body, headers = {}) => fetch(`${service.url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...TOKEN, ...headers }, body: JSON.stringify(body) });
const generate = (width, height, extra = {}) => ({ input: '1girl', model: 'nai-diffusion-4-5-full', action: 'generate', parameters: { width, height, seed: 7, steps: 23, n_samples: 1, ...extra } });

/** The client's own ZIP reading (JSZip + image check, as electron/ipc/nai.ts extractImages). */
async function clientImages(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const out = [];
  for (const file of Object.values(zip.files).filter(entry => !entry.dir)) {
    const data = await file.async('nodebuffer');
    const meta = await sharp(data).metadata();
    out.push({ name: file.name, width: meta.width, height: meta.height });
  }
  return out;
}

test('binds 127.0.0.1 and answers the account and price routes', async t => {
  const service = await withService(t, { anlas: 4321, price: 17 });
  assert.match(service.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const account = await (await fetch(`${service.url}/user/data`, { headers: TOKEN })).json();
  assert.equal(account.subscription.tier, 3);
  assert.equal(account.subscription.trainingStepsLeft.fixedTrainingStepsLeft, 4321);
  assert.equal((await (await post(service, '/ai/generate-image/request-price', generate(512, 512))).json()).price, 17);
  assert.equal(service.requests()[0].auth, 'fake-token');
  // Which token, without keeping it: the first 8 hex digits of its SHA-256.
  assert.equal(service.requests()[0].authHash, createHash('sha256').update('fake-dev-tools-test').digest('hex').slice(0, 8));
  assert.ok(!JSON.stringify(service.requests()).includes('fake-dev-tools-test'));
});

test('generate-image returns a ZIP the client can read, one PNG per sample at the requested size', async t => {
  const service = await withService(t);
  for (const [width, height, samples] of [[832, 1216, 1], [512, 768, 2], [1024, 1024, 1]]) {
    const response = await post(service, '/ai/generate-image', generate(width, height, { n_samples: samples }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    const images = await clientImages(Buffer.from(await response.arrayBuffer()));
    assert.deepEqual(images.map(image => [image.width, image.height]), Array(samples).fill([width, height]));
  }
  // i2i / inpaint / enhance use the same route and the parameters' size; the source image is summarized in the log.
  const source = placeholderPng(64, 96).toString('base64');
  await post(service, '/ai/generate-image', { ...generate(640, 640), action: 'img2img', parameters: { ...generate(640, 640).parameters, image: source } });
  const record = service.requests({ endpoint: 'generate-image' }).at(-1);
  assert.equal(record.body.action, 'img2img');
  assert.deepEqual(record.body.parameters.image.image, { type: 'png', width: 64, height: 96 });
  assert.equal(typeof record.body.parameters.image.sha256, 'string');
  assert.equal(record.response.images[0].width, 640);
});

test('multipart generate (cached Director references) reads the request part', async t => {
  const service = await withService(t);
  const boundary = 'xyzBOUNDARY';
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="image"\r\nContent-Type: image/png\r\n\r\n`, placeholderPng(32, 32), '\r\n',
    `--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ ...generate(576, 832), parameters: { ...generate(576, 832).parameters, image: 'image' } })}\r\n`,
    `--${boundary}--\r\n`,
  ].map(part => Buffer.isBuffer(part) ? part : Buffer.from(part));
  const body = Buffer.concat(parts);
  assert.equal(parseMultipart(body, `multipart/form-data; boundary=${boundary}`).length, 2);
  const response = await fetch(`${service.url}/ai/generate-image`, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...TOKEN }, body });
  assert.deepEqual((await clientImages(Buffer.from(await response.arrayBuffer()))).map(image => [image.width, image.height]), [[576, 832]]);
  assert.deepEqual(service.requests().at(-1).parts.map(part => part.name), ['image', 'request']);
});

async function decodeStream(response, format) {
  const { NaiStreamFrameDecoder, NaiSseFrameDecoder } = clientRequire(streamModule);
  const decoder = format === 'sse' ? new NaiSseFrameDecoder() : new NaiStreamFrameDecoder();
  const frames = [];
  for await (const chunk of response.body) frames.push(...decoder.push(chunk));
  if (format === 'sse') frames.push(...decoder.finish());
  return frames;
}

for (const format of ['msgpack', 'sse']) {
  test(`generate-image-stream (${format}) decodes with the client's own stream decoder`, async t => {
    if (!fs.existsSync(streamModule)) return t.skip('client not built');
    const service = await withService(t, { streamFormat: format, streamSteps: 3 });
    const frames = await decodeStream(await post(service, '/ai/generate-image-stream', generate(832, 1216)), format);
    assert.deepEqual(frames.map(frame => frame.eventType), ['intermediate', 'intermediate', 'intermediate', 'final']);
    assert.deepEqual(frames.map(frame => frame.stepIndex ?? null).slice(0, 3), [0, 1, 2]);
    assert.deepEqual(imageSize(frames.at(-1).image), { type: 'png', width: 832, height: 1216 });
  });
}

test('an Enhance Max✨ img2img (upscaled_enhance) comes back at the size NovelAI\'s client expects, about 2× of the request', async t => {
  const service = await withService(t);
  const request = generate(832, 1216);
  const max = await post(service, '/ai/generate-image', { ...request, action: 'img2img', parameters: { ...request.parameters, image: placeholderPng(832, 1216).toString('base64'), strength: 0.2, upscaled_enhance: true } });
  assert.deepEqual((await clientImages(Buffer.from(await max.arrayBuffer()))).map(image => [image.width, image.height]), [[1440, 2144]]);
});

test('upscale doubles the source; Director keeps the given size; encode-vibe returns bytes; suggest-tags is empty', async t => {
  const service = await withService(t);
  const up = await post(service, '/ai/upscale', { image: placeholderPng(64, 96).toString('base64'), model: 'nai-diffusion-5-curated', declared_blur_sigma: 0 });
  assert.deepEqual((await clientImages(Buffer.from(await up.arrayBuffer()))).map(image => [image.width, image.height]), [[128, 192]]);
  const director = await post(service, '/ai/augment-image', { image: placeholderPng(80, 48).toString('base64'), width: 80, height: 48, req_type: 'lineart', defry: 0 });
  assert.deepEqual((await clientImages(Buffer.from(await director.arrayBuffer()))).map(image => [image.width, image.height]), [[80, 48]]);
  const vibe = await post(service, '/ai/encode-vibe', { image: 'AAAA', model: 'x' });
  assert.equal(vibe.headers.get('content-type'), 'application/octet-stream');
  assert.ok((await vibe.arrayBuffer()).byteLength > 0);
  assert.deepEqual(await (await fetch(`${service.url}/ai/generate-image/suggest-tags?model=x&prompt=a`, { headers: TOKEN })).json(), { tags: [] });
  const missing = await post(service, '/ai/not-there', {});
  assert.equal(missing.status, 404);
  assert.deepEqual(service.requests().map(record => record.endpoint), ['upscale', 'augment-image', 'encode-vibe', 'suggest-tags', 'unknown']);
});

test('fault rules: status codes on the N-th matching request, times, match by class/endpoint/path', async t => {
  const service = await withService(t, { faults: ['generation:2:500', 'upscale:1:402', '/user/data:1:429:2'] });
  assert.equal((await post(service, '/ai/generate-image', generate(64, 64))).status, 200);
  const failed = await post(service, '/ai/generate-image', generate(64, 64));
  assert.equal(failed.status, 500);
  assert.match((await failed.json()).message, /fake-novelai fault/);
  assert.equal((await post(service, '/ai/generate-image', generate(64, 64))).status, 200, 'only the 2nd one fails');
  // upscale is a generation too: it counts for the first rule (its 4th match, no longer failing) and fails its own.
  assert.equal((await post(service, '/ai/upscale', { image: placeholderPng(8, 8).toString('base64') })).status, 402);
  const limited = await fetch(`${service.url}/user/data`);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '1');
  assert.equal((await fetch(`${service.url}/user/data`)).status, 429);
  assert.equal((await fetch(`${service.url}/user/data`)).status, 200, 'times = 2');
  assert.deepEqual(service.faults().map(rule => [rule.seen, rule.applied]), [[4, 1], [1, 1], [3, 2]]);
  assert.deepEqual(service.requests().filter(record => record.fault).map(record => record.response.kind), ['fault:500', 'fault:402', 'fault:429', 'fault:429']);
});

test('fault rules: reset, hang (released by the client giving up), bad data and delays', async t => {
  const service = await withService(t);
  service.addFault('generate:1:reset');
  await assert.rejects(post(service, '/ai/generate-image', generate(64, 64)), /fetch failed|terminated|socket/i);
  service.addFault('generate:1:hang');
  const controller = new AbortController();
  const hung = post(service, '/ai/generate-image', generate(64, 64), {});
  const pending = fetch(`${service.url}/ai/generate-image`, { method: 'POST', headers: { 'content-type': 'application/json', ...TOKEN }, body: JSON.stringify(generate(64, 64)), signal: controller.signal });
  // The first request after the hang rule hangs; the second is normal (the rule applied once).
  assert.equal((await pending).status, 200);
  setTimeout(() => service.release(), 300);
  await assert.rejects(hung);
  controller.abort();
  service.addFault('generate:1:bad-zip');
  await assert.rejects(JSZip.loadAsync(Buffer.from(await (await post(service, '/ai/generate-image', generate(64, 64))).arrayBuffer())));
  service.addFault('generate:1:bad-image');
  const bad = unzip(Buffer.from(await (await post(service, '/ai/generate-image', generate(64, 64))).arrayBuffer()));
  assert.equal(bad.length, 1);
  await assert.rejects(sharp(bad[0].data).raw().toBuffer(), 'the client refuses an undecodable image');
  service.addFault('generate:1:empty-zip');
  assert.deepEqual(unzip(Buffer.from(await (await post(service, '/ai/generate-image', generate(64, 64))).arrayBuffer())), []);
  service.addFault('generate:1:delay=400');
  const started = Date.now();
  assert.equal((await post(service, '/ai/generate-image', generate(64, 64))).status, 200);
  assert.ok(Date.now() - started >= 380);
});

test('stream faults: cut mid-stream and an error frame', async t => {
  if (!fs.existsSync(streamModule)) return t.skip('client not built');
  const service = await withService(t, { streamSteps: 3, faults: ['stream:1:stream-cut', 'stream:2:stream-error'] });
  const cut = await post(service, '/ai/generate-image-stream', generate(64, 64));
  await assert.rejects(decodeStream(cut, 'msgpack'), /terminated|aborted|socket|other side closed/i);
  const frames = await decodeStream(await post(service, '/ai/generate-image-stream', generate(64, 64)), 'msgpack');
  assert.equal(frames.at(-1).error, 'fake-novelai stream error (fault)');
  assert.equal(frames.filter(frame => frame.eventType === 'final').length, 0);
});

test('control routes: requests, faults, reset and config from another process', async t => {
  const service = await withService(t);
  const control = fakeNovelAIControl(service.url);
  assert.equal((await control.health()).service, 'fake-novelai');
  await control.addFault({ match: 'generation', nth: 1, kind: '503' });
  assert.equal((await post(service, '/ai/generate-image', generate(64, 64))).status, 503);
  const requests = await control.requests({ class: 'generation' });
  assert.equal(requests.length, 1);
  assert.equal((await control.requests({ since: requests[0].seq })).length, 0);
  await control.config({ anlas: 5 });
  assert.equal((await (await fetch(`${service.url}/user/data`)).json()).subscription.trainingStepsLeft.fixedTrainingStepsLeft, 5);
  await control.clear(true);
  assert.deepEqual(await control.requests(), []);
  assert.deepEqual(await control.faults(), []);
});

test('parseFault accepts the documented forms and refuses the rest', () => {
  assert.deepEqual(parseFault('generation:1:500'), { match: 'generation', nth: 1, times: 1, kind: 'status', status: 500 });
  assert.deepEqual(parseFault('any:3:hang:2'), { match: 'any', nth: 3, times: 2, kind: 'hang' });
  assert.deepEqual(parseFault('upscale:1:delay=250'), { match: 'upscale', nth: 1, times: 1, kind: 'delay', delayMs: 250 });
  assert.deepEqual(parseFault('account:1:respond:always'), { match: 'account', nth: 1, times: 'always', kind: 'respond', status: 200 });
  assert.deepEqual(parseFault('{"match":"generation","kind":"503","body":"upstream says no"}'), { match: 'generation', nth: 1, times: 1, kind: 'status', status: 503, body: 'upstream says no' });
  assert.deepEqual(parseFault({ match: 'account', status: 200, json: { a: 1 }, headers: { 'X-Trace': 7 } }), { match: 'account', nth: 1, times: 1, kind: 'respond', status: 200, json: { a: 1 }, headers: { 'x-trace': '7' } });
  for (const bad of ['generation:0:500', 'generation:1:200', 'generation:1:explode', 'x:1:500:0', '{"match":', '[1]',
    { kind: 'hang', body: 'x' }, { kind: 500, body: 'x', json: {} }, { kind: 500, body: { a: 1 } }, { kind: 'respond', status: 101 },
    { kind: 500, contentType: 'text/plain\r\nx: y' }, { kind: 500, headers: { 'content-length': '1' } }, { kind: 500, headers: { 'content-type': 'x' } }, { kind: 500, headers: { 'bad name': 'x' } }, { kind: 500, headers: [] }])
    assert.throws(() => parseFault(bad), undefined, JSON.stringify(bad));
});

test('a status fault can carry its own body: text or JSON, any content type, extra headers', async t => {
  const service = await withService(t);
  service.addFault({ match: 'generation', kind: 500, body: 'Upstream GPU melted <b>(custom body)</b>', contentType: 'text/html; charset=utf-8' });
  const html = await post(service, '/ai/generate-image', generate(64, 64));
  assert.equal(html.status, 500);
  assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await html.text(), 'Upstream GPU melted <b>(custom body)</b>');
  service.addFault({ match: 'generate', kind: '400', json: { statusCode: 400, message: 'prompt rejected upstream' }, headers: { 'x-request-id': 'abc' } });
  const json = await post(service, '/ai/generate-image', generate(64, 64));
  assert.equal(json.status, 400);
  assert.equal(json.headers.get('content-type'), 'application/json');
  assert.equal(json.headers.get('x-request-id'), 'abc');
  assert.deepEqual(await json.json(), { statusCode: 400, message: 'prompt rejected upstream' });
  service.addFault({ match: 'generation', kind: 429, body: 'slow down' });
  const limited = await post(service, '/ai/generate-image', generate(64, 64));
  assert.deepEqual([limited.status, limited.headers.get('retry-after'), limited.headers.get('content-type'), await limited.text()], [429, '1', 'text/plain; charset=utf-8', 'slow down']);
  // The stream route answers the same custom error (the client reads it as the upstream text).
  service.addFault({ match: 'stream', kind: 502, body: 'bad gateway from the proxy' });
  const stream = await post(service, '/ai/generate-image-stream', generate(64, 64));
  assert.deepEqual([stream.status, await stream.text()], [502, 'bad gateway from the proxy']);
  assert.equal((await post(service, '/ai/generate-image', generate(64, 64))).status, 200, 'each rule applied once');
  assert.deepEqual(service.requests().filter(record => record.fault).map(record => [record.response.kind, record.response.custom, record.response.contentType]), [
    ['fault:500', true, 'text/html; charset=utf-8'], ['fault:400', true, 'application/json'], ['fault:429', true, 'text/plain; charset=utf-8'], ['fault:502', true, 'text/plain; charset=utf-8'],
  ]);
});

test('respond: a fixed custom answer for a class of requests (the account with a chosen balance)', async t => {
  const service = await withService(t);
  const account = { subscription: { tier: 3, active: true, trainingStepsLeft: { fixedTrainingStepsLeft: 1234, purchasedTrainingSteps: 56 } }, information: { emailVerified: true } };
  service.addFault({ match: 'account', kind: 'respond', json: account, times: 'always' });
  for (let index = 0; index < 3; index++) {
    const response = await fetch(`${service.url}/user/data`, { headers: TOKEN });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), account);
  }
  assert.equal(service.faults()[0].applied, 3, 'always: every matching request');
  // nth/times work as for faults; the price route answers a custom body twice, then the default again.
  service.addFault({ match: 'price', kind: 'respond', status: 200, json: { price: 99 }, times: 2, delayMs: 150 });
  const started = Date.now();
  assert.equal((await (await post(service, '/ai/generate-image/request-price', generate(64, 64))).json()).price, 99);
  assert.ok(Date.now() - started >= 140, 'delayMs waits before the custom answer');
  assert.equal((await (await post(service, '/ai/generate-image/request-price', generate(64, 64))).json()).price, 99);
  assert.equal((await (await post(service, '/ai/generate-image/request-price', generate(64, 64))).json()).price, 0);
  assert.deepEqual(service.requests({ endpoint: 'account' }).map(record => record.response.kind), ['respond:200', 'respond:200', 'respond:200']);
  // Through the control route (another process) a rule with a body round-trips.
  const control = fakeNovelAIControl(service.url);
  const [added] = await control.addFault({ match: 'upscale', kind: 503, body: 'maintenance', contentType: 'text/plain' });
  assert.deepEqual([added.kind, added.status, added.body, added.contentType], ['status', 503, 'maintenance', 'text/plain']);
  assert.equal(await (await post(service, '/ai/upscale', { image: placeholderPng(8, 8).toString('base64') })).text(), 'maintenance');
});

test('fault/respond CLI: --body, --json, --body-file, --content-type, --header, --times always', async t => {
  const service = await withService(t);
  const url = service.url;
  const dir = tempDir(t);
  const file = `${dir}/upstream.html`;
  fs.writeFileSync(file, '<html><body>Cloudflare: origin unreachable</body></html>');
  const added = await runCliAsync('fake-novelai.mjs', ['fault', '--url', url, '--match', 'generation', '--kind', '503', '--body-file', file, '--header', 'X-Upstream: cf']);
  assert.equal(added.status, 0, added.stdout);
  assert.deepEqual([added.json.added[0].status, added.json.added[0].contentType, added.json.added[0].headers], [503, 'text/html; charset=utf-8', { 'x-upstream': 'cf' }]);
  const failed = await post(service, '/ai/generate-image', generate(64, 64));
  assert.deepEqual([failed.status, failed.headers.get('x-upstream'), await failed.text()], [503, 'cf', '<html><body>Cloudflare: origin unreachable</body></html>']);

  const respond = await runCliAsync('fake-novelai.mjs', ['respond', '--url', url, '--match', 'account', '--json', '{"subscription":{"tier":3,"active":true,"trainingStepsLeft":{"fixedTrainingStepsLeft":777,"purchasedTrainingSteps":0}}}']);
  assert.equal(respond.status, 0, respond.stdout);
  assert.deepEqual([respond.json.added[0].kind, respond.json.added[0].times, respond.json.added[0].status], ['respond', 'always', 200]);
  for (let index = 0; index < 2; index++) assert.equal((await (await fetch(`${url}/user/data`)).json()).subscription.trainingStepsLeft.fixedTrainingStepsLeft, 777);

  const text = await runCliAsync('fake-novelai.mjs', ['fault', '--url', url, '--match', 'stream', '--kind', '500', '--body', '{"not":"parsed"}']);
  assert.equal(text.json.added[0].body, '{"not":"parsed"}', '--body is text as given');
  assert.equal(text.json.added[0].contentType, undefined);
  // Refusals before anything is sent.
  for (const args of [
    ['fault', '--url', url, '--match', 'generation', '--kind', '500', '--json', '{bad json'],
    ['fault', '--url', url, '--match', 'generation', '--kind', '500', '--body', 'a', '--json', '1'],
    ['fault', '--url', url, '--match', 'generation', '--kind', 'hang', '--body', 'x'],
    ['fault', '--url', url, '--match', 'generation', '--kind', '500', '--header', 'no colon'],
    ['respond', '--url', url, '--match', 'account', '--kind', '500'],
    ['fault', '--url', url, '--kind', '500'],
  ]) {
    const run = await runCliAsync('fake-novelai.mjs', args);
    assert.equal(run.status, 2, `${args.join(' ')} → ${run.stdout}`);
  }
  assert.equal(service.faults().length, 3, 'refused rules were not added');
  assert.throws(() => ruleFromOptions('fault', { match: 'x', kind: '500', 'body-file': `${dir}/missing.txt` }), { code: 'usage' });
});
