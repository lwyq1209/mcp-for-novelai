import type { LibraryItem } from './library/types';

export const canRestoreContent=(kind:LibraryItem['kind'])=>kind!=='history'&&kind!=='artist_favorite';

/** Authored contents are restored; organizational and file identities stay current. */
export function restoredContent(current:LibraryItem,previous:LibraryItem):Record<string,any>{
  const payload=structuredClone(current.payload),old=previous.payload;
  const fields:Partial<Record<LibraryItem['kind'],string[]>>={
    tag:['name','notes','tag','links'],combo:['name','notes','components','links'],note:['name','notes','links'],
    style_preset:['name','prompt'],positive_preset:['name','prompt'],prompt_chunk:['name','content'],
    reference_preset:['name','kind','infoExtracted','strength','preciseType','fidelity','informationExtracted'],
  };
  const now=new Date().toISOString();
  if(current.kind==='study'){
    payload.notes=old.notes;
    payload.study={...payload.study,name:old.study.name,revision:current.revision+1,updatedAt:now,archived:current.archived};
  }else{
    for(const key of fields[current.kind]??[])if(key in old)payload[key]=structuredClone(old[key]);else delete payload[key];
    if(['tag','combo','note'].includes(current.kind)){payload.revision=current.revision+1;payload.updatedAt=now;payload.archived=current.archived;}
    if(current.kind==='prompt_chunk')payload.updatedAt=now;
  }
  return payload;
}
