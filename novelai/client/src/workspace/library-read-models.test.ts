// Review P3-1 (2026-11-01): the background error banner keeps a read model's
// failure until that read model itself reads successfully again.
import { describe, expect, it } from 'vitest';
import { CancelledError } from '@tanstack/react-query';
import { libraryReadModelErrorText, nextLibraryReadModelErrors, settleLibraryReadModels, type LibraryReadModelErrors, type LibraryReadModelRefresh } from './library-read-models';

const ok = (model: LibraryReadModelRefresh['model']): LibraryReadModelRefresh => ({ model, read: Promise.resolve() });
const failed = (model: LibraryReadModelRefresh['model'], message: string): LibraryReadModelRefresh => ({ model, read: Promise.reject(new Error(message)) });
const cancelled = (model: LibraryReadModelRefresh['model']): LibraryReadModelRefresh => ({ model, read: Promise.reject(new CancelledError()) });
async function after(previous: LibraryReadModelErrors, reads: LibraryReadModelRefresh[]) { return nextLibraryReadModelErrors(previous, await settleLibraryReadModels(reads)); }

describe('library read model errors', () => {
  it('an unrelated success or an untouched batch does not hide a history read failure; a history success does', async () => {
    let errors = await after({}, [ok('settings'), failed('history', 'SQLITE_BUSY')]);
    expect(libraryReadModelErrorText(errors)).toBe('SQLITE_BUSY');
    errors = await after(errors, [ok('settings')]);
    expect(libraryReadModelErrorText(errors)).toBe('SQLITE_BUSY');
    errors = await after(errors, []);
    expect(libraryReadModelErrorText(errors)).toBe('SQLITE_BUSY');
    // A superseded (cancelled) history read is neither success nor failure.
    errors = await after(errors, [cancelled('history')]);
    expect(libraryReadModelErrorText(errors)).toBe('SQLITE_BUSY');
    errors = await after(errors, [ok('history')]);
    expect(libraryReadModelErrorText(errors)).toBe('');
  });

  it('keeps simultaneous failures of different read models apart and joins distinct messages', async () => {
    let errors = await after({}, [failed('settings', '磁盘读取失败'), failed('history', '磁盘读取失败')]);
    expect(libraryReadModelErrorText(errors)).toBe('磁盘读取失败');
    errors = await after(errors, [failed('settings', '设置读取失败')]);
    expect(libraryReadModelErrorText(errors, 'zh-CN')).toBe('设置读取失败；磁盘读取失败');
    errors = await after(errors, [ok('history')]);
    expect(libraryReadModelErrorText(errors)).toBe('设置读取失败');
    const unknown = await settleLibraryReadModels([{ model: 'history', read: Promise.reject('not an error') }]);
    expect(libraryReadModelErrorText(unknown, 'zh-CN')).toBe('素材变化回读失败，请刷新核对。');
    // Step 4c1: rendered when shown, in the interface language (an English window shows no Chinese).
    expect(libraryReadModelErrorText(unknown, 'en-US')).toBe('The library changed but reading it again failed; refresh to check.');
    const host = await settleLibraryReadModels([{ model: 'settings', read: Promise.reject(Object.assign(new Error('The library is not open.'), { code: 'library_unavailable', reason: 'library.material_unavailable' })) }]);
    expect(libraryReadModelErrorText(host, 'en-US')).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
