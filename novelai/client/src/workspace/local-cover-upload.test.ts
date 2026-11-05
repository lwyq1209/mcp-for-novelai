import { describe, expect, it, vi } from 'vitest';
import { LOCAL_COVER_MAX_BYTES, localCoverTargetKey, localCoverUploadRequest, validateLocalCoverFile } from './local-cover-upload';

const target = { id: 'tag-a', name: 'My tag', revision: 2, coverRevision: 3 };
describe('explicit local tag cover file selection', () => {
  it('requires a supported, nonempty, bounded file with a basename only', () => {
    for (const name of ['a.png', 'a.JPG', 'a.jpeg', 'a.webp', '本地图片.gif']) expect(() => validateLocalCoverFile({ name, size: 10, type: '' })).not.toThrow();
    for (const file of [
      {name:'bad.svg',size:10,type:'image/svg+xml'}, {name:'bad.json',size:10,type:'application/json'},
      {name:'../image.png',size:10,type:'image/png'}, {name:'C:\\image.png',size:10,type:'image/png'}, {name:'bad\u0000.png',size:10,type:'image/png'},
      {name:'a.png',size:0,type:'image/png'}, {name:'a.png',size:LOCAL_COVER_MAX_BYTES+1,type:'image/png'}, {name:'x'.repeat(256),size:10,type:'image/png'},
    ]) expect(() => validateLocalCoverFile(file)).toThrow();
  });
  it('encodes only selected bytes and freezes both tag and cover versions', async () => {
    const file = new File([new Uint8Array([0, 1, 128, 255])], 'image.png', { type: 'image/png' });
    expect(await localCoverUploadRequest(file, target)).toEqual({ action:'set_local_cover', entryId:'tag-a',revision:2,expectedCoverRevision:3,fileName:'image.png',data:'AAGA/w==' });
    expect(localCoverTargetKey(target)).toBe('tag-a:2:3');
    expect(localCoverTargetKey({...target,coverRevision:undefined})).toBe('tag-a:2:0');
  });
  it('retains selected identity even if caller state changes during a file read', async () => {
    let finish!: (data: ArrayBuffer) => void;
    const captured = {...target};
    const file = new File([new Uint8Array([1])], 'a.png', {type:'image/png'});
    vi.spyOn(file, 'arrayBuffer').mockImplementation(() => new Promise<ArrayBuffer>(resolve => { finish = resolve; }));
    const pending=localCoverUploadRequest(file,captured); captured.id='tag-b';captured.revision=99;
    finish(new Uint8Array([1]).buffer);
    expect(await pending).toMatchObject({entryId:'tag-a',revision:2,expectedCoverRevision:3});
  });
  it('does not proceed from a cancelled or size-changed read', async () => {
    const file = new File([new Uint8Array([1, 2])], 'a.png', {type:'image/png'});
    const read = vi.spyOn(file, 'arrayBuffer').mockResolvedValue(new Uint8Array([1]).buffer);
    const controller=new AbortController();controller.abort();
    await expect(localCoverUploadRequest(file,target,controller.signal)).rejects.toMatchObject({ reason: 'cover.local_cancelled' });expect(read).not.toHaveBeenCalled();
    await expect(localCoverUploadRequest(file,target)).rejects.toMatchObject({ reason: 'cover.local_changed' });
    let finish!: (data:ArrayBuffer)=>void;
    const next = new AbortController(), nextFile = new File([new Uint8Array([1])], 'a.png', {type:'image/png'});
    vi.spyOn(nextFile, 'arrayBuffer').mockImplementation(() => new Promise<ArrayBuffer>(resolve => { finish = resolve; }));
    const pending = localCoverUploadRequest(nextFile, target, next.signal);
    next.abort();finish(new Uint8Array([1]).buffer);await expect(pending).rejects.toMatchObject({ reason: 'cover.local_cancelled' });
  });
});
