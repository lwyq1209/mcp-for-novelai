import { describe, expect, it, vi } from 'vitest';
import { danbooruTagSearch, pickDanbooruTag } from './CreateDialog';

describe('添加标签 with a Danbooru search (step 4c1)', () => {
  it('asks the host for eight candidates of the trimmed text', async () => {
    const materialTags = vi.fn(async () => ({ query: 'cat', items: [], source: 'danbooru' }));
    await danbooruTagSearch({ materialTags } as never, '  cat ears ');
    expect(materialTags).toHaveBeenCalledWith({ action: 'search', query: 'cat ears', limit: 8 });
  });
  it('a picked tag fills in its Danbooru text; an artist also moves the tag to Style', () => {
    expect(pickDanbooruTag({ name: 'cat_ears', category: 0 })).toEqual({ text: 'cat_ears' });
    expect(pickDanbooruTag({ name: 'some_artist', category: 1 })).toEqual({ text: 'some_artist', target: 'style' });
  });
});
