import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertLocalCoverIpcSize, MAX_LOCAL_COVER_BASE64_LENGTH } from './material-upload-guard';

describe('local-cover pre-IPC guard', () => {
  it('rejects oversized and non-string buffers before IPC while allowing bounded data', () => {
    expect(MAX_LOCAL_COVER_BASE64_LENGTH).toBe(27_962_028);
    for (const data of [undefined, null, {}, '', new Uint8Array(1), 'A'.repeat(MAX_LOCAL_COVER_BASE64_LENGTH + 1)]) expect(() => assertLocalCoverIpcSize('material_samples', {action:'set_local_cover',data})).toThrow('未发送到宿主');
    expect(() => assertLocalCoverIpcSize('material_samples', {action:'set_local_cover',data:'YQ=='})).not.toThrow();
    expect(() => assertLocalCoverIpcSize('material_samples', {action:'set_local_cover',data:'A'.repeat(MAX_LOCAL_COVER_BASE64_LENGTH)})).not.toThrow();
  });
  it('does not change existing other material calls', () => {
    for (const [method,action] of [['material_library','import'],['material_samples','set_cover'],['material_samples','cover'],['material_samples','clear_cover']]) expect(() => assertLocalCoverIpcSize(method,{action})).not.toThrow();
  });
  it('is wired before invoke in the existing preload material entrypoint', () => {
    const source = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8');
    expect(source.indexOf('assertLocalCoverIpcSize(method, args);')).toBeLessThan(source.indexOf("ipcRenderer.invoke('novelai:materials'"));
  });
});
