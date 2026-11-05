import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { LibraryError, openLibraryRepository } from './repository';

/** Rebuild only derived metadata in an isolated startup worker. Old images are never read. */
export async function buildHistoryTagIndex(options: {databasePath:string;libraryDirectory:string;userDataRoot?:string;useWorker?:boolean;workerPath?:string}) {
  const probe=openLibraryRepository({filePath:options.databasePath,readOnly:true});
  try{if(probe.historyTagsReady())return {rebuilt:false};}finally{probe.close();}
  if(options.useWorker===false){const repo=openLibraryRepository({filePath:options.databasePath,libraryDirectory:options.libraryDirectory,userDataRoot:options.userDataRoot});try{return repo.rebuildHistoryTags();}finally{repo.close();}}
  return new Promise<{rebuilt:boolean}>((resolve,reject)=>{
    const worker=new Worker(options.workerPath??path.join(__dirname,'history-tag-index-worker.js'),{workerData:{...options,action:'history-tags'},resourceLimits:{maxOldGenerationSizeMb:512}});
    let result:{rebuilt:boolean}|undefined,error:Error|undefined;
    worker.once('message',message=>{if(message?.ok)result=message.result;else error=new LibraryError(message?.error?.code??'library_index_failed',message?.error?.message??'History tag indexing failed.');});
    worker.once('error',value=>{error=value;});
    worker.once('exit',code=>{if(code===0&&result&&!error)resolve(result);else reject(error??new LibraryError('library_index_failed','History tag index worker exited before completion.'));});
  });
}
