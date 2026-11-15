/**
 * What the tools return to an agent: the answers of the queue, library and tag modules reduced to what the caller
 * does not already know (the same rule as the prepare_recipe readback, src/recipe-queue.mjs compactReadback).
 *
 * Pure projections of complete answers: no host call, no I/O. The modules behind them keep returning their whole
 * answers, which the tests of those modules read through the server option `wholeResults` (createToolContext); no
 * tool argument reaches it. Left out everywhere: values the call itself wrote (its batchId, its recipe identities,
 * its output names), identifiers only the host uses (its request key, plan hash, job ids, cache keys), zero counts,
 * and fields that only restate a default.
 */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
/** `fields` without undefined and null values. */
const present = fields => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));
const nonZero = counts => record(counts) ? Object.fromEntries(Object.entries(counts).filter(([, value]) => value !== 0 && value !== null)) : undefined;
const ENDED = new Set(['succeeded', 'partial', 'cancelled', 'blocked']);

// ------------------------------------------------------------------ queue
/** One saved image: where it is in the batch, its history identity, the seed it was made with and its file. */
const savedImage = result => present({ itemIndex: result.itemIndex, ...(result.index ? { index: result.index } : {}), historyId: result.historyId, actualSeed: result.actualSeed, fileName: result.fileName, file: result.file });

/**
 * read_queue: the batch's status, the images per status, every saved image, and every image that is not simply
 * waiting or done (running, failed, unknown, cancelled, skipped) with its error code. Its place in the queue only
 * while it has not ended.
 */
export function compactBatch(batch) {
  if (!record(batch) || typeof batch.batchId !== 'string') return batch;
  const saved = new Set(list(batch.results).map(result => result.itemIndex));
  const others = list(batch.items).filter(item => !['pending', 'succeeded'].includes(item.status) || (item.status === 'succeeded' && !saved.has(item.index)) || item.error || item.rateLimitRetries)
    .map(item => present({ itemIndex: item.index, status: item.status, error: item.error, rateLimitRetries: item.rateLimitRetries }));
  const ended = ENDED.has(batch.status) || batch.cleaned === true;
  return present({
    batchId: batch.batchId, status: batch.status, stopReason: batch.stopReason, count: batch.count,
    ...(batch.source?.kind === 'manual' ? { source: 'manual' } : {}),
    ...(batch.cleaned === true ? { cleaned: true, cleanedAt: batch.cleanedAt, ...(batch.recovered === true ? { recovered: true, savedImages: batch.savedImages } : {}) } : {}),
    itemCounts: nonZero(batch.itemCounts),
    ...(list(batch.results).length ? { results: batch.results.map(savedImage) } : {}),
    ...(others.length ? { items: others } : {}),
    ...(batch.pathBase ? { pathBase: batch.pathBase } : {}),
    ...(ended ? {} : { ahead: batch.ahead, etaSeconds: batch.etaSeconds }),
    itemReasons: batch.itemReasons, warnings: batch.warnings,
    instruction: batch.instruction, wait: batch.wait,
  });
}

/** list_queue: each batch by id, status and size; storage usage only when a store is at least four fifths full. */
export function compactQueueList(value) {
  if (!record(value) || !Array.isArray(value.batches)) return value;
  const nearlyFull = store => record(store) && [['batches', 'batchLimit'], ['records', 'recordLimit'], ['bytes', 'byteLimit']].some(([used, limit]) => store[limit] > 0 && store[used] / store[limit] >= 0.8);
  const full = record(value.storage) ? Object.fromEntries(Object.entries(value.storage).filter(([, store]) => nearlyFull(store))) : {};
  return {
    total: value.total, byStatus: value.byStatus,
    batches: value.batches.map(batch => present({ batchId: batch.batchId, status: batch.status, stopReason: batch.stopReason, count: batch.count,
      ...(batch.source?.kind === 'manual' ? { source: 'manual' } : {}), ...(batch.itemsFailed ? { failed: batch.itemsFailed } : {}), ...(batch.itemsUnknown ? { unknown: batch.itemsUnknown } : {}) })),
    ...(value.omitted ? { omitted: value.omitted } : {}),
    ...(Object.keys(full).length ? { storage: full } : {}),
  };
}

/** get_queue_result: the image's history identity, seed and file (the call named the batch and the item). */
export function compactQueueResult(value) {
  if (!record(value)) return value;
  if (Array.isArray(value.results)) return present({ status: value.status, total: value.total, ...(value.offset ? { offset: value.offset } : {}), nextOffset: value.nextOffset,
    results: value.results.map(result => ({ ...savedImage(result), ...(result.imageAttached === false ? { imageAttached: false, error: result.error } : {}) })),
    ...(value.pathBase ? { pathBase: value.pathBase } : {}), ...(value.nextOffset !== null && value.nextOffset !== undefined ? { instruction: value.instruction } : {}) });
  return present({ historyId: value.historyId, actualSeed: value.actualSeed, fileName: value.fileName, file: value.file, ...(value.pathBase ? { pathBase: value.pathBase } : {}) });
}

/**
 * enqueue_recipes: whether the plan is queued and under which batch. The seeds only where the call did not write
 * them (a fixed seed counted up); the batch's state and the instruction only where the answer is not the routine
 * "accepted" (already enqueued, confirmed after a lost answer, a cleaned batch).
 */
export function compactEnqueue(receipt, args = {}) {
  if (!record(receipt) || typeof receipt.status !== 'string') return receipt;
  const batch = record(receipt.batch) ? receipt.batch : null;
  const seeds = list(receipt.items).map(item => item.seed ?? null), written = list(args.items).flatMap(item => Array.isArray(item?.seeds) ? item.seeds : Array.from({ length: item?.count ?? 1 }, () => undefined));
  const seedsWritten = seeds.length === written.length && seeds.every((seed, index) => seed === written[index]);
  const routine = receipt.status === 'enqueued' && !receipt.reconciled;
  return present({
    status: receipt.status, batchId: batch?.batchId, count: batch?.count ?? receipt.count,
    ...(seeds.some(seed => seed !== null) && !seedsWritten ? { seeds } : {}),
    ...(routine ? {} : { batchStatus: batch?.status, ...(batch?.cleaned === true ? { cleaned: true } : {}), itemCounts: nonZero(batch?.itemCounts), instruction: receipt.instruction }),
    ...(receipt.reconciled ? { reconciled: true } : {}), ...(receipt.planVerified === false ? { planVerified: false } : {}),
    warnings: receipt.warnings,
  });
}

// ------------------------------------------------------------------ library
/** A list row: the identity to read it by, what it is and an excerpt. */
function compactAssetRow(item) {
  if (!record(item)) return item;
  const { category: _category, updatedAt: _updated, source: _source, summary: _summary, omitted: _omitted, truncatedFields: _truncated, image, matchedTags, archived, ...rest } = item;
  return present({ ...rest, ...(archived ? { archived: true } : {}), ...(list(matchedTags).length ? { matchedTags } : {}), assetId: image?.preview?.assetId });
}

/** asset_library list: rows and paging; the budget only when it cut the page short. */
export function compactAssetList(page) {
  if (!record(page) || !Array.isArray(page.items)) return page;
  return present({ items: page.items.map(compactAssetRow), total: page.total, ...(page.offset ? { offset: page.offset } : {}), hasMore: page.hasMore, nextOffset: page.nextOffset, revision: page.revision,
    ...(page.budgetTruncated ? { budgetTruncated: true } : {}) });
}

const PARAM_DEFAULTS = { smea: false, smeaDyn: false, variety: false, transparentBackground: false, fileNamePrefix: '', qualityToggle: true };
/**
 * asset_library read of a history image, the only answer the tool gives: everything the image was made with, once.
 * The prompts and parameters, the characters, the seed, the saved file, the identities a later call needs (id,
 * revision, assetId for a recipe source or an image read, the queue batch), and where the user filed it (its history
 * group, the tags the user added, its other collections). Left out: the prompt split into its tags (the prompts are
 * above), the second copy of the character prompts and of the file, and the host's own links. `whole` is the complete
 * record of the response module.
 */
export function historyRecipeView(whole) {
  const item = whole?.item, payload = record(item?.payload) ? item.payload : {};
  if (!record(item)) return whole;
  const { params, characterSnapshot, characterPrompts, filePath, fileUrl: _url, queueOrigin, generationOrigin, actualSeed, model, width, height, id: _id, createdAt: _created, date: _date, groupId, ...other } = payload;
  const userTags = list(whole.tags).filter(tag => tag?.source === 'user' && typeof tag.tag === 'string').map(tag => tag.tag);
  // The history group is groupId; any other membership is a collection, named by the id list and mutate take ("user:<id>").
  const collections = list(whole.memberships).filter(membership => record(membership) && typeof membership.namespace === 'string' && typeof membership.collectionId === 'string' && !(membership.namespace === 'history' && membership.collectionId === groupId))
    .map(membership => `${membership.namespace}:${membership.collectionId}`);
  const captions = Array.isArray(characterSnapshot?.captions) ? characterSnapshot.captions : Array.isArray(characterPrompts) ? characterPrompts.map(prompt => ({ prompt })) : [];
  const recipe = record(params) ? Object.fromEntries(Object.entries(params).filter(([key, value]) => value !== null && value !== undefined && !(key in PARAM_DEFAULTS && value === PARAM_DEFAULTS[key])
    && !['model', 'width', 'height', 'promptAssemblyVersion'].includes(key) && !(key === 'seed' && value === actualSeed)
    // qualityPreset says what the older on/off switch said.
    && !(key === 'qualityToggle' && params.qualityPreset !== undefined))) : undefined;
  return present({
    kind: item.kind, id: item.id, revision: item.revision, name: item.name, createdAt: item.createdAt, ...(item.archived ? { archived: true } : {}),
    assetId: item.preview?.assetId, model, width, height, mode: generationOrigin?.mode, actualSeed,
    params: recipe,
    ...(captions.length ? { characters: captions.map(caption => present({ prompt: caption.prompt, ...(caption.negativePrompt ? { negativePrompt: caption.negativePrompt } : {}), ...(caption.useCoords ? { x: caption.x, y: caption.y } : {}) })) } : {}),
    filePath,
    ...(record(queueOrigin) ? { queue: present({ batchId: queueOrigin.batchId, itemIndex: queueOrigin.itemIndex }) } : {}),
    groupId, ...(userTags.length ? { userTags } : {}), ...(collections.length ? { collections } : {}),
    ...other,
  });
}

// ------------------------------------------------------------------ tags
const WIKI_DEFINITION_CHARS = 600;
/** The definition of a Danbooru wiki page: its text before the first heading (h1.–h6.: examples, related tags, see also), at most WIKI_DEFINITION_CHARS. */
export function wikiDefinition(body) {
  if (typeof body !== 'string') return undefined;
  const text = body.replace(/\r\n/g, '\n');
  const heading = text.search(/^h[1-6]\.\s/m);
  const lead = (heading > 0 ? text.slice(0, heading) : heading === 0 ? text.replace(/^h[1-6]\.[^\n]*\n+/, '').split(/^h[1-6]\.\s/m)[0] : text).trim();
  const cut = Array.from(lead).slice(0, WIKI_DEFINITION_CHARS).join('');
  return { text: cut, more: cut.length < lead.length || lead.length < text.trim().length };
}

/**
 * tag_details (detail compact): per tag its canonical name where it differs, category, post count, aliases, anything
 * that is not the ordinary state (not found, deprecated, an unchecked alias, errors) and the wiki's definition; not
 * where the answer came from (cache or network, source links).
 * wikiMore says the page goes on (examples, related tags): detail "full" has it.
 */
export function compactTags(value) {
  if (!record(value) || !Array.isArray(value.items) || value.detail !== 'compact') return value;
  return { count: value.count, items: value.items.map(item => {
    if (!record(item)) return item;
    const definition = wikiDefinition(item.wiki?.body);
    return present({
      name: item.name, ...(item.canonicalName && item.canonicalName !== item.name ? { canonicalName: item.canonicalName } : {}),
      ...(item.resolution && item.resolution !== 'canonical' ? { resolution: item.resolution } : {}),
      ...(item.tagStatus !== 'found' ? { tagStatus: item.tagStatus } : {}), tagName: item.tagName,
      category: item.category, postCount: item.postCount, ...(item.deprecated ? { deprecated: true } : {}),
      ...(item.aliasStatus && item.aliasStatus !== 'checked' ? { aliasStatus: item.aliasStatus } : {}), aliases: item.aliases,
      ...(definition ? { wiki: definition.text, ...(definition.more ? { wikiMore: true } : {}) } : item.wiki?.status && item.wiki.status !== 'found' ? { wikiStatus: item.wiki.status } : {}),
      wikiTitle: item.wiki?.title, errors: item.errors,
    });
  }) };
}
