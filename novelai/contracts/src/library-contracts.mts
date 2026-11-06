import { Type, type Static, type TSchema } from 'typebox';

const text = Type.String();
const nonempty = Type.String({ minLength: 1, pattern: '\\S' });
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const strings = Type.Array(text);
const nullableText = Type.Union([text, Type.Null()]);
const optional = Type.Optional;
const values = <const T extends (string | number)[]>(items: T) => Type.Enum<T>(items);
const closed = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });

export const LibraryKindSchema = values(['tag', 'combo', 'note', 'study', 'history', 'artist_favorite', 'style_preset', 'positive_preset', 'prompt_chunk', 'reference_preset']);
export type LibraryKind = Static<typeof LibraryKindSchema>;
export const ArtistFavoriteCollectionSchema = values(['random', 'v5-repair', 'artist-string-draw']);
export type ArtistFavoriteCollection = Static<typeof ArtistFavoriteCollectionSchema>;
export const MaterialSourceSchema = values(['danbooru', 'nai', 'english']);
export const MaterialTargetSchema = values(['style', 'base', 'character']);

export const MaterialTagEvidenceSchema = Type.Object({
  checkedAt: nullableText, canonicalName: nullableText, resolution: text, tagStatus: text,
  category: nullableText, postCount: Type.Union([Type.Number(), Type.Null()]),
  deprecated: Type.Union([Type.Boolean(), Type.Null()]), aliasStatus: text,
  aliases: optional(Type.Array(Type.Object({ from: text, to: text }))),
  wiki: Type.Object({ status: text, body: optional(text), format: optional(text), truncated: optional(Type.Boolean()) }),
  sources: strings, errors: optional(Type.Array(Type.Object({ stage: text, code: text, message: text }))),
});
export const MaterialTagSchema = Type.Object({ text, source: MaterialSourceSchema, category: nullableText, target: MaterialTargetSchema, evidence: optional(MaterialTagEvidenceSchema) });
export const MaterialComponentSchema = Type.Object({ text, source: MaterialSourceSchema, category: optional(nullableText), weight: Type.Number(), target: MaterialTargetSchema, entryId: optional(text), entryRevision: optional(revision) });
export const MaterialLinkSchema = Type.Object({ batchId: optional(text), itemIndex: optional(integer), feedback: optional(text), studyId: optional(text), sourceSha256: optional(text), field: optional(text), excerpt: optional(text) });
const MaterialCoverBase = {
  sha256: text, mimeType: Type.Literal('image/webp'), width: integer, height: integer,
  byteLength: integer, tagText: text, tagCategory: nullableText, savedAt: text, importedAt: optional(text),
};
const MaterialDanbooruCoverSchema = Type.Object({
  ...MaterialCoverBase, source: optional(Type.Literal('danbooru')), postId: Type.Integer({ minimum: 1 }), sourceUrl: text,
  verification: values(['online', 'imported']), checkedAt: nullableText, rating: values(['g', 's', 'q', 'e']),
});
const MaterialLocalCoverSchema = Type.Object({
  ...MaterialCoverBase, source: Type.Literal('local'), fileName: Type.String({ minLength: 1, maxLength: 255 }), sourceSha256: text,
  tagSource: MaterialSourceSchema, postId: Type.Null(), sourceUrl: Type.Null(), verification: values(['local', 'imported']), checkedAt: Type.Null(), rating: Type.Null(),
});
export const MaterialCoverSchema = Type.Union([MaterialDanbooruCoverSchema, MaterialLocalCoverSchema]);
export const MaterialEntryInputSchema = Type.Object({
  kind: values(['tag', 'combo', 'note']), name: nonempty, group: optional(text), notes: optional(text),
  tag: optional(Type.Object({ ...MaterialTagSchema.properties, category: optional(nullableText) })), components: optional(Type.Array(MaterialComponentSchema)), links: optional(Type.Array(MaterialLinkSchema)),
});
export const MaterialEntrySchema = Type.Object({
  ...MaterialEntryInputSchema.properties, schemaVersion: Type.Literal(1), id: nonempty, revision,
  group: text, notes: text, archived: Type.Boolean(), createdAt: text, updatedAt: text,
  tag: optional(MaterialTagSchema),
  coverRevision: optional(integer), cover: optional(Type.Union([MaterialCoverSchema, Type.Null()])),
  coverStatus: optional(values(['none', 'ready', 'stale', 'unavailable'])),
});
export type MaterialEntry = Static<typeof MaterialEntrySchema>;
export type MaterialEntryInput = Static<typeof MaterialEntryInputSchema>;
export const TagPayloadSchema = Type.Object({ ...MaterialEntrySchema.properties, kind: Type.Literal('tag') });
export const ComboPayloadSchema = Type.Object({ ...MaterialEntrySchema.properties, kind: Type.Literal('combo') });
export const NotePayloadSchema = Type.Object({ ...MaterialEntrySchema.properties, kind: Type.Literal('note') });

export const StudyFieldSchema = Type.Object({ key: text, label: text, value: text });
export const StudySummarySchema = Type.Object({
  id: nonempty, revision, name: nonempty, sha256: text, mimeType: text, width: integer, height: integer,
  byteLength: integer, sourceUrl: text, sourceAuthor: text, createdAt: text, updatedAt: text,
  archived: Type.Boolean(), metadataStatus: values(['generation', 'other_metadata', 'missing', 'partial']),
  metadataKind: text, sources: strings, warnings: strings, promptFieldCount: integer, parameterFieldCount: integer,
});
export const StudyPayloadSchema = Type.Object({
  schemaVersion: Type.Literal(1), parserVersion: Type.Literal(1), study: StudySummarySchema,
  notes: text, originalName: optional(text), previewSha256: text, previewByteLength: integer,
  sections: optional(Type.Object({
    prompts: optional(Type.Array(StudyFieldSchema)), parameters: optional(Type.Array(StudyFieldSchema)),
    raw: optional(Type.Record(Type.String(), Type.Record(Type.String(), text))),
  })),
});
export type StudyPayload = Static<typeof StudyPayloadSchema>;

export const MetadataReplaySchema = Type.Object({
  model: text, parameters: Type.Record(Type.String(), Type.Union([Type.Boolean(), Type.Number(), text, Type.Null()])),
  positive: optional(Type.Object({ use_order: optional(Type.Boolean()), legacy_uc: optional(Type.Boolean()) })),
  negative: optional(Type.Object({ use_order: optional(Type.Boolean()), legacy_uc: optional(Type.Boolean()) })),
  keepEmptyNegativeCharacters: optional(Type.Boolean()),
});
export const GenerateParamsSchema = Type.Object({
  preservePromptText: optional(Type.Boolean()), promptAssemblyVersion: optional(Type.Literal(1)), metadataReplay: optional(MetadataReplaySchema),
  model: values(['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-4-full', 'nai-diffusion-4-curated', 'nai-diffusion-3', 'nai-diffusion-furry-3']),
  stylePrompt: text, positivePrompt: text, negativePrompt: text, width: Type.Number(), height: Type.Number(),
  steps: Type.Number(), cfgScale: Type.Number(), cfgRescale: Type.Number(),
  sampler: values(['k_euler_ancestral', 'k_euler', 'k_dpmpp_2m', 'k_dpmpp_2m_sde', 'k_dpmpp_sde', 'k_dpmpp_2s_ancestral', 'ddim_v3']),
  noiseSchedule: text, seed: Type.Number(), seedMode: values(['fixed', 'random']),
  ucPreset: values([0, 1, 2, 3]), qualityPreset: values(['standard', 'light', 'none']), qualityToggle: Type.Boolean(),
  transparentBackground: Type.Boolean(), smea: Type.Boolean(), smeaDyn: Type.Boolean(), variety: Type.Boolean(), fileNamePrefix: text,
  // V5 Full Effort (NovelAI 2026-10-08). Absent = high, the model as it always ran. medium runs the distilled
  // nai-diffusion-5-full-medium(-inpainting) checkpoint with fixed steps, sampler and UC (client src/nai-effort.ts);
  // it applies only where the execution model is V5 Full or its inpainting model.
  effort: optional(values(['high', 'medium'])),
});
export type GenerateParams = Static<typeof GenerateParamsSchema>;
export const GenerationOriginSchema = Type.Object({
  jobId: text, mode: values(['t2i', 'i2i', 'inpaint', 'enhance', 'upscale', 'director']),
  originWorkspaceId: text, submittedRevision: Type.Number(), actualSeed: Type.Union([Type.Number(), Type.Null()]),
});
export type GenerationOrigin = Static<typeof GenerationOriginSchema>;
export const QueueOriginSchema = closed({ batchId: nonempty, requestKey: nonempty, itemIndex: Type.Integer({ minimum: 0 }) });
export type QueueOrigin = Static<typeof QueueOriginSchema>;
export const HistoryTagSourceSchema = values(['positive','style','character','user']);
export type HistoryTagSource = Static<typeof HistoryTagSourceSchema>;
export const HistoryTagSchema = Type.Object({tag:nonempty,source:HistoryTagSourceSchema,characterIndex:optional(integer)});
export type HistoryTag = Static<typeof HistoryTagSchema>;
export const HistoryTagCoverageSchema = Type.Object({positive:Type.Boolean(),style:Type.Boolean(),character:Type.Boolean(),user:Type.Literal(true)});
export type HistoryTagCoverage = Static<typeof HistoryTagCoverageSchema>;
// Authored local snapshot, deliberately independent of normalized search/provider text.
export const CharacterSnapshotSchema = closed({
  version: Type.Literal(1),
  captions: Type.Array(closed({
    prompt: text, negativePrompt: optional(text), useCoords: Type.Boolean(),
    x: Type.Number({ minimum: 0, maximum: 1 }), y: Type.Number({ minimum: 0, maximum: 1 }),
  })),
});
export type CharacterSnapshot = Static<typeof CharacterSnapshotSchema>;
/** A new history record as generation saves it, with its complete generation parameters. Generation checks the record
 * against this schema before it sends the request (client electron/ipc/nai.ts) and again where it saves the record
 * (client electron/ipc/store.ts addHistory); every other library write uses the stored history schema below. */
export const HistoryPayloadSchema = Type.Object({
  id: nonempty, filePath: text, fileUrl: text, date: text, createdAt: text, groupId: optional(text),
  characterSnapshot: optional(CharacterSnapshotSchema), characterPrompts:optional(strings), annotation:optional(Type.Object({customTags:Type.Array(Type.String({minLength:1,maxLength:256}),{maxItems:200})})),
  params: GenerateParamsSchema, actualSeed: Type.Number(), model: text, width: Type.Number(), height: Type.Number(),
  feature: optional(text), generationOrigin: optional(GenerationOriginSchema),
  // Queued images (2026-10-14, issue #1): the durable batch, its namespaced request key and the item index. Kept beside
  // generationOrigin, whose key set the renderer checks strictly.
  queueOrigin: optional(QueueOriginSchema),
});
export type HistoryPayload = Static<typeof HistoryPayloadSchema>;

export const ParsedRecipeTokenSchema = Type.Object({ raw: text, value: text, weight: Type.Number(), kind: values(['artist', 'year', 'quality', 'negative', 'style', 'other']) });
export const ArtistFavoritePayloadSchema = Type.Object({
  collection: ArtistFavoriteCollectionSchema,
  id: nonempty, artists: Type.Array(Type.Object({ name: text, weight: Type.Number() })),
  auxiliary: Type.Array(ParsedRecipeTokenSchema),
  mutations: Type.Array(Type.Object({ ...ParsedRecipeTokenSchema.properties, category: values(['artStyle', 'medium', 'color', 'lighting']) })),
  franchiseStyles: Type.Array(Type.Object({ ...ParsedRecipeTokenSchema.properties, kind: Type.Literal('style'), category: Type.Literal('franchise') })),
  basePrompt: text, prompt: text, move: optional(values(['probe', 'weight', 'ablate', 'expand', 'cross'])),
  pairId: text, variant: values(['plain', 'mutated']), sequence: Type.Number(), status: values(['pending', 'generating', 'done', 'failed']),
  image: optional(HistoryPayloadSchema), error: optional(text), liked: optional(Type.Boolean()), saving: optional(Type.Boolean()),
  generationModel: optional(text), generationSeed: optional(Type.Number()),
});
export type ArtistFavoritePayload = Static<typeof ArtistFavoritePayloadSchema>;

export const PreviewImageSchema = Type.Object({ id: text, name: text, filePath: text, fileUrl: text, createdAt: text });
export type PreviewImage = Static<typeof PreviewImageSchema>;
export const StylePresetPayloadSchema = Type.Object({ id: nonempty, name: text, prompt: text, group: text, createdAt: text, previewImages: optional(Type.Array(PreviewImageSchema)) });
export const PositivePresetPayloadSchema = Type.Object({ id: nonempty, name: text, prompt: text, createdAt: text, previewImages: optional(Type.Array(PreviewImageSchema)) });
export const PromptChunkPayloadSchema = Type.Object({ id: nonempty, name: text, content: text, createdAt: text, updatedAt: text });
const localizedNames = Type.Object({ 'zh-CN': optional(text), 'zh-TW': optional(text), 'en-US': optional(text), 'ja-JP': optional(text), 'ko-KR': optional(text) });
export const ReferencePresetPayloadSchema = Type.Object({
  id: nonempty, name: text, group: text, kind: values(['vibe', 'precise']), filePath: text, fileUrl: text, createdAt: text,
  infoExtracted: Type.Number(), strength: Type.Number(), preciseType: values(['character', 'style', 'character&style']),
  fidelity: Type.Number(), informationExtracted: Type.Number(), width: Type.Number(), height: Type.Number(),
  sourceId: optional(text), sourceNames: optional(localizedNames), sourceGameNames: optional(localizedNames), sourceGameId: optional(text), sourceCategory: optional(text),
});
export type StylePresetPayload = Static<typeof StylePresetPayloadSchema>;
export type PositivePresetPayload = Static<typeof PositivePresetPayloadSchema>;
export type PromptChunkPayload = Static<typeof PromptChunkPayloadSchema>;
export type ReferencePresetPayload = Static<typeof ReferencePresetPayloadSchema>;

export type LibraryPayloadMap = {
  tag: Static<typeof TagPayloadSchema>; combo: Static<typeof ComboPayloadSchema>; note: Static<typeof NotePayloadSchema>;
  study: StudyPayload; history: HistoryPayload; artist_favorite: ArtistFavoritePayload;
  style_preset: StylePresetPayload; positive_preset: PositivePresetPayload; prompt_chunk: PromptChunkPayload; reference_preset: ReferencePresetPayload;
};
// The one storage schema of library records. A stored history record keeps the generation parameters exactly as they
// were saved: one from before a parameter existed lacks it, present values still use the field schemas, and nothing is
// filled in with a recipe default (that would change what reproducing the image means). Fields this version does not
// know are kept as they are.
const StoredHistoryPayloadSchema = Type.Object({
  ...HistoryPayloadSchema.properties, fileUrl: optional(text), params: Type.Partial(GenerateParamsSchema, { additionalProperties: true }),
}, { additionalProperties: true });
export const libraryPayloads: Record<LibraryKind, TSchema> = {
  tag: TagPayloadSchema, combo: ComboPayloadSchema, note: NotePayloadSchema, study: StudyPayloadSchema,
  history: StoredHistoryPayloadSchema,
  artist_favorite: Type.Object({ ...ArtistFavoritePayloadSchema.properties, image: optional(StoredHistoryPayloadSchema) }, { additionalProperties: true }),
  style_preset: StylePresetPayloadSchema, positive_preset: PositivePresetPayloadSchema, prompt_chunk: PromptChunkPayloadSchema,
  reference_preset: Type.Object({ ...ReferencePresetPayloadSchema.properties, fileUrl: optional(text) }, { additionalProperties: true }),
};
const itemFields = {
  schemaVersion: Type.Literal(1), id: nonempty, revision, name: text, archived: Type.Boolean(),
  createdAt: text, updatedAt: text, source: Type.Object({ namespace: nonempty, legacyId: optional(text), position: optional(integer) }),
};
export const LibraryItemMetadataSchema = Type.Object(itemFields);
export type LibraryItem = { [K in LibraryKind]: Static<typeof LibraryItemMetadataSchema> & { kind: K; payload: LibraryPayloadMap[K] } }[LibraryKind];
export const LibraryItemSchema: TSchema = Type.Union(Object.entries(libraryPayloads).map(([kind, payload]) => Type.Object({ ...itemFields, kind: Type.Literal(kind), payload })));

const MaterialBackupSchema = Type.Object({ schemaVersion: Type.Literal(1), entries: Type.Array(MaterialEntrySchema), covers: optional(Type.Array(Type.Object({ entryId: text, cover: MaterialCoverSchema, data: text }))) });
export const MaterialLibraryRequestSchema = Type.Union([
  closed({ action: Type.Literal('list'), query: optional(text), kind: optional(values(['tag', 'combo', 'note'])), group: optional(text), includeArchived: optional(Type.Boolean()), offset: optional(integer), limit: optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
  closed({ action: Type.Literal('read'), id: nonempty, revision: optional(revision) }),
  closed({ action: Type.Literal('save'), entry: MaterialEntryInputSchema, id: optional(nonempty), expectedRevision: optional(revision), refreshEvidence: optional(Type.Boolean()) }),
  closed({ action: Type.Literal('archive'), id: nonempty, expectedRevision: revision, archived: optional(Type.Boolean()) }),
  closed({ action: Type.Literal('export'), ids: optional(Type.Array(nonempty)) }),
  closed({ action: Type.Literal('import'), data: MaterialBackupSchema }),
]);
export const MaterialTagsRequestSchema = Type.Union([
  closed({ action: Type.Literal('search'), query: nonempty, limit: optional(Type.Integer({ minimum: 1, maximum: 50 })), category: optional(Type.Literal('artist')) }),
  closed({ action: Type.Literal('details'), name: optional(nonempty), names: optional(Type.Array(nonempty)) }),
]);
const sampleIdentity = { entryId: nonempty, revision: optional(revision) };
export const MaterialSamplesRequestSchema = Type.Union([
  closed({ action: Type.Literal('list'), ...sampleIdentity, page: optional(Type.Integer({ minimum: 1, maximum: 1000 })), limit: optional(Type.Integer({ minimum: 1, maximum: 12 })), minScore: optional(integer), rating: optional(values(['g', 's', 'q', 'e'])) }),
  closed({ action: Type.Literal('list_all'), ...sampleIdentity, page: optional(Type.Integer({ minimum: 1, maximum: 30 })), limit: optional(Type.Integer({ minimum: 1, maximum: 12 })), minScore: optional(integer), sort: optional(values(['score', 'newest', 'oldest'])) }),
  closed({ action: Type.Literal('image'), ...sampleIdentity, postId: Type.Integer({ minimum: 1 }), variant: optional(values(['preview', 'sample'])), minScore: optional(integer), rating: optional(values(['g', 's', 'q', 'e'])) }),
  closed({ action: Type.Literal('set_cover'), entryId: nonempty, revision, postId: Type.Integer({ minimum: 1 }), expectedCoverRevision: integer, minScore: optional(integer), rating: optional(values(['g', 's', 'q', 'e'])) }),
  closed({ action: Type.Literal('set_local_cover'), entryId: nonempty, revision, expectedCoverRevision: integer, fileName: Type.String({ minLength: 1, maxLength: 255 }), data: Type.String({ minLength: 1, maxLength: 27_962_028 }) }),
  closed({ action: Type.Literal('cover'), entryId: nonempty }),
  closed({ action: Type.Literal('clear_cover'), entryId: nonempty, expectedCoverRevision: integer }),
]);
export const StudyRequestSchema = Type.Union([
  closed({ action: Type.Literal('import'), name: nonempty, data: nonempty, sourceUrl: optional(text), sourceAuthor: optional(text) }),
  closed({ action: Type.Literal('list'), query: optional(text), offset: optional(integer), limit: optional(Type.Integer({ minimum: 1, maximum: 50 })), includeArchived: optional(Type.Boolean()) }),
  closed({ action: Type.Literal('read'), id: nonempty, section: optional(values(['summary', 'prompts', 'parameters', 'raw', 'notes'])) }),
  closed({ action: values(['image', 'original']), id: nonempty }),
  closed({ action: Type.Literal('update'), id: nonempty, expectedRevision: revision, patch: closed({ name: optional(nonempty), sourceUrl: optional(text), sourceAuthor: optional(text), archived: optional(Type.Boolean()), notes: optional(text) }) }),
]);
export type MaterialLibraryRequest = Static<typeof MaterialLibraryRequestSchema>;
export type StudyRequest = Static<typeof StudyRequestSchema>;
export const AssetPreviewSchema = Type.Object({ assetId: nonempty, role: nonempty, cacheKey: nonempty, mimeType: optional(text), width: optional(Type.Number()), height: optional(Type.Number()) });
export type AssetPreview = Static<typeof AssetPreviewSchema>;
export const AssetVersionSummarySchema = Type.Object({ revision, name: text, createdAt: text, updatedAt: text });
export type AssetVersionSummary = Static<typeof AssetVersionSummarySchema>;
export const AssetVersionsSchema = Type.Object({ versions:Type.Array(AssetVersionSummarySchema),currentRevision:revision,canRestore:Type.Boolean() });
export type AssetVersions = Static<typeof AssetVersionsSchema>;
export const AssetThumbnailSchema = Type.Object({ status: values(['ready','unavailable']), cacheKey: nonempty, dataUrl: optional(text), message: optional(text) });
export type AssetThumbnail = Static<typeof AssetThumbnailSchema>;
const assetSelection = Type.Array(closed({kind:LibraryKindSchema,id:nonempty,expectedRevision:revision}),{minItems:1,maxItems:500});
/** Recently Deleted entry identities (recently-deleted lists them). */
const trashIds = Type.Array(Type.String({pattern:'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'}),{minItems:1,maxItems:500,uniqueItems:true});
const assetUpdateDescription = 'Allowed update fields by kind: history: groupId only (existing history-group raw ID; never name or group); tag/combo/note: name, group, notes; study: name, notes; style_preset: name, group, prompt; positive_preset: name, prompt; prompt_chunk: name, content, updatedAt; reference_preset: name, group, strength, infoExtracted, preciseType, fidelity, informationExtracted; artist_favorite: none. Note prose belongs in notes; do not invent fields. To collect history and notes together, create-collection then add-to-collection with its returned collectionId, not update.';
// Internal/manual list and read retain their original limits and complete records.
const assetHostList = closed({action:Type.Literal('list'),query:optional(text),kinds:optional(Type.Array(LibraryKindSchema,{maxItems:10,uniqueItems:true})),collectionId:optional(nonempty),includeArchived:optional(Type.Boolean()),offset:optional(integer),limit:optional(Type.Integer({minimum:1,maximum:100})),sortBy:optional(values(['updatedAt','createdAt','name'])),sortDirection:optional(values(['asc','desc'])),historyTags:optional(Type.Array(Type.String({minLength:1,maxLength:256}),{maxItems:30})),historyTagMatch:optional(values(['all','any'])),historyTagSources:optional(Type.Array(HistoryTagSourceSchema,{minItems:1,maxItems:4,uniqueItems:true})),
  // History images a queued batch saved (2026-10-14, issue #1): queueOrigin.requestKey (namespaced host key) / batchId.
  queueRequestKey:optional(Type.String({minLength:1,maxLength:120,pattern:'\\S'})),queueBatchId:optional(Type.String({minLength:1,maxLength:120,pattern:'\\S'}))});
const assetHostRead = closed({action:Type.Literal('read'),kind:LibraryKindSchema,id:nonempty,revision:optional(revision)});
const assetRequestVariants = [
  closed({...assetHostList.properties,limit:optional(Type.Integer({minimum:1,maximum:20,default:10}))}),
  closed({...assetHostRead.properties,detail:optional(values(['summary','full']))}),
  closed({action:Type.Literal('image'),kind:Type.Literal('history'),id:Type.String({...nonempty,maxLength:512}),revision,assetId:Type.String({...nonempty,maxLength:512}),variant:optional(values(['thumbnail','original']))}),
  // Issue #2: the single registered original of one study (imported image) revision; no assetId (a study has one original).
  closed({action:Type.Literal('image'),kind:Type.Literal('study'),id:Type.String({pattern:'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'}),revision,variant:optional(values(['thumbnail','original']))}),
  closed({action:Type.Literal('collections')}),
  closed({action:Type.Literal('create-collection'),name:Type.String({minLength:1,maxLength:512,pattern:'\\S',description:'User mixed collection name. Surrounding whitespace is trimmed; an existing same-name user collection is reused. No namespace argument. Use returned collection.id for add-to-collection.'})}),
  closed({action:Type.Literal('mutate'),command:Type.Literal('archive'),items:assetSelection,patch:optional(closed({archived:Type.Boolean()}))}),
  closed({action:Type.Literal('mutate'),command:Type.Literal('update'),items:assetSelection,patch:Type.Object({
    name:optional(Type.String({...nonempty,description:'Editable material name; never accepted for history or artist_favorite.'})),
    group:optional(Type.String({description:'Group name for tag/combo/note/style_preset/reference_preset only. Never history; mixed collections use add-to-collection.'})),
    notes:optional(Type.String({description:'Note prose for tag/combo/note/study. Keep user feedback and AI observations attributed; do not add invented fields.'})),
    groupId:optional(Type.String({description:'History only: existing history-group raw ID from collections; empty string clears that history group. Never a user collection name or encoded user collectionId.'})),
    prompt:optional(text),content:optional(text),updatedAt:optional(text),
    strength:optional(Type.Number({minimum:0,maximum:1})),infoExtracted:optional(Type.Number({minimum:0,maximum:1})),
    preciseType:optional(values(['character','style','character&style'])),fidelity:optional(Type.Number({minimum:0,maximum:1})),informationExtracted:optional(Type.Number({minimum:0,maximum:1})),
  }, {additionalProperties:false,description:assetUpdateDescription})}),
  closed({action:Type.Literal('mutate'),command:values(['add-to-collection','remove-from-collection']),items:assetSelection,collectionId:nonempty}),
  // Recently Deleted (step 3c, 2026-11-02): delete moves items, or one user collection, there even when they are
  // referenced (the receipt lists the effects; preview:true only lists them); entries are purged automatically after
  // 30 days, restore brings them back, purge removes them for good.
  closed({action:Type.Literal('mutate'),command:Type.Literal('delete'),items:assetSelection,preview:optional(Type.Boolean())}),
  closed({action:Type.Literal('mutate'),command:Type.Literal('delete'),collectionId:nonempty,preview:optional(Type.Boolean())}),
  closed({action:Type.Literal('mutate'),command:Type.Literal('delete-archived'),kinds:optional(Type.Array(LibraryKindSchema,{minItems:1,maxItems:10,uniqueItems:true})),preview:optional(Type.Boolean())}),
  closed({action:Type.Literal('recently-deleted'),query:optional(text),offset:optional(integer),limit:optional(Type.Integer({minimum:1,maximum:100}))}),
  closed({action:Type.Literal('restore'),trashIds}),
  closed({action:Type.Literal('purge'),trashIds}),
] as const;
// MCP requires an object root; the variants still own all action-specific required fields.
export const AssetLibraryRequestSchema = Object.assign(Type.Union([...assetRequestVariants]), {
  type:'object' as const,
  description:`AI list is summary-only (default 10, max 20, 12 KiB UTF-8 JSON). Explicit image reads one selected history original by kind/id/exact revision/registered assetId; variant defaults to thumbnail (max 384), original must be explicit. Native attachment only, no workspace, paths, batch, exports or automatic reads. Read detail:summary|full; history defaults to summary, other kinds to full. Summaries are not recipes or verified images. Explicit full is untruncated and may be large. Create a mixed user collection with {action:"create-collection",name}; reuse its returned collection.id for explicit versioned membership changes. System namespaces are not public; mutate delete with a user collectionId moves that collection (not its items) to Recently Deleted. ${assetUpdateDescription}`,
  properties:Object.fromEntries([...new Set(assetRequestVariants.flatMap(variant=>Object.keys(variant.properties)))].map(key=>[
    key,Type.Union(assetRequestVariants.flatMap(variant=>key in variant.properties ? [(variant.properties as Record<string,TSchema>)[key]] : [])),
  ])),
  additionalProperties:false,
});
export type AssetLibraryRequest = Static<typeof AssetLibraryRequestSchema>;
export const AssetLibraryDesktopRequestSchema = Type.Union([
  assetHostList, assetHostRead,
  closed({action:Type.Literal('tag-suggestions'),query:optional(Type.String({maxLength:256})),limit:optional(Type.Integer({minimum:1,maximum:50}))}),
  closed({action:Type.Literal('mutate'),command:Type.Literal('set-custom-tags'),items:assetSelection,tags:Type.Array(Type.String({minLength:1,maxLength:256}),{maxItems:200})}),
  closed({action:Type.Literal('versions'),kind:LibraryKindSchema,id:nonempty}),
  closed({action:Type.Literal('thumbnail'),kind:LibraryKindSchema,id:nonempty,revision,assetId:nonempty}),
  closed({action:Type.Literal('restore-content'),kind:LibraryKindSchema,id:nonempty,revision,expectedRevision:revision}),
  closed({action:Type.Literal('rename-collection'),collectionId:nonempty,name:Type.String({minLength:1,maxLength:512,pattern:'\\S'}),expectedRevision:integer}),
  // Emptying all of Recently Deleted (up to 500 entries per call) is a desktop action only; agents purge named trashIds.
  closed({action:Type.Literal('purge'),all:Type.Literal(true)}),
  // Deleting an internal category takes no version check. The service
  // requires expectedRevision for every user collection managed by the sidebar.
  closed({action:Type.Literal('delete-collection'),collectionId:nonempty,expectedRevision:optional(integer)}),
]);
export type AssetLibraryDesktopRequest = Static<typeof AssetLibraryDesktopRequestSchema>;
/**
 * The library page's own reads (oss/lib-1103): only the app window's IPC reaches them (the bridge and MCP never do), so
 * no MCP receipt budget applies. ui-list: one view, filtered in the host (mode, model, created range, source, archived
 * none/with/only), pages of up to 500 with exact totals, summary (on request) with the day counts of the result and the
 * models, agents and months of the view; history items come compact (the fields the grid reads); historyTags /
 * historyTagMatch (step 4c1) keep only history images with those prompt tags (all or any). ui-read: read plus the file
 * size of images whose record has none (stat only) and the item's preview (step 4c1). ui-archived: every archived item
 * (identity, revision, name). ui-trash-totals: Recently Deleted entries, files and sizes in all.
 */
export const AssetLibraryWindowRequestSchema = Type.Union([
  closed({action:Type.Literal('ui-list'),query:optional(Type.String({maxLength:1000})),kinds:optional(Type.Array(LibraryKindSchema,{maxItems:10,uniqueItems:true})),collectionId:optional(nonempty),
    archived:optional(values(['exclude','include','only'])),offset:optional(integer),limit:optional(Type.Integer({minimum:1,maximum:500})),
    sortBy:optional(values(['updatedAt','createdAt','name'])),sortDirection:optional(values(['asc','desc'])),
    mode:optional(values(['t2i','i2i','inpaint','enhance','upscale','director'])),model:optional(Type.String({minLength:1,maxLength:200})),
    source:optional(Type.String({minLength:1,maxLength:220,pattern:'^(?:agent|manual|imported|agent:.+)$'})),
    createdFrom:optional(integer),createdBefore:optional(integer),summary:optional(Type.Boolean()),
    historyTags:optional(Type.Array(Type.String({minLength:1,maxLength:256}),{minItems:1,maxItems:30})),historyTagMatch:optional(values(['all','any']))}),
  closed({action:Type.Literal('ui-read'),kind:LibraryKindSchema,id:nonempty}),
  closed({action:Type.Literal('ui-archived'),kinds:optional(Type.Array(LibraryKindSchema,{minItems:1,maxItems:10,uniqueItems:true}))}),
  closed({action:Type.Literal('ui-trash-totals')}),
]);
export type AssetLibraryWindowRequest = Static<typeof AssetLibraryWindowRequestSchema>;
export const ReferenceImportCommitSchema = closed({
  importId:Type.String({minLength:1,maxLength:128}),libraryRevision:integer,
  decisions:Type.Array(closed({entryId:Type.String({minLength:1,maxLength:128}),action:values(['import','skip','copy'])}),{maxItems:5000}),
});
export const schemas: { libraryPayloads: Record<LibraryKind, TSchema>; generatedHistoryPayload: TSchema; libraryItem: TSchema; requests: Record<string, TSchema> } = {
  libraryPayloads,
  generatedHistoryPayload: HistoryPayloadSchema,
  libraryItem: LibraryItemSchema,
  requests: { material_library: MaterialLibraryRequestSchema, material_tags: MaterialTagsRequestSchema, material_samples: MaterialSamplesRequestSchema, material_studies: StudyRequestSchema, asset_library: AssetLibraryRequestSchema, asset_library_desktop: AssetLibraryDesktopRequestSchema, asset_library_window: AssetLibraryWindowRequestSchema, reference_import_commit: ReferenceImportCommitSchema },
};
