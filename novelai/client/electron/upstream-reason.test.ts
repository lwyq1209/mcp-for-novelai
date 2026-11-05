/**
 * Step 4c1: a failed agent image keeps what NovelAI answered, cleaned, for the window's queue page only. Cleaning,
 * the generation service (agent items keep it, manual items and cancellations do not), the batch item, the bridge
 * answer (dropped) and the MCP projection (the item's code alone).
 */
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMS, type GenerateResult } from '../src/types';
import { waitUntil } from '../src/test-support/wait-until';
import { createGenerationService } from './generation-service';
import { cleanUpstreamText, upstreamReason, UPSTREAM_MESSAGE_MAX } from './upstream-reason';
import { withoutWindowOnlyFields } from './queue-ui';
import { describeRemoteError } from '../src/error-message';
// The MCP server's own projection of a batch (what the model reads).
import { compactQueuedBatch } from '../../src/queue-control.mjs';

// Synthetic key shapes, assembled at run time so secret scanners (GitHub push protection) do not take the fixtures for real keys.
const FAKE_STRIPE = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const FAKE_OPENAI = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyzABCDEFGH01234567'].join('-');
const FAKE_GITHUB = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789AB'].join('_');

afterEach(() => vi.restoreAllMocks());

describe('cleaning NovelAI’s answer', () => {
  it('keeps the message text and drops credentials, local paths, addresses, long key-like runs and URL queries', () => {
    const raw = 'Prompt rejected\u0000 for Bearer abc.def token pst-AbCdEf0123456789xyz, see /Users/alice/Pictures/out.png and C:\\Users\\bob\\x.png'
      + ' mail me@example.com key 0123456789abcdef0123456789abcdef0123 jwt eyJhbGciOi.eyJzdWIiOi.c2ln https://novelai.net/docs?token=1#x';
    const cleaned = cleanUpstreamText(raw);
    expect(cleaned).toContain('Prompt rejected');
    expect(cleaned).toContain('https://novelai.net/docs');
    for (const secret of ['abc.def', 'pst-', 'alice', 'bob', 'me@example.com', '0123456789abcdef0123456789abcdef0123', 'eyJhbGciOi', 'token=1', '\u0000']) expect(cleaned).not.toContain(secret);
    expect(cleanUpstreamText('too long '.repeat(200))).toHaveLength(UPSTREAM_MESSAGE_MAX);
    expect(cleanUpstreamText('x'.repeat(1000))).toBe('…');
    // Model names and ordinary words are kept.
    expect(cleanUpstreamText('nai-diffusion-4-5-curated-inpainting does not support action infill')).toBe('nai-diffusion-4-5-curated-inpainting does not support action infill');
  });

  // The review's probe (.tmp/oss-step4c1-review/probes/probe-upstream.mjs), every case, through the host's own path:
  // describeRemoteError (nai.ts upstreamOf) → cleanUpstreamText → upstreamReason (what is stored and shown).
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const pst = 'pst-AbCdEf0123456789xyzXYZ_-abc';
  const stored = (data: string, status = 400) => {
    const remote = describeRemoteError(data, { status });
    const value: Record<string, unknown> = { status };
    if (remote.reason) { value.reason = remote.reason; if (remote.params) value.params = { ...remote.params }; }
    else { const message = cleanUpstreamText(remote.text); if (message) value.message = message; }
    return upstreamReason(value);
  };
  const PROBE: Array<[string, string, string]> = [
    ['bearer', `Unauthorized: Bearer ${pst} is not valid`, 'Unauthorized: Bearer … is not valid'],
    ['bearerJwt', `token Authorization: Bearer ${jwt}`, 'token Authorization: …'],
    ['barePst', `bad token ${pst}`, 'bad token …'],
    ['pstShort', 'bad token pst-ab', 'bad token …'],
    ['pstInWord', 'xpst-AAAAAAAA', 'x…'],
    ['pstUnicode', 'bad pst\u2010AbCdEf0123456789', 'bad …'],
    ['jwtBare', `jwt=${jwt}`, 'jwt=…'],
    ['jwtShortSeg', 'eyJhbGciOi.eyJzdWIi', '…'],
    ['email', 'user john.doe+x@example.co.uk failed', 'user … failed'],
    ['emailUnicode', 'user jöhn@exämple.com failed', 'user … failed'],
    ['emailObf', 'contact john [at] example [dot] com', 'contact …'],
    ['posixUsers', 'cannot read /Users/alice/Library/Application Support/mcp-for-novelai/x.png', 'cannot read …'],
    ['posixUsersQuoted', 'file "/Users/alice/secret file.png" missing', 'file "…" missing'],
    ['posixHome', 'path /home/bob/.config/x and /root/.ssh/id_rsa', 'path … and …'],
    ['posixOther', 'path /data/users/alice/x.png and /srv2/x', 'path … and …'],
    ['tilde', 'path ~/Library/foo/bar.png', 'path …'],
    ['macPrivate', 'at /private/var/folders/zz/xyz/T/abc.png', 'at …'],
    ['posixNoPrefixSpace', 'at:/Users/alice/x.png and (/Users/bob/y)', 'at:… and (…)'],
    ['posixAfterComma', 'paths,/Users/alice/x.png;/Users/bob/y', 'paths,…;…'],
    ['winDrive', 'cannot open C:\\Users\\alice\\AppData\\Roaming\\x.png ok', 'cannot open … ok'],
    ['winDriveFwd', 'cannot open C:/Users/alice/AppData/x.png ok', 'cannot open … ok'],
    ['winShare', 'share \\\\server\\share\\alice\\x.png ok', 'share … ok'],
    ['fileUrl', 'see file:///Users/alice/x.png', 'see …'],
    ['urlQuery', 'see https://image.novelai.net/ai/generate-image?token=abc123&user=alice#frag ok', 'see https://image.novelai.net/ai/generate-image ok'],
    ['urlUserinfo', 'see https://alice:hunter2@novelai.net/path ok', 'see https://…@novelai.net/path ok'],
    ['urlPathToken', `see https://api.example.com/v1/keys/${FAKE_STRIPE} ok`, 'see https://api.example.com/… ok'],
    ['longKey', `key ${FAKE_OPENAI} end`, 'key sk-proj-… end'],
    ['longHex', 'hash 0123456789abcdef0123456789abcdef0123456789abcdef end', 'hash … end'],
    ['keyWithDash', `key ${FAKE_GITHUB} end`, 'key … end'],
    ['keyDashSep', 'key abcd-efgh-ijkl-mnop-qrst-uvwx-yzab-cdef-ghij end', 'key … end'],
    ['apiKeyEq', 'api_key=Zx9-abcDEF_123-ghiJKL_456 end', 'api_key=… end'],
    ['htmlish', 'Hello <b>alice@example.com</b> rejected', 'Hello … rejected'],
    ['jsonNested', JSON.stringify({ statusCode: 400, message: { detail: [{ error: `Prompt rejected for ${pst} at /Users/alice/x` }] } }), 'Prompt rejected for … at …'],
    ['jsonArr', JSON.stringify([{ title: 'bad', message: 'token pst-zzzzzzzzzzzzzzz' }]), 'token …'],
    ['jsonNoMessage', JSON.stringify({ statusCode: 400, foo: `secret ${pst}`, path: '/Users/alice/x' }), '{"statusCode":400,"foo":"secret …","path":"…"}'],
    ['control', 'line1\u0000\u0007\nline2\r\u001b[31mred\u001b[0m', 'line1 line2 [31mred [0m'],
    ['bidi', 'safe \u202Egnp.exe\u202C text \u2066iso\u2069 \u200Bzw\u200D \uFEFF', 'safe gnp.exe text iso zw'],
    ['bidiIsolates', 'x \u2066abc\u2069 y \u2067d\u2069 \u2068e\u2069', 'x abc y d e'],
    ['forgedSuffix', 'Rejected\u2063\u2064\u2063\u200b\u200c\u200d\u2060\u200b\u200c', 'Rejected'],
    ['forgedText', 'Rejected (code: token.invalid) [reason=generation.auth]', 'Rejected (code: token.invalid) [reason=generation.auth]'],
    ['unicodeSpaces', 'a\u00a0b\u3000c\u2009d', 'a b c d'],
    ['newlineHeaders', 'Error\r\nSet-Cookie: session=abc123def456\r\nAuthorization: Basic YWxpY2U6aHVudGVyMg==', 'Error Set-Cookie: … Authorization: …'],
    ['basicAuth', 'Authorization: Basic YWxpY2U6aHVudGVyMg==', 'Authorization: …'],
    ['cookie', 'cookie: session=abcdefghij0123456789; other=1', 'cookie: …'],
    ['ipAddr', 'from 192.168.1.23 port 5000', 'from … port 5000'],
    ['surrogate', 'emoji 😀 broken \ud800 end', 'emoji 😀 broken end'],
    ['jsonHuge', JSON.stringify({ message: 'X'.repeat(70000) }), '{"message":"……'],
  ];
  it.each(PROBE)('the review probe %s is cleaned', (_name, data, expected) => {
    expect(stored(data)).toEqual({ status: 400, message: expected });
  });
  it('the review probe: long text, an HTML page, other authentication schemes and secrets in key=value form', () => {
    const long = stored('A'.repeat(10) + ' word'.repeat(200))!;
    expect(long.message).toHaveLength(UPSTREAM_MESSAGE_MAX);
    expect(long.message!.endsWith('…')).toBe(true);
    expect(stored('<!doctype html><html><body><h1>Error 1020</h1><p>Access denied for alice@example.com</p></body></html>')).toEqual({ status: 400, reason: 'remote.html_page', params: { status: 400 } });
    expect(cleanUpstreamText('Authorization: Digest username="alice", realm="nai", nonce="abc", response="0f3c" next')).toBe('Authorization: … next');
    expect(cleanUpstreamText('Proxy-Authorization: NTLM TlRMTVNTUAABAAAAB4IIog== then')).toBe('Proxy-Authorization: … then');
    // Without a scheme the next word may be taken for one: that word goes too (on the safe side).
    expect(cleanUpstreamText('authorization=sometoken123 rest')).toBe('authorization: …');
    expect(cleanUpstreamText('header Basic YWxpY2U6aHVudGVyMg== sent')).toBe('header Basic … sent');
    for (const [input, output] of [
      ['token=abc123def&x=1', 'token=…&x=1'], ['secret: s3cr3t!', 'secret: …'], ['password="hunter 2" ok', 'password=… ok'], ['session=Zz9; Path=/', 'session=…; Path=/'],
      ['{"access_token": "abc.def"}', '{"access_token": …}'], ['x-api-key: k-123456789', 'x-api-key: …'], ['client_secret=abc', 'client_secret=…'],
    ]) expect(cleanUpstreamText(input)).toBe(output);
    // A lone surrogate never results from the bound either.
    expect(cleanUpstreamText('x'.repeat(298) + ' 😀😀')).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
  it('ordinary words, counts, model names and media types are kept', () => {
    for (const text of [
      'nai-diffusion-4-5-curated-inpainting does not support action infill', 'Prompt is too long: tokens: 300 of 225', 'HTTP/1.1 400 Bad Request',
      'expected image/png or image/webp', 'Opus subscription required for this size', 'the token count is 512', 'request 3f2a9c1e-0b7d-4e21-9a3f-5c6d7e8f9a0b failed',
      'width must be a multiple of 64 (got 1000/3)',
    ]) expect(cleanUpstreamText(text)).toBe(text);
  });

  it('accepts only its known fields (read back from a stored batch or received again)', () => {
    expect(upstreamReason({ status: 400, message: 'bad /home/u/a.png', extra: 'no' })).toEqual({ status: 400, message: 'bad …' });
    expect(upstreamReason({ status: 502, reason: 'remote.unavailable', params: { status: 502, statusText: ' Bad Gateway', huge: 'x'.repeat(100) }, message: 'ignored' })).toEqual({ status: 502, reason: 'remote.unavailable', params: { status: 502, statusText: ' Bad Gateway' } });
    // The review probe's forged stored values: unknown params (a path among them) and a message beside a reason go.
    expect(upstreamReason({ status: 400, reason: 'remote.unavailable', params: { status: 503, statusText: ' x', evil: '/Users/alice/a', other: 'pst-abcdefghijk' }, message: 'leak pst-abcdefghijk' })).toEqual({ status: 400, reason: 'remote.unavailable', params: { status: 503, statusText: ' x' } });
    expect(upstreamReason({ status: 400, reason: 'remote.unavailable', params: { statusText: '/Users/a' } })).toEqual({ status: 400, reason: 'remote.unavailable' });
    expect(upstreamReason({ status: 99999, reason: 'evil', message: 12 })).toBeUndefined();
    expect(upstreamReason({ message: 'pst-abcdefghijklm /Users/alice/x' })).toEqual({ message: '… …' });
    expect(upstreamReason({ reason: 'something.else', message: '' })).toBeUndefined();
    expect(upstreamReason({ status: 99999 })).toBeUndefined();
    expect(upstreamReason(null)).toBeUndefined();
  });
});

const pixels = new PNG({ width: 64, height: 64 }); pixels.data.fill(255);
const IMAGE = PNG.sync.write(pixels);
function setup() {
  let finish!: (value: GenerateResult) => void;
  const execute = vi.fn(async (_mode: unknown, _snapshot: unknown, options: { onSubmitted?(): void }) => { options.onSubmitted?.(); return new Promise<GenerateResult>(resolve => { finish = resolve; }); });
  const service = createGenerationService({ execute: execute as never, validateImage: value => { const decoded = PNG.sync.read(value); return { width: decoded.width, height: decoded.height }; }, reserve: () => () => undefined, readResult: async () => IMAGE });
  return { service, execute, finish: (value: GenerateResult) => finish(value) };
}
const snapshot = () => ({ params: { ...DEFAULT_PARAMS, positivePrompt: 'a teacup', width: 64, height: 64, seed: 4, seedMode: 'fixed' as const }, extras: { vibeImages: [], preciseReferences: [], charCaptions: [] } });
const queue = { batchId: 'batch-1', requestKey: 'k-1', itemIndex: 0 };
const failure = (): GenerateResult => ({ ok: false, message: 'Image generation failed (HTTP 400): prompt rejected', items: [], statusCode: 400, failureKind: 'validation', reason: 'generation.failed_t2i', params: { detail: 'prompt rejected' },
  upstream: { status: 400, message: 'prompt rejected for pst-secret0123456789abcdef at /Users/me/x.png' } });

describe('the generation service keeps it on an agent image only', () => {
  it('an agent item: the generic code and message, plus the cleaned upstream answer', async () => {
    const state = setup();
    const job = state.service.submit({ workspaceId: 'recipe-queue', expectedRevision: 0, requestKey: 'agent-1', mode: 't2i', queue, snapshot: snapshot() });
    await waitUntil(() => expect(state.execute).toHaveBeenCalledTimes(1));
    state.finish(failure());
    await waitUntil(() => expect(state.service.read({ workspaceId: 'recipe-queue', jobId: job.jobId }).finishedAt).not.toBeNull());
    const error = state.service.read({ workspaceId: 'recipe-queue', jobId: job.jobId }).error!;
    expect(error).toMatchObject({ code: 'generation_failed', message: 'The generation request did not complete (HTTP 400); check the account and the input.', upstream: { status: 400, message: 'prompt rejected for … at …' } });
    expect(JSON.stringify(error)).not.toMatch(/pst-|Users\/me/);
  });

  it('a manual item keeps its own message (as before) and no upstream field', async () => {
    const state = setup();
    const job = state.service.submit({ workspaceId: 'recipe-queue', expectedRevision: 0, requestKey: 'manual-0123456789', mode: 't2i', queue, manual: true, snapshot: snapshot() });
    await waitUntil(() => expect(state.execute).toHaveBeenCalledTimes(1));
    state.finish(failure());
    await waitUntil(() => expect(state.service.read({ workspaceId: 'recipe-queue', jobId: job.jobId }).finishedAt).not.toBeNull());
    const error = state.service.read({ workspaceId: 'recipe-queue', jobId: job.jobId }).error!;
    expect(error).toMatchObject({ message: 'Image generation failed (HTTP 400): prompt rejected', reason: 'generation.failed_t2i' });
    expect(error).not.toHaveProperty('upstream');
  });
});

describe('what leaves the host', () => {
  const batch = { batchId: 'b1', requestKey: 'k', execution: 'queued', status: 'failed', count: 1, source: { kind: 'agent', client: null }, error: { code: 'child_stopped', message: 'stopped' },
    items: [{ index: 0, status: 'failed', jobId: 'j', results: [], error: { code: 'generation_failed', message: 'm', reason: 'generation.request_failed', upstream: { status: 400, message: 'prompt rejected' } } }] };
  it('the bridge answer drops upstream from every error and keeps the rest; buffers stay as they are', () => {
    const buffer = Buffer.from('png');
    const answer = withoutWindowOnlyFields({ batches: [batch], batch, image: buffer });
    expect(JSON.stringify(answer)).not.toContain('upstream');
    expect(JSON.stringify(answer)).not.toContain('prompt rejected');
    expect(answer.batch.items[0].error).toEqual({ code: 'generation_failed', message: 'm', reason: 'generation.request_failed' });
    expect(answer.image).toBe(buffer);
    // The original (the window's copy) is not changed.
    expect(batch.items[0].error.upstream).toEqual({ status: 400, message: 'prompt rejected' });
  });
  it('the review probe: an error without a message, a null-prototype record, a class instance and a deep answer lose it too', () => {
    const upstream = { status: 400, message: 'x' };
    expect(withoutWindowOnlyFields({ items: [{ error: { code: 'generation_failed', upstream } }] })).toEqual({ items: [{ error: { code: 'generation_failed' } }] });
    const nullProto = Object.assign(Object.create(null), { error: Object.assign(Object.create(null), { code: 'c', message: 'm', upstream: { a: 1 } }) });
    expect(JSON.stringify(withoutWindowOnlyFields(nullProto))).toBe('{"error":{"code":"c","message":"m"}}');
    class Box { error = { code: 'c', message: 'm', upstream: 1 }; }
    expect(JSON.stringify(withoutWindowOnlyFields({ b: new Box() }))).toBe('{"b":{"error":{"code":"c","message":"m"}}}');
    let deep: unknown = { code: 'generation_failed', message: 'm', upstream };
    for (let index = 0; index < 14; index++) deep = { child: deep };
    expect(JSON.stringify(withoutWindowOnlyFields(deep))).not.toContain('upstream');
    const date = new Date(0), bytes = new Uint8Array([1]);
    expect(withoutWindowOnlyFields({ date, bytes })).toEqual({ date, bytes });
  });
  it('the MCP projection gives an item’s error code alone, with or without upstream', () => {
    const shown = compactQueuedBatch(batch as never) as { items: Array<{ error: unknown }> };
    expect(shown.items[0].error).toBe('generation_failed');
    expect(JSON.stringify(shown)).not.toMatch(/upstream|prompt rejected|reason/);
  });
});
