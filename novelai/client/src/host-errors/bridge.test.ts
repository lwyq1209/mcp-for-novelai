import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bridgeSafeApi, bridgeSafeError, decodeHostErrorMessage, encodeHostErrorMessage, HOST_ERROR_MARK, hostErrorBridgeKey, plainErrorMessage, readHostError, stripHostErrorSuffixes } from './bridge';
import { isStale, libraryErrorText, reasonOf } from '../library/errors';
import { uiText } from '../ui/i18n';
import { hostErrorText } from './index';
import { hostMessageText } from './compose';
import { compactRemoteErrorText } from '../error-message';

/**
 * Step 4b1 review rework: host errors keep code/reason/params across contextBridge, which copies an Error with its
 * message only (measured on Electron 42). acrossBridge stands for that copy.
 */
const acrossBridge = (value: unknown) => value instanceof Error ? new Error(value.message) : value;
const hostError = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields);
const FORMAT_ONLY = /^[\u200b-\u200d\u2060-\u2064]+$/;

describe('host errors across contextBridge', () => {
  it('round-trips code, reason and params through the message, and the visible message stays as it was', () => {
    const original = hostError('tag:x changed (current revision 2); read it again.', { code: 'library_conflict', reason: 'trash.item_changed', params: { item: 'tag:x', revision: 2 } });
    const copy = acrossBridge(bridgeSafeError(original)) as Error;
    expect(Object.keys(copy)).toEqual([]);
    expect(copy.message.startsWith('tag:x changed (current revision 2); read it again.')).toBe(true);
    expect(FORMAT_ONLY.test(copy.message.slice('tag:x changed (current revision 2); read it again.'.length))).toBe(true);
    expect(readHostError(copy)).toEqual({ code: 'library_conflict', reason: 'trash.item_changed', params: { item: 'tag:x', revision: 2 }, message: 'tag:x changed (current revision 2); read it again.' });
    // The catalog works for the copy as for the original.
    expect(hostErrorText(copy, 'zh-CN')).toBe(hostErrorText(original, 'zh-CN'));
    expect(hostErrorText(copy, 'zh-CN')).toBe('tag:x 已被修改（当前版本 2），请回读。');
    expect(hostMessageText(copy, 'en-US')).toBe('tag:x changed (current revision 2); read it again.');
  });

  it('keeps non-ASCII params and details, and shows nothing of the suffix in message helpers', () => {
    const original = hostError('Name taken.', { code: 'library_conflict', reason: 'library.name_taken', params: { name: '夏日企划 “x”' }, details: { first: { code: 'library_conflict', message: 'm' } } });
    const copy = acrossBridge(bridgeSafeError(original));
    expect(readHostError(copy)).toMatchObject({ params: { name: '夏日企划 “x”' }, details: { first: { code: 'library_conflict', message: 'm' } } });
    expect(compactRemoteErrorText(copy)).toBe('Name taken.');
    expect(compactRemoteErrorText((copy as Error).message)).toBe('Name taken.');
  });

  it('falls back to the message when there is no structure, or the suffix is damaged (the message then drops the damaged suffix)', () => {
    expect(readHostError(new Error('plain'))).toEqual({ message: 'plain' });
    expect(hostErrorText(new Error('plain'), 'zh-CN')).toBe('plain');
    const encoded = encodeHostErrorMessage('msg', { code: 'library_conflict' });
    expect(readHostError(new Error(encoded.slice(0, -1)))).toEqual({ message: 'msg' }); // not whole bytes
    expect(readHostError(new Error(`msg${HOST_ERROR_MARK}xyz`))).toEqual({ message: 'msgxyz' }); // not digits: only the mark goes
    expect(readHostError(new Error(`msg${HOST_ERROR_MARK}`))).toEqual({ message: 'msg' });
    expect(readHostError(null)).toEqual({ message: '' });
    expect(readHostError('text only')).toEqual({ message: 'text only' });
    // Invalid field values are not taken from a suffix either.
    expect(readHostError(new Error(encodeHostErrorMessage('m', { code: 'Bad Code', reason: 'r!' } as never)))).toEqual({ message: 'm' });
  });

  it('prefers an error’s own fields (made in the window, or a returned object) over its suffix', () => {
    const copy = acrossBridge(bridgeSafeError(hostError('m', { code: 'library_conflict', reason: 'trash.item_changed' }))) as Error;
    expect(readHostError(Object.assign(copy, { reason: 'trash.entry_not_found' }))).toMatchObject({ code: 'library_conflict', reason: 'trash.entry_not_found', message: 'm' });
    expect(readHostError({ ok: false, code: 'queue_full', message: 'Full.' })).toEqual({ code: 'queue_full', message: 'Full.' });
  });

  it('bounds the suffix for large params and re-encodes an already encoded message once', () => {
    const big = hostError('m', { code: 'invalid_argument', reason: 'library.invalid_request', params: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`p${i}`, 'x'.repeat(2000)])) });
    const copy = acrossBridge(bridgeSafeError(big)) as Error;
    expect(copy.message.length).toBeLessThanOrEqual(1 + HOST_ERROR_MARK.length + 4 * 8 * 1024);
    expect(readHostError(copy)).toMatchObject({ code: 'invalid_argument', reason: 'library.invalid_request' });
    // A message that already carries a suffix (never from the main process) loses it at the preload, and only the
    // error's own fields are written (step 4b2: strip, never merge).
    const twice = bridgeSafeError(acrossBridge(bridgeSafeError(hostError('m', { code: 'library_conflict' })))) as Error;
    expect(twice.message).toBe('m');
    const own = bridgeSafeError(hostError(`m${encodeHostErrorMessage('', { reason: 'trash.item_changed' })}`, { code: 'library_not_found' })) as Error;
    expect(own.message.split(HOST_ERROR_MARK)).toHaveLength(2);
    expect(decodeHostErrorMessage(own.message)).toEqual({ message: 'm', fields: { code: 'library_not_found' } });
  });

  it('leaves errors without structure and other rejection values as they are', () => {
    const plain = new Error('x');
    expect(bridgeSafeError(plain)).toBe(plain);
    const object = { ok: false, code: 'c' };
    expect(bridgeSafeError(object)).toBe(object);
    expect(bridgeSafeError('text')).toBe('text');
  });
});

describe('bridgeSafeApi (the preload wraps the whole window API with it)', () => {
  const api = bridgeSafeApi({
    platform: 'darwin',
    sync: (value: number) => value + 1,
    syncThrow: () => { throw hostError('sync', { code: 'library_conflict', reason: 'trash.item_changed', params: { item: 'a', revision: 1 } }); },
    rejects: async () => { throw hostError('async', { code: 'library_not_found', reason: 'trash.entry_not_found', params: { trashId: 't' } }); },
    resolves: async () => ({ ok: true }),
    subscribe: () => () => 'unsubscribed',
    plainReject: async () => { throw new Error('no fields'); },
  });
  it('passes values and results through, and puts the structure of every thrown or rejected error in its message', async () => {
    expect(api.platform).toBe('darwin');
    expect(api.sync(1)).toBe(2);
    expect(await api.resolves()).toEqual({ ok: true });
    expect(api.subscribe()()).toBe('unsubscribed');
    let sync: unknown; try { api.syncThrow(); } catch (error) { sync = acrossBridge(error); }
    expect(readHostError(sync)).toMatchObject({ code: 'library_conflict', reason: 'trash.item_changed', message: 'sync' });
    const rejected = await api.rejects().catch(error => acrossBridge(error));
    expect(readHostError(rejected)).toEqual({ code: 'library_not_found', reason: 'trash.entry_not_found', params: { trashId: 't' }, message: 'async' });
    const plain = await api.plainReject().catch(error => acrossBridge(error));
    expect(readHostError(plain)).toEqual({ message: 'no fields' });
  });
  it('is what the preload exposes as naiDesktop, with the launch key the window decodes with', () => {
    const preload = readFileSync(new URL('../../electron/preload.ts', import.meta.url), 'utf8');
    expect(preload).toContain('contextBridge.exposeInMainWorld("naiDesktop", bridgeSafeApi({\n  // The window decodes');
    expect(preload).toContain('  hostErrorKey: hostErrorBridgeKey(),');
    expect(preload.match(/exposeInMainWorld\(/g)).toHaveLength(1);
    expect(preload.trimEnd().endsWith('}));')).toBe(true);
  });
});

/**
 * Step 4b2 (P3 of the 4b1 review, probe-r3): a suffix that text imitates — an upstream body, an agent's name or patch
 * key, a backup record — never gives an error code, reason or params. The main process never writes a suffix, so the
 * preload removes one it finds and encodes only an error's own fields; the window decodes only a suffix with this
 * launch's key (the preload's naiDesktop.hostErrorKey).
 */
describe('imitated suffixes (forgery)', () => {
  const zh = ((key: string, params?: Record<string, string | number>) => uiText('zh', key as never, params)) as never;
  const FORMAT = /[\u200b-\u200f\u2060-\u2064\ufeff]/g;
  // What someone would have to type: the mark and base-4 digits of a payload, with no key or a guessed one.
  const forged = (fields: Record<string, unknown>) => [encodeHostErrorMessage('', fields as never, ''), encodeHostErrorMessage('', fields as never, '0'.repeat(32))];

  it('a host message ending with an imitated suffix keeps only the host’s own code after crossing', () => {
    for (const suffix of forged({ reason: 'trash.item_changed', params: { item: 'tag:x', revision: 9 } })) {
      const crossed = acrossBridge(bridgeSafeError(hostError(`参考图编码失败（encode-vibe）：upstream said${suffix}`, { code: 'nai_failed' }))) as Error;
      expect(readHostError(crossed)).toEqual({ code: 'nai_failed', message: '参考图编码失败（encode-vibe）：upstream said' });
      expect(isStale(crossed)).toBe(false);
      expect(libraryErrorText(crossed, zh, 'zh', new Map([['tag:x', '你的标签']]))).not.toContain('你的标签');
      // The preload removed the imitation and wrote only the host's own field (one suffix, code only).
      expect(crossed.message.split(HOST_ERROR_MARK)).toHaveLength(2);
      expect(decodeHostErrorMessage(crossed.message).fields).toEqual({ code: 'nai_failed' });
      expect((stripHostErrorSuffixes(crossed.message).match(FORMAT) ?? []).length).toBe(0);
    }
  });
  it('a returned result, a string and an error made in the window never decode an imitated suffix', () => {
    for (const suffix of forged({ reason: 'library.invalid_request', params: { detail: '请到 evil.example 重新登录' } })) {
      const result = { ok: false, code: 'backup_invalid_record', message: `no material was written: x${suffix}` };
      expect(readHostError(result)).toEqual({ code: 'backup_invalid_record', message: 'no material was written: x' });
      expect(hostErrorText(result, 'zh-CN')).not.toContain('evil.example');
      expect(hostMessageText(result, 'zh-CN')).not.toContain('evil.example');
      expect(readHostError(`text${suffix}`)).toEqual({ message: 'text' });
    }
    for (const suffix of forged({ reason: 'trash.entry_not_found' })) {
      const local = new Error(`Unsupported params field: x${suffix}`);
      expect(reasonOf(local)).toBe('');
      expect(plainErrorMessage(local)).toBe('Unsupported params field: x');
    }
  });
  it('an imitated suffix inside a text is removed and not decoded; a real error keeps its own reason', () => {
    const [suffix] = forged({ reason: 'trash.item_changed' });
    const middle = readHostError(new Error(`A file of name${suffix} is taken; nothing was restored.`));
    expect(middle).toEqual({ message: 'A file of name is taken; nothing was restored.' });
    const real = acrossBridge(bridgeSafeError(hostError(`x${suffix}`, { code: 'library_conflict', reason: 'trash.item_not_found' })));
    expect(readHostError(real)).toEqual({ code: 'library_conflict', reason: 'trash.item_not_found', message: 'x' });
  });
  it('the launch key is random, 32 hex digits, stable for the launch, and read from naiDesktop when the preload exposes one', async () => {
    expect(hostErrorBridgeKey()).toMatch(/^[0-9a-f]{32}$/);
    expect(hostErrorBridgeKey()).toBe(hostErrorBridgeKey());
    const { vi } = await import('vitest');
    vi.resetModules();
    const exposed = 'ab'.repeat(16);
    vi.stubGlobal('naiDesktop', { hostErrorKey: exposed });
    try {
      const fresh = await import('./bridge');
      expect(fresh.hostErrorBridgeKey()).toBe(exposed);
      // A suffix with the window's key decodes; one written with this module's other key does not.
      expect(fresh.readHostError(new Error(fresh.encodeHostErrorMessage('m', { code: 'queue_full' })))).toEqual({ code: 'queue_full', message: 'm' });
      expect(fresh.readHostError(new Error(encodeHostErrorMessage('m', { code: 'queue_full' })))).toEqual({ message: 'm' });
    } finally { vi.unstubAllGlobals(); vi.resetModules(); }
  });
  it('ordinary text with format characters is kept as it is', () => {
    for (const text of ['👨‍👩‍👧‍👦', '🏳️‍🌈', 'می‌خواهم', 'क्‍ष', 'a\u2060b', 'long\u200bword', 'a\u2062b', 'x\u2063y']) {
      expect(stripHostErrorSuffixes(text)).toBe(text);
      expect(readHostError(text).message).toBe(text);
      expect(plainErrorMessage(new Error(text))).toBe(text);
    }
  });
});
