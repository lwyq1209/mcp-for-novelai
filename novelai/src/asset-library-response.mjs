import { createHash } from 'node:crypto';
import { assetCategoryForKind } from './asset-library-categories.mjs';

/** AI-only projection. No host, workspace, I/O, image decoding or persistent cursor. */
export const ASSET_SUMMARY_BYTES = 12 * 1024;
export class AssetSummaryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new AssetSummaryError(code, message); };
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const integer = value => Number.isSafeInteger(value) && value >= 0;

// detail is an AI projection option, not an internal desktop/service option.
export function assetLibraryHostRequest(request) {
  const { detail: _detail, ...host } = request;
  return request.action === 'list' || request.action === 'recently-deleted' ? { ...host, limit: request.limit ?? 10 } : host;
}

function summarize(item) {
  if (!item || typeof item.kind !== 'string' || !item.kind || typeof item.id !== 'string' || !item.id || !integer(item.revision)) fail('invalid_response', 'The library returned an invalid material identity.');
  const truncated = [];
  const text = (value, maximum, field) => {
    if (typeof value !== 'string') return undefined;
    // slice first so a huge input never expands into a huge code-point array.
    const bounded = Array.from(value.slice(0, maximum * 2)).slice(0, maximum).join('');
    if (bounded.length < value.length) truncated.push(field);
    return bounded;
  };
  const p = object(item.payload);
  const image = item.kind === 'artist_favorite' ? object(p.image) : p;
  const params = object(image.params);
  const tags = (values, field) => {
    if (!Array.isArray(values)) return [];
    if (values.length > 6) truncated.push(field);
    return values.slice(0, 6).map(value => ({
      tag: text(value?.tag, 64, `${field}.tag`), source: text(value?.source, 24, `${field}.source`),
      ...(integer(value?.characterIndex) ? { characterIndex: value.characterIndex } : {}),
    }));
  };
  const preview = object(item.preview);
  // These are exact preview identities, never shortened or turned into a new image capability.
  const previewDescription = item.preview ? {
    assetId: typeof preview.assetId === 'string' ? preview.assetId : undefined,
    role: typeof preview.role === 'string' ? preview.role : undefined,
    cacheKey: typeof preview.cacheKey === 'string' ? preview.cacheKey : undefined,
    status: typeof preview.status === 'string' ? preview.status : undefined,
  } : undefined;
  const category = assetCategoryForKind(item.kind);
  if (!category) fail('invalid_response', 'The library returned an unknown material kind.');
  const result = {
    category, kind: item.kind, id: item.id, revision: item.revision,
    name: text(item.name, 96, 'name'), createdAt: text(item.createdAt, 40, 'createdAt'), updatedAt: text(item.updatedAt, 40, 'updatedAt'),
    archived: typeof item.archived === 'boolean' ? item.archived : undefined,
    source: text(item.source?.namespace, 64, 'source'),
    model: text(image.model ?? params.model, 64, 'model'),
    width: Number.isFinite(image.width ?? params.width) ? image.width ?? params.width : undefined,
    height: Number.isFinite(image.height ?? params.height) ? image.height ?? params.height : undefined,
    matchedTags: tags(item.matchedTags, 'matchedTags'),
    promptExcerpt: text(params.positivePrompt ?? p.prompt ?? p.content ?? p.tag?.text, 160, 'promptExcerpt'),
    image: { descriptionPresent: Boolean(item.preview), inspected: false, ...(previewDescription ? { preview: previewDescription } : {}) },
    summary: true, omitted: 'payload, parameters, characters, negatives, paths, image bytes and unknown fields',
  };
  return { result, truncated, tags };
}
const note = 'Metadata/excerpts only; not full text, image inspection or a restorable recipe.';
const budgetError = () => fail('asset_summary_too_large', 'One material identity/preview or the response envelope exceeds the summary budget. No item was consumed; narrow the query or explicitly read detail:full.');
function bounded(value, budget) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > budget) budgetError();
  // Tool details and MCP structuredContent are exactly the JSON shown in text.
  return JSON.parse(json);
}

export function assetLibraryResponse(request, response, { budgetBytes = ASSET_SUMMARY_BYTES } = {}) {
  if (!integer(budgetBytes) || budgetBytes > ASSET_SUMMARY_BYTES) fail('invalid_arguments', 'Invalid summary byte budget.');
  if (['list','read','image'].includes(request.action)) requireComplete(response);
  if (request.action === 'image') return historyImageResponse(request, response);
  if (request.action === 'list') {
    if (!Array.isArray(response?.items) || !integer(response.total) || !integer(response.revision)) fail('invalid_response', 'The library returned an incomplete page.');
    const offset = request.offset ?? 0, limit = request.limit ?? 10;
    const available = Math.max(0, response.total - offset);
    if ((response.offset !== undefined && response.offset !== offset) || response.items.length > limit || response.items.length > available || (!response.items.length && available)) fail('invalid_response', 'The library page cannot advance consistently.');
    // Do not relabel or post-filter an out-of-scope host page: that would hide
    // a broken selection and make total/nextOffset unsafe to continue from.
    if (request.kinds?.length && response.items.some(item => !request.kinds.includes(item?.kind))) fail('invalid_response', 'The library returned a material outside the selected kinds.');
    const items = [];
    const page = budgetTruncated => ({ detail: 'summary', summary: true, note, items,
      total: response.total, returned: items.length, offset, limit, hasMore: offset + items.length < response.total,
      nextOffset: offset + items.length < response.total ? offset + items.length : null,
      revision: response.revision, budgetBytes, budgetTruncated,
    });
    for (const item of response.items) {
      const summary = summarize(item);
      items.push({ ...summary.result, truncatedFields: [...new Set(summary.truncated)] });
      // Reserve the larger boolean spelling and the nextOffset representation.
      if (bytes(page(false)) > budgetBytes) {
        items.pop();
        if (!items.length) budgetError();
        return bounded(page(true), budgetBytes);
      }
    }
    return bounded(page(false), budgetBytes);
  }
  if (request.action === 'recently-deleted' || (request.action === 'mutate' && ['delete', 'delete-archived'].includes(request.command))) return trashResponse(request, response);
  if (request.action !== 'read') return response;
  // Exact identity is required for full as well as summary, even if a buggy
  // host returned a well-formed record for a different target.
  if (!response?.item || response.item.kind !== request.kind || response.item.id !== request.id || !integer(response.item.revision) || response.item.revision < 1 || (request.revision !== undefined && response.item.revision !== request.revision)) fail('invalid_response', 'The material does not match the requested identity/revision.');
  const detail = request.detail ?? (request.kind === 'history' ? 'summary' : 'full');
  if (detail === 'full') return { ...response, responseInfo: { detail: 'full', category: assetCategoryForKind(response.item.kind), truncated: false, recordBytes: bytes(response), note: 'Complete typed record; may exceed 12 KiB. Retain this exact revision for edits/reuse. Existing transport security redaction still applies.' } };
  const summary = summarize(response?.item);
  const tags = summary.tags(response.tags, 'tags');
  const count = key => Array.isArray(response[key]) ? response[key].length : 0;
  summary.result.image.descriptionPresent ||= count('assets') > 0;
  return bounded({ detail: 'summary', summary: true, note, item: { ...summary.result, truncatedFields: [...new Set(summary.truncated)] },
    tags, counts: { tags: count('tags'), assets: count('assets'), links: count('links'), memberships: count('memberships') },
    omitted: 'assets, links and memberships are counts only; use full for exact metadata', budgetBytes,
  }, budgetBytes);
}

// Recently Deleted pages and delete receipts: the host's compact shape, with the same derived category as list summaries.
function trashResponse(request, response) {
  const listing = request.action === 'recently-deleted', rows = listing ? response?.entries : response?.deleted;
  if (!response || typeof response !== 'object' || !Array.isArray(rows) || !integer(response.revision) || (listing && !integer(response.total))) fail('invalid_response', 'The library returned an incomplete Recently Deleted response.');
  const categorized = rows.map(row => { const category = row && typeof row.kind === 'string' ? assetCategoryForKind(row.kind) : undefined; return category ? { category, ...row } : row; });
  return { ...response, [listing ? 'entries' : 'deleted']: categorized };
}

// The host contract has no partial-page protocol. Never discard its failure
// markers and label the remaining rows (or an empty page) complete.
function requireComplete(response) {
  const present = value => value !== undefined && value !== null && value !== false && value !== '' && !(Array.isArray(value) && !value.length);
  if (response?.ok === false || response?.success === false || response?.incomplete === true || response?.complete === false || response?.isError === true || present(response?.partial) || response?.truncated === true || ['error','failed','failure','partial','incomplete','unavailable','warning','timeout'].includes(response?.status) || ['error','errors','warning','warnings'].some(key => present(response?.[key])))
    fail('asset_response_incomplete', 'The library marked this response incomplete or failed. No partial record/page was accepted; inspect the host state before continuing.');
}

// Both AI entrances consume this allowlist, not a generic image-shaped host
// object. Bytes occur only in `data`, which their native-image wrappers remove
// from text/details/structuredContent. HTTP itself remains a transport envelope.
// kind history: the requested registered original (assetId must echo the request).
// kind study (issue #2): the request has no assetId; the host names the study
// revision's single registered original, which must be a plain identifier.
function historyImageResponse(request, value) {
  const study = request.kind === 'study';
  const bad = () => fail('invalid_response', `The ${study ? 'study' : 'history'} image does not match the selected target or a valid bounded native attachment.`);
  const variant = request.variant ?? 'thumbnail';
  const mimeTypes = ['image/png','image/jpeg','image/webp','image/gif'];
  const positive = n => Number.isSafeInteger(n) && n > 0;
  const assetIdentity = study ? typeof value?.assetId === 'string' && value.assetId.length > 0 && value.assetId.length <= 512 && /\S/.test(value.assetId) : value?.assetId === request.assetId;
  if (!value || !['history','study'].includes(request.kind) || value.kind !== request.kind || value.id !== request.id || value.revision !== request.revision || !assetIdentity || value.role !== 'original' || value.variant !== variant || !mimeTypes.includes(value.mimeType) || !mimeTypes.includes(value.sourceMimeType)) bad();
  // EXIF orientation of the original, when the host reports one (study reads): 1–8 only.
  if (value.sourceOrientation !== undefined && !(Number.isSafeInteger(value.sourceOrientation) && value.sourceOrientation >= 1 && value.sourceOrientation <= 8)) bad();
  if (![value.width,value.height,value.sourceWidth,value.sourceHeight,value.byteLength,value.sourceByteLength].every(positive) || value.sourceWidth * value.sourceHeight > 32_000_000 || value.width * value.height > 32_000_000 || value.byteLength > 20*1024*1024 || value.sourceByteLength > 20*1024*1024) bad();
  if (variant === 'thumbnail' && (value.width > 384 || value.height > 384)) bad();
  if (variant === 'original' && (value.width !== value.sourceWidth || value.height !== value.sourceHeight || value.mimeType !== value.sourceMimeType || value.sha256 !== value.sourceSha256 || value.byteLength !== value.sourceByteLength)) bad();
  if (!['recorded-sha256','read-time-sha256'].includes(value.contentBinding) || typeof value.sha256 !== 'string' || typeof value.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) || !/^[a-f0-9]{64}$/.test(value.sourceSha256) || typeof value.data !== 'string' || value.data.length > Math.ceil(20*1024*1024/3)*4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) bad();
  const binary = Buffer.from(value.data,'base64');
  if (binary.length !== value.byteLength || binary.toString('base64') !== value.data || createHash('sha256').update(binary).digest('hex') !== value.sha256) bad();
  const magic = binary.subarray(0,8);
  const actualMime = magic.equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : binary[0]===255 && binary[1]===216 && binary[2]===255 ? 'image/jpeg' : binary.toString('ascii',0,4)==='RIFF' && binary.toString('ascii',8,12)==='WEBP' ? 'image/webp' : ['GIF87a','GIF89a'].includes(binary.toString('ascii',0,6)) ? 'image/gif' : null;
  if (actualMime !== value.mimeType) bad();
  return { kind:request.kind, id:request.id, revision:request.revision, assetId:study ? value.assetId : request.assetId, role:'original', variant,
    mimeType:value.mimeType, width:value.width, height:value.height, byteLength:value.byteLength, sha256:value.sha256,
    sourceMimeType:value.sourceMimeType, sourceWidth:value.sourceWidth, sourceHeight:value.sourceHeight, sourceByteLength:value.sourceByteLength, sourceSha256:value.sourceSha256,
    ...(value.sourceOrientation !== undefined ? { sourceOrientation:value.sourceOrientation } : {}),
    contentBinding:value.contentBinding, imageAttached:true, transformed:variant==='thumbnail', animated:false,
    data:value.data };
}
