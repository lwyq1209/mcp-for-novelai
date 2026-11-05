import { splitPromptTags, parseWeightedTag } from '../../src/prompt-weight';
import type { HistoryTag, HistoryTagCoverage, HistoryTagSource } from '../../src/generated/library-contracts.mjs' with { 'resolution-mode': 'import' };
import type { LibraryPayload } from './types';
export const HISTORY_TAG_SOURCES:HistoryTagSource[]=['positive','style','character','user'];

/** Reuse the prompt editor's segment and brace handling. Numerical NAI
 * wrappers may span comma-separated segments; only their boundary markers
 * are removed, without interpreting ordinary words as artist categories. */
export function normalizeHistoryTag(value:string):string {
  let unweighted=value.normalize('NFKC').trim();
  for(;;){
    const next=parseWeightedTag(unweighted).core.replace(/^[{\[]+|[}\]]+$/g,'').trim().replace(/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)\s*::\s*/,'').replace(/\s*::$/,'').trim();
    if(next===unweighted)break;unweighted=next;
  }
  return unweighted.replace(/_/g,' ').replace(/\s+/g,' ').toLowerCase();
}
export function extractHistoryTags(payload:LibraryPayload):{tags:HistoryTag[];coverage:HistoryTagCoverage}{
  const tags:HistoryTag[]=[],seen=new Set<string>();
  const add=(text:unknown,source:HistoryTagSource,characterIndex?:number)=>{
    if(typeof text!=='string')return;
    for(const segment of splitPromptTags(text.replace(/，/g,','))){
      const tag=normalizeHistoryTag(segment);
      // Long prose remains in full-text search, not an unusable tag chip.
      if(!tag||tag.length>256)continue;
      const key=JSON.stringify([tag,source,characterIndex]);if(seen.has(key))continue;seen.add(key);
      tags.push({tag,source,...(characterIndex===undefined?{}:{characterIndex})});
    }
  };
  add(payload.params?.positivePrompt,'positive');add(payload.params?.stylePrompt,'style');
  if(Array.isArray(payload.characterPrompts))payload.characterPrompts.forEach((text:unknown,index:number)=>add(text,'character',index));
  // A user annotation is already an individual tag, even if its display
  // text contains punctuation. Do not rewrite the authored annotation.
  for(const value of Array.isArray(payload.annotation?.customTags)?payload.annotation.customTags:[]){
    if(typeof value!=='string')continue;const tag=normalizeHistoryTag(value);if(!tag)continue;
    const key=JSON.stringify([tag,'user',undefined]);if(seen.has(key))continue;seen.add(key);tags.push({tag,source:'user'});
  }
  return {tags,coverage:{positive:typeof payload.params?.positivePrompt==='string',style:typeof payload.params?.stylePrompt==='string',character:Array.isArray(payload.characterPrompts),user:true}};
}
