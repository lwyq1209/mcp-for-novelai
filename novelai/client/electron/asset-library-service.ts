import { createHistoryImageReader } from './asset-library-image';
import { extractHistoryTags, normalizeHistoryTag } from './library/history-tags';
import { createAssetThumbnailCache, describeAssetPreview } from './asset-library-preview';
import { canRestoreContent, restoredContent } from './asset-library-restore';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { activeLibraryPaths } from './library-runtime';
import { validateLibraryPayload, validateLibraryRequest } from './library/validation';
import type { LibraryRepository } from './library/repository';
import { LIBRARY_KINDS, knownCollectionNamespace, type LibraryKind, type LibraryItem } from './library/types';
import type { LibraryTrash, TrashActor } from './library-trash';
import { hostError, type HostErrorParams } from './host-error';
import { createLibraryWindow, WINDOW_LIBRARY_ACTIONS } from './library-window';
import type { BatchFacts } from '../src/library/image-facts';

/** An English message for MCP and the window's reason/params (src/host-errors/library.ts). */
const error = (code: string, message: string, reason?: string, params?: HostErrorParams): never => { throw hostError(code, message, reason, params); };
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : error('invalid_argument', 'An object argument is required.', 'library.object_required');
const identifier = (value: unknown): string => typeof value === 'string' && value.trim() && value.length <= 512 ? value : error('invalid_argument', 'Invalid item identity.', 'library.invalid_identity');
const kindOf = (value: unknown): LibraryKind => (LIBRARY_KINDS as readonly unknown[]).includes(value) ? value as LibraryKind : error('invalid_argument', 'Invalid item kind.', 'library.invalid_kind');
const revision = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : error('invalid_argument', 'The exact item revision is required.', 'library.revision_required');
const fields = (value: Record<string, any>, allowed: string[]) => { const unknown = Object.keys(value).filter(key => !allowed.includes(key)); if (unknown.length) error('invalid_argument', `Unsupported fields: ${unknown.join(', ')}.`, 'library.unsupported_fields', { fields: unknown.join(', ') }); };
export function createAssetLibraryService(options: {
  repository: LibraryRepository;
  material?: (args: Record<string, unknown>) => Promise<any>;
  study?: (args: Record<string, unknown>) => Promise<any>;
  toFileUrl?: (filePath: string) => string;
  /** Recently Deleted (library-trash.ts): delete, recently-deleted, restore and purge. */
  trash?: LibraryTrash;
  /** The queue's batches (agent names, manual batch modes), for the window list's mode and source filters. */
  batchFacts?: () => BatchFacts;
}) {
  const repo = options.repository;
  const missing = (kind: LibraryKind, id: string, message: string, reason: string): never => {
    const trashed = repo.trashEntryFor(kind, id);
    return trashed
      ? error('library_not_found', `This item is in Recently Deleted (trashId ${trashed.trashId}); restore it first.`, 'library.item_in_trash', { trashId: trashed.trashId })
      : error('library_not_found', message, reason);
  };
  const thumbnail = createAssetThumbnailCache();
  const readHistoryImage = createHistoryImageReader(repo);
  // A collection of a namespace this version does not know is not listed, and is not found by its id either.
  const collection = (value: unknown) => {
    const id = identifier(value), found = repo.collections().find(item => knownCollectionNamespace(item.namespace) && `${item.namespace}:${item.id}` === id);
    return found ?? error('library_not_found', 'This collection does not exist.', 'library.collection_not_found');
  };
  const checked = (value: Record<string, any>) => {
    const kind = kindOf(value.kind), id = identifier(value.id), item = repo.get(kind, id);
    if (!item) return missing(kind, id, 'This item does not exist.', 'library.item_not_found');
    if (item.revision !== revision(value.expectedRevision)) error('library_conflict', 'The item changed; read it again before saving.', 'library.item_changed');
    return item;
  };
  const update = (item: LibraryItem, patch: Record<string, any>, archived?: boolean) => {
    const allowed: Record<LibraryKind, string[]> = { tag:['name','group','notes'],combo:['name','group','notes'],note:['name','group','notes'],study:['name','notes'],history:['groupId'],artist_favorite:[],style_preset:['name','group','prompt'],positive_preset:['name','prompt'],prompt_chunk:['name','content','updatedAt'],reference_preset:['name','group','strength','infoExtracted','preciseType','fidelity','informationExtracted'] };
    if (Object.keys(patch).some(key => !allowed[item.kind].includes(key))) {
      const kind = item.kind, permitted = allowed[kind].join(', ');
      if (!permitted) error('invalid_argument', `${kind} update allows no fields (use its own editor).`, 'library.update_no_fields', { kind });
      if (kind === 'history') error('invalid_argument', `${kind} update only allows fields: ${permitted}. History cannot change name/group; to put it in a mixed collection use add-to-collection with the returned collectionId.`, 'library.update_fields_history', { kind, fields: permitted });
      if (['tag','combo','note','study'].includes(kind)) error('invalid_argument', `${kind} update only allows fields: ${permitted}. Put note prose in notes; edit the full content and source in the editor of the item.`, 'library.update_fields_notes', { kind, fields: permitted });
      error('invalid_argument', `${kind} update only allows fields: ${permitted}.`, 'library.update_fields', { kind, fields: permitted });
    }
    if (item.kind === 'history' && patch.groupId && !repo.collections('history').some(value => value.id === patch.groupId)) error('library_not_found', 'This history group does not exist.', 'library.history_group_not_found');
    if (['id','filePath','fileUrl','generationOrigin','image','previewImages','sections','source'].some(key => key in patch)) error('invalid_argument', 'Images, identity and source can only be changed through their own import or save entry points.', 'library.immutable_fields');
    const updatedAt = new Date().toISOString();
    let payload = { ...item.payload, ...patch };
    if (item.kind === 'study') payload = { ...item.payload, study: { ...item.payload.study, ...(patch.name === undefined ? {} : { name: patch.name }), revision: item.revision + 1, updatedAt, ...(archived === undefined ? {} : { archived }) }, notes: patch.notes ?? item.payload.notes };
    else if (['tag','combo','note'].includes(item.kind)) payload = { ...payload, revision: item.revision + 1, updatedAt, ...(archived === undefined ? {} : { archived }) };
    // Imported payloads may also carry a timestamp. The host owns this edit's
    // time so stale authored metadata cannot keep a new revision in old sort order.
    if (item.kind === 'prompt_chunk' || Object.hasOwn(payload, 'updatedAt')) payload = { ...payload, updatedAt };
    // Edits of imported records retain their original sparse generation parameters.
    validateLibraryPayload(item.kind, payload);
    return repo.put(item.kind, item.id, payload, { expectedRevision: item.revision, archived, updatedAt });
  };
  // The library page's own reads (library-window.ts), for the window's IPC only.
  const windowAction = createLibraryWindow({
    repository: repo, trash: options.trash, batchFacts: options.batchFacts, collection,
    read: (kind, id) => asset_library({ action: 'read', kind, id }),
  });
  /**
   * context.deletedBy: who deletes (the window: user; a bridge call: the agent), kept on each Recently Deleted entry.
   * context.window: the call came from the app window's own IPC (main.ts); only then are the window actions (ui-list,
   * ui-read, ui-archived, ui-trash-totals) offered. A bridge call (MCP) never sets it and gets "Unknown library action".
   */
  async function asset_library(raw: unknown, context: { deletedBy?: TrashActor; window?: boolean } = {}): Promise<any> {
    const args = record(raw);
    if (context.window === true && WINDOW_LIBRARY_ACTIONS.includes(args.action)) { validateLibraryRequest('asset_library_window', args); return windowAction(args); }
    if (['list','read'].includes(args.action)) validateLibraryRequest('asset_library_desktop', args);
    // purge {all:true} (empty Recently Deleted) is the desktop's own action; the public contract purges named trashIds only.
    if (['collections','mutate','image','recently-deleted','restore','purge'].includes(args.action) && args.command !== 'set-custom-tags') validateLibraryRequest(args.action === 'purge' && args.all !== undefined ? 'asset_library_desktop' : 'asset_library', args);
    if (['versions','thumbnail','restore-content','rename-collection','delete-collection','tag-suggestions'].includes(args.action) || (args.action==='mutate'&&args.command==='set-custom-tags')) validateLibraryRequest('asset_library_desktop', args);
    // The contract allows kind history (with assetId) or study (issue #2: its single registered original, no assetId).
    if (args.action === 'image') return readHistoryImage(args.kind === 'study'
      ? { kind:'study', id:identifier(args.id), revision:revision(args.revision), variant:args.variant }
      : { kind:'history', id:identifier(args.id), revision:revision(args.revision), assetId:identifier(args.assetId), variant:args.variant });
    if (args.action === 'list') {
      fields(args, ['action','query','kinds','collectionId','includeArchived','offset','limit','sortBy','sortDirection','historyTags','historyTagMatch','historyTagSources','queueRequestKey','queueBatchId']);
      const selected = args.collectionId ? collection(args.collectionId) : null;
      if (args.kinds !== undefined && (!Array.isArray(args.kinds) || args.kinds.length > LIBRARY_KINDS.length)) error('invalid_argument', 'Invalid kind filter.', 'library.invalid_kind_filter');
      const result = repo.list({ kinds: args.kinds?.map(kindOf), query: args.query, includeArchived: args.includeArchived, offset: args.offset, limit: args.limit, sortBy: args.sortBy, sortDirection: args.sortDirection, historyTags:args.historyTags,historyTagMatch:args.historyTagMatch,historyTagSources:args.historyTagSources, ...(args.queueRequestKey !== undefined ? { queueRequestKey: identifier(args.queueRequestKey) } : {}), ...(args.queueBatchId !== undefined ? { queueBatchId: identifier(args.queueBatchId) } : {}), ...(selected ? { collectionId: selected.id, collectionNamespace: selected.namespace } : {}) });
      const previews=repo.previewAssets(result.items);
      const matches=repo.historyTagMatches(result.items.filter(item=>item.kind==='history').map(item=>item.id),args.historyTags??[],args.historyTagSources,args.kinds?.length===1&&args.kinds[0]==='history'?args.query:undefined);
      return { ...result, items: result.items.map(item => {
        const preview=previews.get(JSON.stringify([item.kind,item.id]));
        return {...item,...(item.kind==='study'?{payload:{...item.payload,sections:undefined}}:{}),...(preview?{preview:describeAssetPreview(item,preview)}:{}),...(item.kind==='history'?{matchedTags:matches.get(item.id)??[]}:{})};
      }), revision: repo.getRevision() };
    }
    if (args.action === 'read') {
      fields(args, ['action','kind','id','revision']);
      const kind = kindOf(args.kind), id = identifier(args.id), item = repo.get(kind, id, args.revision === undefined ? undefined : revision(args.revision));
      if (!item) missing(kind, id, 'This item or revision does not exist.', 'library.item_or_revision_not_found');
      const assets = args.revision===undefined ? repo.itemAssets(kind,id) : repo.versionAssets(item!);
      const historyTags=kind==='history'?extractHistoryTags(item!.payload):null;
      // The current revision carries its preview exactly as list gives it (4c1 review rework, approved: MCP's read summary
      // projects it as image.preview). previewAssets chooses by the item's current links, so an older revision has none.
      const current = args.revision===undefined || repo.get(kind,id)?.revision===item!.revision;
      const preview = current ? repo.previewAssets([item!]).get(JSON.stringify([kind,id])) : undefined;
      return { item: preview ? { ...item!, preview: describeAssetPreview(item!, preview) } : item, assets: assets.map(asset => ({ ...asset.payload, id: asset.id, role:asset.role, ...(asset.payload.filePath && options.toFileUrl ? { fileUrl: options.toFileUrl(asset.payload.filePath) } : {}) })), links: repo.relations({ kind, id, revision: item!.revision }), memberships: repo.memberships(kind, id).filter(value => knownCollectionNamespace(value.namespace)), ...(historyTags?{tags:historyTags.tags,tagCoverage:historyTags.coverage}:{}) };
    }
    if (args.action === 'tag-suggestions') return {tags:repo.historyTagSuggestions(args.query,args.limit),revision:repo.getRevision()};
    if (args.action === 'versions') {
      const kind=kindOf(args.kind),id=identifier(args.id),item=repo.get(kind,id);
      if(!item)error('library_not_found','This item does not exist.', 'library.item_not_found');
      return {versions:repo.readVersions(kind,id).reverse().map(({revision,name,createdAt,updatedAt})=>({revision,name,createdAt,updatedAt})),currentRevision:item!.revision,canRestore:canRestoreContent(kind)};
    }
    if (args.action === 'thumbnail') {
      const kind=kindOf(args.kind),id=identifier(args.id),item=repo.get(kind,id,args.revision);
      if(!item)error('library_not_found','This item revision does not exist.', 'library.revision_not_found');
      // A current card may use an independently saved cover. Historical
      // cards use only the file descriptions recorded in that revision.
      const assets=repo.get(kind,id)?.revision===item!.revision?repo.itemAssets(kind,id):repo.versionAssets(item!);
      const asset=assets.find(value=>value.id===args.assetId);
      if(!asset)error('library_conflict','The item image changed; refresh to view it.', 'library.image_changed');
      return thumbnail(item!,asset!);
    }
    if (args.action === 'restore-content') {
      return repo.transaction(()=>{
        const current=checked(args);
        if(!canRestoreContent(current.kind))error('invalid_argument','Generation history and artist favorites can only be viewed; their generation facts cannot be rewritten.', 'library.restore_unsupported');
        const previous=repo.get(current.kind,current.id,args.revision);
        if(!previous)error('library_not_found','The revision to restore does not exist.', 'library.restore_revision_not_found');
        const payload=restoredContent(current,previous!);
        validateLibraryPayload(current.kind,payload);
        const item=repo.put(current.kind,current.id,payload,{expectedRevision:current.revision,archived:current.archived,createdAt:current.createdAt,updatedAt:new Date().toISOString(),source:current.source});
        // getRevision increments when this outer transaction commits.
        return {item,revision:repo.getRevision()+1};
      });
    }
    if (args.action === 'rename-collection') {
      return repo.transaction(()=>{
        if(revision(args.expectedRevision)!==repo.getRevision())error('library_conflict','The collections changed; refresh.', 'library.collections_changed');
        const selected=collection(args.collectionId),name=identifier(args.name).trim();
        if(selected.namespace!=='user')error('invalid_argument','Only user collections can be renamed here.', 'library.rename_user_only');
        if(repo.collections('user').some(value=>value.id!==selected.id&&value.name===name))error('library_conflict','A collection with this name exists; use a different name.', 'library.collection_name_taken');
        const result=repo.putCollection({...selected,name});
        return {collection:{...result,id:`${result.namespace}:${result.id}`},revision:repo.getRevision()+1};
      });
    }
    if (args.action === 'collections') { fields(args, ['action']); return { collections: repo.collections().filter(value => knownCollectionNamespace(value.namespace)).map(value => ({ ...value, id: `${value.namespace}:${value.id}` })), revision: repo.getRevision() }; }
    if (args.action === 'create-collection') {
      // The public contract has only action/name. Desktop preset editors keep
      // their existing namespace capability, checked by the allowlist below.
      const { namespace: _namespace, ...publicRequest } = args;
      validateLibraryRequest('asset_library', publicRequest);
      fields(args, ['action','name','namespace']); const name = identifier(args.name).trim(), namespace = args.namespace ?? 'user';
      if (!['user','style','reference','material','positive','chunk'].includes(namespace)) error('invalid_argument', 'This kind of system collection cannot be created.', 'library.system_collection_create');
      const existing = repo.collections(namespace).find(item => item.name === name);
      const result = existing ?? repo.putCollection({ namespace, id: namespace === 'user' ? randomUUID() : name, name, payload: {} });
      return { collection: { ...result, id: `${namespace}:${result.id}` }, revision: repo.getRevision() };
    }
    if (args.action === 'delete-collection') {
      repo.transaction(() => {
        const selected=collection(args.collectionId);
        if(selected.namespace==='user'&&args.expectedRevision===undefined)error('invalid_argument','Deleting a user collection requires the current list revision.', 'library.collection_revision_required');
        if(args.expectedRevision!==undefined&&revision(args.expectedRevision)!==repo.getRevision())error('library_conflict','The collections changed; refresh.', 'library.collections_changed');
        if(selected.namespace==='artist-favorites')error('invalid_argument','Built-in favorites cannot be deleted.', 'library.builtin_collection');
        for (const member of repo.memberships().filter(item => item.namespace === selected.namespace && item.collectionId === selected.id)) {
          const item = repo.get(member.kind, member.id); if (!item) continue;
          if (['material','style','reference'].includes(selected.namespace) && item.payload.group === selected.name) update(item, { group: '' });
          if (selected.namespace === 'history' && item.kind === 'history' && item.payload.groupId === selected.id) update(item, { groupId: undefined });
        }
        repo.deleteCollection(selected.namespace, selected.id);
      });
      return { revision: repo.getRevision() };
    }
    if (args.action === 'save') {
      fields(args, ['action','kind','id','payload','expectedRevision','collectionId']);
      const kind = kindOf(args.kind), payload = structuredClone(record(args.payload));
      if (['history','study','reference_preset'].includes(kind)) error('invalid_argument', 'Use the image import, generation or reference preset save entry point.', 'library.save_entry_point');
      if (['tag','combo','note'].includes(kind)) {
        if (!options.material) error('library_unavailable', 'The prompt material service is not ready.', 'library.material_unavailable');
        const selected = args.collectionId ? collection(args.collectionId) : null;
        if (selected && !['user','material'].includes(selected.namespace)) error('invalid_argument', 'This kind of item cannot go into that system collection.', 'library.collection_kind_mismatch');
        const { id: _id, revision: _revision, schemaVersion: _schema, archived: _archived, createdAt: _created, updatedAt: _updated, coverRevision: _coverRevision, cover: _cover, coverStatus: _coverStatus, ...entry } = payload;
        if (selected?.namespace === 'material') entry.group = selected.name;
        const result = await options.material!({ action: 'save', entry: { ...entry, kind }, ...(args.id ? { id: args.id, expectedRevision: args.expectedRevision } : {}) });
        if (selected?.namespace === 'user') {
          if (!repo.collections('user').some(value => value.id === selected.id)) return { item: repo.get(kind, result.entry.id), revision: repo.getRevision(), warning: 'The item was saved; its target collection was deleted during the save, so add it to a collection again.' };
          repo.setMembership({ namespace: selected.namespace, collectionId: selected.id, kind, id: result.entry.id });
        }
        return { item: repo.get(kind, result.entry.id), revision: repo.getRevision() };
      }
      if (kind === 'artist_favorite') {
        if (payload.image) { const history = repo.get('history', identifier(payload.image.id)); if (!history) error('library_not_found', 'Save the favorite image to history first.', 'library.favorite_image_not_saved'); payload.image = history!.payload; }
        payload.id ??= randomUUID();
      } else payload.id ??= args.id ?? randomUUID();
      const identity = kind === 'artist_favorite' ? `${payload.collection}:${payload.id}` : payload.id;
      const id = args.id ?? identity;
      if (id !== identity) error('invalid_argument', 'The item identity does not match the saved content.', 'library.identity_mismatch');
      const previous = repo.get(kind, identifier(id));
      const expectedRevision = args.expectedRevision === undefined ? 0 : revision(args.expectedRevision);
      if ((previous?.revision ?? 0) !== expectedRevision) error('library_conflict', 'The item exists or its revision changed; read it again.', 'library.save_conflict');
      // Preview paths may only be reused from existing owned records. New previews use their dedicated host service.
      if (payload.previewImages?.length && JSON.stringify(payload.previewImages) !== JSON.stringify(previous?.payload.previewImages)) {
        const roots = activeLibraryPaths(); if (!roots || !['style_preset','positive_preset'].includes(kind)) error('invalid_argument', 'Invalid preview image source.', 'library.preview_source');
        const storageId = `${kind === 'positive_preset' ? 'positive-prompt-' : ''}${id}`.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0,96);
        const directory = path.resolve(roots!.userDataRoot, 'style-prompt-previews', storageId);
        for (const image of payload.previewImages) {
          if (typeof image.filePath !== 'string' || path.dirname(path.resolve(image.filePath)) !== directory || fs.lstatSync(image.filePath).isSymbolicLink() || !fs.statSync(image.filePath).isFile()) error('invalid_argument', 'Preview images must come from the image save entry point of this preset.', 'library.preview_owner');
        }
      }
      const selected = args.collectionId ? collection(args.collectionId) : null;
      if (selected && kind === 'artist_favorite' && (selected.namespace !== 'artist-favorites' || selected.id !== payload.collection)) error('invalid_argument', 'The favorite source does not match the collection.', 'library.favorite_collection_mismatch');
      if (selected && selected.namespace !== 'user') {
        const permitted: Record<string, LibraryKind[]> = { style:['style_preset'],positive:['positive_preset'],chunk:['prompt_chunk'],'artist-favorites':['artist_favorite'] };
        if (!permitted[selected.namespace]?.includes(kind)) error('invalid_argument', 'This kind of item cannot go into that system collection.', 'library.collection_kind_mismatch');
        if (selected.namespace === 'style') payload.group = selected.name;
      }
      validateLibraryPayload(kind, payload);
      const item = repo.transaction(() => {
        const saved = repo.put(kind, id, payload, { expectedRevision, ...(!previous ? { source: { namespace: kind === 'artist_favorite' ? `artist-favorites:${payload.collection}` : kind, legacyId: payload.id, position: repo.all(kind).length } } : {}) });
        if (selected) repo.setMembership({ namespace: selected.namespace, collectionId: selected.id, kind, id });
        return saved;
      });
      return { item, revision: repo.getRevision() };
    }
    // Recently Deleted: deleting never refuses a referenced item; the receipt lists what it affected.
    if ((args.action === 'mutate' && ['delete','delete-archived'].includes(args.command)) || ['recently-deleted','restore','purge'].includes(args.action)) {
      const trash = options.trash ?? error('library_unavailable', 'Recently Deleted is not ready.', 'library.trash_unavailable');
      if (args.action === 'recently-deleted') { fields(args, ['action','query','offset','limit']); return trash.list({ query: args.query, offset: args.offset, limit: args.limit }); }
      if (args.action === 'restore') { fields(args, ['action','trashIds']); return trash.restore(args.trashIds); }
      if (args.action === 'purge') { fields(args, ['action','trashIds','all']); return trash.purge({ trashIds: args.trashIds, all: args.all === true }); }
      const deletedBy = context.deletedBy ? { deletedBy: context.deletedBy } : {};
      if (args.command === 'delete-archived') { fields(args, ['action','command','kinds','preview']); return trash.deleteArchived({ kinds: args.kinds?.map(kindOf), preview: args.preview === true, ...deletedBy }); }
      fields(args, ['action','command','items','collectionId','preview']);
      if (args.collectionId !== undefined) return trash.deleteCollection(identifier(args.collectionId), { preview: args.preview === true, ...deletedBy });
      return trash.deleteItems((args.items as unknown[]).map(value => { const item = record(value); return { kind: kindOf(item.kind), id: identifier(item.id), expectedRevision: revision(item.expectedRevision) }; }), { preview: args.preview === true, ...deletedBy });
    }
    if (args.action === 'mutate') {
      fields(args, ['action','command','items','collectionId','patch','tags']);
      if (!Array.isArray(args.items) || !args.items.length || args.items.length > 500) error('invalid_argument', 'Select 1–500 items.', 'library.selection_size');
      const selected = args.collectionId ? collection(args.collectionId) : null;
      const items = repo.transaction(() => {
        const current = args.items.map((value: unknown) => checked(record(value))) as LibraryItem[];
        if (new Set(current.map(item => `${item.kind}:${item.id}`)).size !== current.length) error('invalid_argument', 'The selection names an item twice.', 'library.selection_duplicate');
        if(args.command==='set-custom-tags'&&current.some(item=>item.kind!=='history'))error('invalid_argument','Custom image tags are only for generation history.', 'library.custom_tags_history_only');
        return current.map(item => {
          if(args.command==='set-custom-tags'){
            const tags:string[]=[],seen=new Set<string>();
            for(const value of args.tags as string[]){const normalized=normalizeHistoryTag(value);if(!normalized)error('invalid_argument','A tag cannot be only whitespace or weight brackets.', 'library.tag_blank');if(!seen.has(normalized)){seen.add(normalized);tags.push(value.trim());}}
            const payload={...item.payload,annotation:{...item.payload.annotation,customTags:tags}};
            validateLibraryPayload('history',payload);
            return repo.put('history',item.id,payload,{expectedRevision:item.revision,name:item.name,archived:item.archived,createdAt:item.createdAt,updatedAt:new Date().toISOString(),source:item.source});
          }
          if (args.command === 'archive') return update(item, {}, typeof args.patch?.archived === 'boolean' ? args.patch.archived : true);
          if (args.command === 'update') {
            return update(item, record(args.patch));
          }
          if (!selected || !['add-to-collection','remove-from-collection'].includes(args.command)) error('invalid_argument', 'Invalid collection operation.', 'library.invalid_collection_command');
          const permitted: Record<string, LibraryKind[]> = { history:['history'], style:['style_preset'], reference:['reference_preset'], material:['tag','combo','note'], positive:['positive_preset'],chunk:['prompt_chunk'],'artist-favorites':['artist_favorite'] };
          if (selected!.namespace !== 'user' && !permitted[selected!.namespace]?.includes(item.kind)) error('invalid_argument', 'This kind of item cannot go into that system collection.', 'library.collection_kind_mismatch');
          if (selected!.namespace === 'artist-favorites' && item.payload.collection !== selected!.id) error('invalid_argument', 'Create this kind of favorite with its artist tool.', 'library.artist_favorite_tool');
          if (['history','style','reference','material'].includes(selected!.namespace)) {
            const key = selected!.namespace === 'history' ? 'groupId' : 'group';
            if (args.command === 'add-to-collection') return update(item, { [key]: selected!.namespace === 'history' ? selected!.id : selected!.name });
            if (item.payload[key] === selected!.id || item.payload[key] === selected!.name) return update(item, { [key]: key === 'groupId' ? undefined : '' });
          }
          repo.setMembership({ namespace: selected!.namespace, collectionId: selected!.id, kind: item.kind, id: item.id }, args.command === 'add-to-collection');
          return item;
        });
      });
      return { items, revision: repo.getRevision() };
    }
    return error('invalid_argument', 'Unknown library action.', 'library.unknown_action');
  }
  return { asset_library };
}
