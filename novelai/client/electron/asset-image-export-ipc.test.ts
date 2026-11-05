import { beforeEach, expect, it, vi } from 'vitest';
import { handleAssetImageExport } from './asset-image-export-ipc';
// The window reads a preload error through readHostError: code/reason/params travel in the message (contextBridge),
// under the preload's launch key; the test reads them with the bridge module instance the fresh preload loaded.
const mock=vi.hoisted(()=>({api:{} as Record<string,any>,invoke:vi.fn()}));
vi.mock('electron',()=>({contextBridge:{exposeInMainWorld:(_name:string,api:any)=>{mock.api=api;}},ipcRenderer:{invoke:mock.invoke},webUtils:{}}));
beforeEach(()=>{vi.resetModules();mock.invoke.mockReset();});
it('accepts only current mainFrame, rejecting iframe/other window/destroyed window before work',async()=>{
  const frame={},window={isDestroyed:()=>false,webContents:{id:7,mainFrame:frame}} as any;
  const run=vi.fn(async()=>({status:'cancelled',rows:[],stripMetadata:false,success:0,skipped:0,failed:0} as const));
  for(const [event,win] of [[{sender:{id:7},senderFrame:{}},window],[{sender:{id:8},senderFrame:frame},window],[{sender:{id:7},senderFrame:frame},null],[{sender:{id:7},senderFrame:frame},{...window,isDestroyed:()=>true}]] as any[]) expect((await handleAssetImageExport(event,win,{},run)).ok).toBe(false);
  expect(run).not.toHaveBeenCalled();const args={items:[{kind:'history',id:'a',revision:1}],stripMetadata:false};expect((await handleAssetImageExport({sender:{id:7},senderFrame:frame} as any,window,args,run)).ok).toBe(true);expect(run).toHaveBeenCalledWith(args);
});
it('preload forwards only dedicated IPC, propagates cancellation and never retries unknown responses',async()=>{
  await import('./preload');const { readHostError } = await import('../src/host-errors/bridge');const args={items:[{kind:'history',id:'a',revision:1}],stripMetadata:true};
  const cancelled={status:'cancelled',rows:[],stripMetadata:true,success:0,skipped:0,failed:0};mock.invoke.mockResolvedValueOnce({ok:true,result:cancelled});
  expect(await mock.api.exportAssetImages(args)).toEqual(cancelled);expect(mock.invoke).toHaveBeenLastCalledWith('novelai:assets:export-images',args);
  mock.invoke.mockResolvedValueOnce(undefined);expect(readHostError(await mock.api.exportAssetImages(args).catch((error:unknown)=>error))).toMatchObject({ code: 'image_export_failed', message: expect.stringContaining('unknown') });expect(mock.invoke).toHaveBeenCalledTimes(2);
  mock.invoke.mockResolvedValueOnce({ok:true,result:{status:'saved'}});expect(readHostError(await mock.api.exportAssetImages(args).catch((error:unknown)=>error))).toMatchObject({ code: 'image_export_failed', message: expect.stringContaining('unknown') });expect(mock.invoke).toHaveBeenCalledTimes(3);
});
