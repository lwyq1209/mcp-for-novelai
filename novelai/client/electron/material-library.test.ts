import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMaterialLibraryService } from './material-library';
import { openLibraryRepository, type LibraryRepository } from './library/repository';
import type { DanbooruPost } from '../src/workspace/danbooru-types';
import { waitUntil } from '../src/test-support/wait-until';

const cleanups: string[] = [], repositories: LibraryRepository[] = [];
afterEach(async () => { vi.useRealTimers(); await runCleanups([...repositories.splice(0).map(repository => () => repository.close()), ...cleanups.splice(0).map(file => () => fs.rm(file, { recursive: true, force: true }))]); });
const item = (overrides: Partial<DanbooruPost> = {}): DanbooruPost => ({ postId: 42, rating: 'g', sourceUrl: 'https://danbooru.donmai.us/posts/42', width: 1, height: 1, previewUrl: 'https://cdn.donmai.us/preview.png', sampleUrl: 'https://cdn.donmai.us/sample.png', score: 30, tags: { general: ['watercolor'], artists: ['sample_artist'], characters: [], copyrights: [], meta: [] }, ...overrides });
const tag = (text = 'sample_artist', source = 'danbooru', target = 'style') => ({ kind: 'tag', name: text, tag: { text, source, category: source === 'danbooru' ? 'artist' : null, target } });
const facts = (name: string, override: any = {}) => ({ source: 'danbooru-public-api', detail: 'compact', checkedAt: '2026-09-11T00:00:00.000Z', count: 1, items: [{ name: name.trim().toLowerCase().replaceAll(' ', '_'), canonicalName: name, resolution: 'canonical', tagStatus: 'found', category: 'artist', postCount: 42, deprecated: false, aliasStatus: 'checked', wiki: { status: 'found', body: 'Fixture artist meaning.', format: 'dtext', truncated: false }, sources: ['https://danbooru.donmai.us/tags/42'], ...override }] });
async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-materials-')); cleanups.push(directory);
  const databasePath = path.join(directory, 'library.sqlite');
  // Every open is another connection to the same library file (a restart).
  const open = () => { const repository = openLibraryRepository({ filePath: databasePath, libraryDirectory: directory }); repositories.push(repository); return repository; };
  const repository = open();
  const tags = { search: vi.fn(async (args: any) => ({ query: args.query, source: 'danbooru-api', items: [{ name: 'sample_artist', category: 1, postCount: 42, source: 'danbooru-api' }] })), details: vi.fn(async (args: any) => facts(args.name)) };
  const gallery = { search: vi.fn(async (args: any) => ({ query: args.query, effectiveQuery: args.query, rating: args.rating, page: args.page, limit: args.limit, hasMore: false, filteredCount: 0, items: [item({ rating: args.rating })] })), detail: vi.fn(async (args: any) => item({ postId: args.postId, rating: args.rating })), image: vi.fn(async (args: any) => ({ postId: args.postId, mimeType: 'image/png', data: 'aGVsbG8=', sourceUrl: item({ postId: args.postId }).sourceUrl, imageUrl: args.variant === 'preview' ? item({ postId: args.postId }).previewUrl : item({ postId: args.postId }).sampleUrl, variant: args.variant })) };
  return { directory, databasePath, repository, open, tags, gallery, service: createMaterialLibraryService({ directory, repository, tags, gallery }) };
}

describe('shared material library persistence', () => {
  it('preserves exact study excerpts and hash provenance across backup without declaring tag evidence', async () => {
    const {service}=await setup();
    const link={studyId:'study-fixture',sourceSha256:'a'.repeat(64),field:'png-text:Comment.prompt',excerpt:'  watercolor, soft lighting\n'};
    const {entry}=await service.library({action:'save',entry:{kind:'note',name:'社区研读',notes:'Agent 观察，待验证',links:[link]}});
    expect(entry.links).toEqual([link]);
    const {data}=await service.library({action:'export',ids:[entry.id]});
    const imported=await service.library({action:'import',data});
    expect((await service.library({action:'read',id:imported.items[0].id})).entry.links).toEqual([link]);
    for(const bad of [{...link,sourceSha256:'bad'},{studyId:link.studyId},{...link,excerpt:'x'.repeat(16001)}]) {
      await expect(service.library({action:'save',entry:{kind:'note',name:'bad',links:[bad]}})).rejects.toMatchObject({code:'invalid_argument'});
    }
  });
  it('canonicalizes official aliases and persists useful facts/wiki with the actual check time', async () => {
    const { service, tags, databasePath } = await setup();
    tags.details.mockResolvedValueOnce(facts('old_name', { canonicalName: 'sample_artist', resolution: 'alias', aliases: [{ from: 'old_name', to: 'sample_artist' }] }));
    const { entry } = await service.library({ action: 'save', entry: tag('old_name') });
    expect(entry).toMatchObject({ revision: 1, tag: { text: 'sample_artist', category: 'artist', evidence: { checkedAt: '2026-09-11T00:00:00.000Z', postCount: 42, resolution: 'alias', wiki: { body: 'Fixture artist meaning.' } } } });
    expect(tags.details).toHaveBeenCalledWith({ name: 'old_name', detail: 'compact' });
    // win32 reports no POSIX permission bits (always 0o666); privacy there relies on the user profile ACL.
    if (process.platform !== 'win32') expect((await fs.stat(databasePath)).mode & 0o777).toBe(0o600);
    expect((await service.library({ action: 'read', id: entry.id })).entry).toEqual(entry);
  });
  it('does not trust caller evidence and retains unknown on network failure', async () => {
    const { service, tags } = await setup(); tags.details.mockRejectedValueOnce(new Error('network unavailable'));
    const value: any = tag(); value.tag.evidence = { canonicalName: 'fake', postCount: 9999999, resolution: 'canonical' };
    const { entry } = await service.library({ action: 'save', entry: value });
    expect(entry.tag).toMatchObject({ text: 'sample_artist', category: null, evidence: { canonicalName: null, postCount: null, deprecated: null, resolution: 'unknown' } });
    await expect(service.samples({ action: 'list', entryId: entry.id })).rejects.toMatchObject({ code: 'material_unverified' });
  });
  it('keeps not_found distinct from unknown and rejects mismatched metadata', async () => {
    const { service, tags } = await setup();
    tags.details.mockResolvedValueOnce(facts('absent', { canonicalName: null, resolution: 'not_found', tagStatus: 'not_found', category: null, postCount: null, deprecated: null }));
    expect((await service.library({ action: 'save', entry: tag('absent') })).entry.tag.evidence.resolution).toBe('not_found');
    tags.details.mockResolvedValueOnce(facts('different'));
    expect((await service.library({ action: 'save', entry: tag() })).entry.tag.evidence.resolution).toBe('unknown');
  });
  it('preserves wiki without repeated lookup when only notes or target changes', async () => {
    const { service, tags } = await setup(); const { entry } = await service.library({ action: 'save', entry: tag() });
    const revised = await service.library({ action: 'save', id: entry.id, expectedRevision: 1, entry: { ...tag(), notes: '用户反馈：线条细', tag: { ...entry.tag, target: 'base' } } });
    expect(revised.entry.revision).toBe(2); expect(tags.details).toHaveBeenCalledTimes(1);
    expect((await service.library({ action: 'read', id: entry.id, revision: 1 })).entry.tag.target).toBe('style');
  });
  it('explicit refresh rechecks unchanged tags and does not hide a new lookup failure', async () => {
    const { service, tags } = await setup(); const { entry } = await service.library({ action: 'save', entry: tag() });
    tags.details.mockRejectedValueOnce(new Error('offline'));
    const revised = await service.library({ action: 'save', id: entry.id, expectedRevision: 1, refreshEvidence: true, entry: tag() });
    expect(tags.details).toHaveBeenCalledTimes(2);
    expect(revised.entry.tag.evidence).toMatchObject({ resolution: 'unknown', postCount: null });
    expect((await service.library({ action: 'read', id: entry.id, revision: 1 })).entry.tag.evidence.resolution).toBe('canonical');
  });
  it('has one CAS winner across concurrent MCP/UI writers and reloads historical records', async () => {
    const { service, directory, open, tags, gallery } = await setup(); const { entry } = await service.library({ action: 'save', entry: tag('watercolor', 'english') });
    const updates = await Promise.allSettled(['A', 'B'].map(notes => service.library({ action: 'save', id: entry.id, expectedRevision: 1, entry: { ...tag('watercolor', 'english'), notes } })));
    expect(updates.map(update => update.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = updates.find(update => update.status === 'rejected') as PromiseRejectedResult; expect(rejected.reason.code).toBe('material_conflict');
    const restarted = createMaterialLibraryService({ directory, repository: open(), tags, gallery });
    expect((await restarted.library({ action: 'read', id: entry.id })).entry.revision).toBe(2);
    expect((await restarted.library({ action: 'read', id: entry.id, revision: 1 })).entry).toEqual(entry);
  });
  it('archives with CAS, supports restore, and keeps current and historical data', async () => {
    const { service } = await setup(); const { entry } = await service.library({ action: 'save', entry: tag('watercolor', 'english') });
    await service.library({ action: 'archive', id: entry.id, expectedRevision: 1 });
    expect((await service.library({ action: 'list' })).total).toBe(0);
    expect((await service.library({ action: 'list', includeArchived: true })).items[0].archived).toBe(true);
    await expect(service.library({ action: 'archive', id: entry.id, expectedRevision: 1, archived: false })).rejects.toMatchObject({ code: 'material_conflict' });
    expect((await service.library({ action: 'archive', id: entry.id, expectedRevision: 2, archived: false })).entry.revision).toBe(3);
  });
  it('lists compact paginated summaries without wiki, full notes or component prompt text', async () => {
    const { service } = await setup(); await service.library({ action: 'save', entry: { ...tag(), group: '画师', notes: 'n'.repeat(400) } });
    await service.library({ action: 'save', entry: { kind: 'combo', name: 'mix', group: '风格', components: [{ text: 'watercolor', source: 'english', weight: 1, target: 'style' }] } });
    const result = await service.library({ action: 'list', limit: 1 });
    expect(result).toMatchObject({ total: 2, hasMore: true, limit: 1 });
    expect(JSON.stringify(result)).not.toContain('Fixture artist meaning.');
    expect((await service.library({ action: 'list', group: '画师' })).items[0].notesPreview.length).toBe(160);
    expect((await service.library({ action: 'list', offset: 1, limit: 1 })).hasMore).toBe(false);
  });
  it('preserves combo order, weights and precise source versions, and rejects mismatches', async () => {
    const { service } = await setup(); const { entry } = await service.library({ action: 'save', entry: tag('watercolor', 'english') });
    const components = [{ text: 'watercolor', source: 'english', weight: .7, target: 'style', entryId: entry.id, entryRevision: 1 }, { text: 'ink', source: 'english', weight: 1.3, target: 'style' }];
    const result = await service.library({ action: 'save', entry: { kind: 'combo', name: 'watercolor ink', components } });
    expect(result.entry.components.map((component: any) => [component.text, component.weight])).toEqual([['watercolor', .7], ['ink', 1.3]]);
    const nested = await service.library({ action: 'save', entry: { kind: 'combo', name: 'combination copy', components: [{ ...components[0], entryId: result.entry.id, entryRevision: 1, weight: 1.3 }] } });
    expect(nested.entry.components[0].entryId).toBe(result.entry.id);
    await expect(service.library({ action: 'save', entry: { kind: 'combo', name: 'wrong combination reference', components: [{ ...components[0], entryId: result.entry.id, entryRevision: 1, text: 'missing' }] } })).rejects.toMatchObject({ code: 'material_reference_mismatch' });
    await expect(service.library({ action: 'save', entry: { kind: 'combo', name: 'bad', components: [{ ...components[0], text: 'different' }] } })).rejects.toMatchObject({ code: 'material_reference_mismatch' });
  });
  it('names the unsupported field when it refuses a link or entry field (for example trialId)', async () => {
    const { service } = await setup();
    await expect(service.library({ action: 'save', entry: { kind: 'note', name: '出处', links: [{ batchId: 'batch-1' }, { trialId: 'trial-1', batchId: 'batch-2' }] } })).rejects.toMatchObject({ code: 'invalid_argument', message: 'links[1] has unsupported fields: trialId.', reason: 'material.unsupported_fields_at', params: { where: 'links[1]', fields: 'trialId' } });
    await expect(service.library({ action: 'save', entry: { kind: 'note', name: '出处', color: 'red', size: 2 } as any })).rejects.toMatchObject({ code: 'invalid_argument', message: 'entry has unsupported fields: color, size.', reason: 'material.unsupported_fields_at', params: { where: 'entry', fields: 'color, size' } });
  });
  it('exports/imports separate copies and preserves original user notes and recipe members', async () => {
    const { service } = await setup(); const original = await service.library({ action: 'save', entry: { kind: 'note', name: '写作记录', notes: '用户反馈：减少重复', links: [{ batchId: 'batch-1', itemIndex: 1, feedback: '更喜欢左边' }] } });
    const { data } = await service.library({ action: 'export' });
    const result = await service.library({ action: 'import', data });
    expect(result.count).toBe(1); expect(result.items[0].id).not.toBe(original.entry.id);
    expect((await service.library({ action: 'read', id: result.items[0].id })).entry.links).toEqual(original.entry.links);
    expect((await service.library({ action: 'read', id: original.entry.id })).entry).toEqual(original.entry);
  });
  it('validates all import rows before saving and never follows caller file paths', async () => {
    const { service } = await setup();
    await expect(service.library({ action: 'import', data: { schemaVersion: 1, entries: [{ kind: 'note', name: 'valid' }, { kind: 'invalid', name: 'bad' }] } })).rejects.toMatchObject({ code: 'invalid_argument' });
    expect((await service.library({ action: 'list' })).total).toBe(0);
    await expect(service.library({ action: 'read', id: '../secret' })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(service.library({ action: 'export', file: '/tmp/private' })).rejects.toMatchObject({ code: 'invalid_argument' });
  });
  it('rejects a malformed revision without changing the saved entry', async () => {
    const { service, repository } = await setup(); const { entry } = await service.library({ action: 'save', entry: tag('ink', 'english') });
    const before = repository.readVersions('tag', entry.id);
    await expect(service.library({ action: 'save', id: entry.id, expectedRevision: 0, entry: tag('ink', 'english') })).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(repository.readVersions('tag', entry.id)).toEqual(before);
  });
  it('does not hold storage writes while a tag lookup is pending', async () => {
    const { service, tags } = await setup(); let resolve!: (value: any) => void;
    tags.details.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const slow = service.library({ action: 'save', entry: tag() });
    await waitUntil(() => expect(resolve).toBeTypeOf('function'));
    const quick = await service.library({ action: 'save', entry: { kind: 'note', name: '用户反馈', notes: '无需等待联网' } });
    expect(quick.entry.revision).toBe(1);
    resolve(facts('sample_artist')); await slow;
  });
});

describe('independent material metadata and samples', () => {
  it('requests artist candidates directly and keeps details out of candidate lists', async () => {
    const { service, tags } = await setup();
    const result = await service.tags({ action: 'search', query: 'sample', category: 'artist' });
    expect(tags.search).toHaveBeenCalledWith({ query: 'sample', limit: 8, category: 'artist' });
    expect(result.items[0].postCount).toBe(42); expect(tags.details).not.toHaveBeenCalled();
  });
  it('returns default three General high-score samples with verified artist membership', async () => {
    const { service, gallery } = await setup(); const { entry } = await service.library({ action: 'save', entry: tag() });
    gallery.search.mockResolvedValueOnce({ query: 'sample_artist rating:g score:>=20 order:score', effectiveQuery: 'sample_artist score:>=20 order:score rating:g', rating: 'g', page: 1, limit: 3, hasMore: true, filteredCount: 0, items: [item(), item({ postId: 43, score: 19 }), item({ postId: 44, tags: { ...item().tags, artists: ['different_artist'] } })] });
    const result = await service.samples({ action: 'list', entryId: entry.id });
    expect(gallery.search).toHaveBeenCalledWith({ query: 'sample_artist rating:g score:>=20 order:score', rating: 'g', page: 1, limit: 3 });
    expect(result).toMatchObject({ minScore: 20, filteredCount: 2, items: [{ postId: 42, score: 30 }] });
    expect(result.items[0].tags).toBeUndefined(); expect(gallery.image).not.toHaveBeenCalled();
  });
  it('merges all ratings, deduplicates, sorts, and paginates the cover candidate pool', async () => {
    const { service, gallery } = await setup(); const { entry } = await service.library({ action: 'save', entry: tag() });
    const rows: Record<string, DanbooruPost[]> = {
      g: [item({ postId: 10, rating: 'g', score: 50 })],
      s: [item({ postId: 30, rating: 's', score: 10 })],
      q: [item({ postId: 20, rating: 'q', score: 40 }), item({ postId: 10, rating: 'q', score: 40 })],
      e: [item({ postId: 40, rating: 'e', score: 30 })],
    };
    gallery.search.mockImplementation(async (args: any) => ({ query: args.query, effectiveQuery: args.query, rating: args.rating, page: args.page, limit: args.limit, hasMore: false, filteredCount: 0, items: rows[args.rating] }));
    const first = await service.samples({ action: 'list_all', entryId: entry.id, minScore: 0, sort: 'newest', limit: 2 });
    expect(first).toMatchObject({ rating: 'all', sort: 'newest', page: 1, limit: 2, hasMore: true });
    expect(first.items.map((value: DanbooruPost) => [value.postId, value.rating])).toEqual([[40, 'e'], [30, 's']]);
    expect(gallery.search).toHaveBeenCalledTimes(4);
    expect(gallery.search).toHaveBeenCalledWith({ query: 'sample_artist rating:q score:>=0 order:id_desc', rating: 'q', page: 1, limit: 30 });
    const second = await service.samples({ action: 'list_all', entryId: entry.id, minScore: 0, sort: 'newest', limit: 2, page: 2 });
    expect(second.items.map((value: DanbooruPost) => value.postId)).toEqual([20, 10]);
    expect(second.hasMore).toBe(false);
    expect((await service.samples({ action: 'list_all', entryId: entry.id, minScore: 0, sort: 'score', limit: 4 })).items.map((value: DanbooruPost) => value.postId)).toEqual([10, 20, 40, 30]);
    expect((await service.samples({ action: 'list_all', entryId: entry.id, minScore: 0, sort: 'oldest', limit: 4 })).items.map((value: DanbooruPost) => value.postId)).toEqual([10, 20, 30, 40]);
  });
  it('passes each explicit rating through list and image, while defaulting to g', async () => {
    const { service, gallery } = await setup(); const { entry } = await service.library({ action: 'save', entry: tag() });
    for (const rating of ['g', 's', 'q', 'e'] as const) {
      const listed = await service.samples({ action: 'list', entryId: entry.id, rating });
      expect(listed.rating).toBe(rating);
      expect(gallery.search).toHaveBeenLastCalledWith({ query: `sample_artist rating:${rating} score:>=20 order:score`, rating, page: 1, limit: 3 });
      expect((await service.samples({ action: 'image', entryId: entry.id, postId: 42, rating })).rating).toBe(rating);
      expect(gallery.image).toHaveBeenLastCalledWith({ postId: 42, rating, variant: 'preview' });
    }
    expect((await service.samples({ action: 'list', entryId: entry.id })).rating).toBe('g');
  });
  it('rejects mismatched search and detail ratings without downloading or changing level', async () => {
    const { service, gallery } = await setup(); const { entry } = await service.library({ action: 'save', entry: tag() });
    gallery.search.mockResolvedValueOnce({ query: 'sample_artist rating:q score:>=20 order:score', effectiveQuery: 'sample_artist score:>=20 order:score rating:q', rating: 'g', page: 1, limit: 3, hasMore: false, filteredCount: 0, items: [] });
    await expect(service.samples({ action: 'list', entryId: entry.id, rating: 'q' })).rejects.toMatchObject({ code: 'invalid_response' });
    gallery.detail.mockResolvedValueOnce(item({ rating: 'g' }));
    await expect(service.samples({ action: 'image', entryId: entry.id, postId: 42, rating: 'e' })).rejects.toMatchObject({ code: 'sample_filtered' });
    expect(gallery.image).not.toHaveBeenCalled();
  });
  it('fails closed when detail rating changes after an image download', async () => {
    const { service, gallery } = await setup(); const { entry } = await service.library({ action: 'save', entry: tag() });
    gallery.detail.mockResolvedValueOnce(item({ rating: 'q' })).mockResolvedValueOnce(item({ rating: 'e' }));
    await expect(service.samples({ action: 'image', entryId: entry.id, postId: 42, rating: 'q' })).rejects.toMatchObject({ code: 'sample_changed' });
    expect(gallery.image).toHaveBeenCalledWith({ postId: 42, rating: 'q', variant: 'preview' });
  });
  it('never broadens rating or lowers score when samples are missing', async () => {
    const { service, gallery } = await setup(); const { entry } = await service.library({ action: 'save', entry: tag() });
    gallery.search.mockResolvedValueOnce({ query: 'sample_artist rating:g score:>=20 order:score', effectiveQuery: 'sample_artist score:>=20 order:score rating:g', rating: 'g', page: 1, limit: 3, hasMore: false, filteredCount: 0, items: [item({ rating: 's' as any }), item({ score: 0 })] });
    expect((await service.samples({ action: 'list', entryId: entry.id })).items).toEqual([]);
    expect(gallery.search).toHaveBeenCalledTimes(1); expect(gallery.image).not.toHaveBeenCalled();
  });
  it('rechecks score and artist ownership before image download and preserves exact provenance', async () => {
    const { service, gallery } = await setup(); const { entry } = await service.library({ action: 'save', entry: tag() });
    gallery.detail.mockResolvedValueOnce(item({ score: 1 }));
    await expect(service.samples({ action: 'image', entryId: entry.id, postId: 42 })).rejects.toMatchObject({ code: 'sample_filtered' });
    expect(gallery.image).not.toHaveBeenCalled();
    expect(await service.samples({ action: 'image', entryId: entry.id, postId: 42 })).toMatchObject({ postId: 42, variant: 'preview', imageUrl: item().previewUrl });
    gallery.image.mockResolvedValueOnce({ postId: 42, mimeType: 'image/png', data: 'aGVsbG8=', sourceUrl: item().sourceUrl, imageUrl: 'https://cdn.donmai.us/changed.png', variant: 'preview' });
    await expect(service.samples({ action: 'image', entryId: entry.id, postId: 42 })).rejects.toMatchObject({ code: 'sample_changed' });
  });
  it('separates sample concurrency from tag and storage operations', async () => {
    const { service, gallery, tags } = await setup(); const { entry } = await service.library({ action: 'save', entry: tag() });
    const resolvers: Array<(value: any) => void> = []; let active = 0, maximum = 0;
    gallery.search.mockImplementation(() => { active++; maximum = Math.max(maximum, active); return new Promise(resolve => resolvers.push(value => { active--; resolve(value); })); });
    const requests = Array.from({ length: 3 }, () => service.samples({ action: 'list', entryId: entry.id }));
    await waitUntil(() => expect(resolvers).toHaveLength(2));
    await service.library({ action: 'save', entry: { kind: 'note', name: 'parallel note' } });
    await service.tags({ action: 'search', query: 'water' }); expect(tags.search).toHaveBeenCalledTimes(1);
    const response = { query: 'sample_artist rating:g score:>=20 order:score', effectiveQuery: 'sample_artist score:>=20 order:score rating:g', rating: 'g', page: 1, limit: 3, hasMore: false, filteredCount: 0, items: [] };
    resolvers[0](response); await waitUntil(() => expect(resolvers).toHaveLength(3)); resolvers[1](response); resolvers[2](response);
    await Promise.all(requests); expect(maximum).toBe(2);
  });
});
