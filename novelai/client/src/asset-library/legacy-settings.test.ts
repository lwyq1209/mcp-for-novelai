import { describe, expect, it, vi } from 'vitest';
import { saveAssetSetting } from './legacy-settings';

const preset = { id: 'style-a', name: 'Watercolor', prompt: 'watercolor', group: 'Default', createdAt: '2026-09-12', previewImages: [] };
describe('existing preset editors use versioned material commands', () => {
  it('updates only changed items and carries the checked version to the host', async () => {
    const api = { assetLibrary: vi.fn(async (args: any) => args.action === 'read' ? { item: { revision: 7, archived: false, payload: preset } } : {}) };
    const other = { ...preset, id: 'style-b', name: 'Other' };
    await saveAssetSetting(api, 'stylePromptPresets', [preset, other], [{ ...preset, prompt: 'ink' }, other]);
    expect(api.assetLibrary.mock.calls).toEqual([
      [{ action: 'read', kind: 'style_preset', id: preset.id }],
      [{ action: 'save', kind: 'style_preset', id: preset.id, payload: { ...preset, prompt: 'ink' }, expectedRevision: 7 }],
    ]);
  });
  it('retains a concurrent update and sends no mutation if the editor snapshot is old', async () => {
    const api = { assetLibrary: vi.fn(async () => ({ item: { revision: 8, archived: false, payload: { ...preset, prompt: 'new user text' } } })) };
    await expect(saveAssetSetting(api, 'stylePromptPresets', [preset], [{ ...preset, name: 'My draft' }])).rejects.toMatchObject({ reason: 'library.preset_changed_elsewhere' });
    expect(api.assetLibrary).toHaveBeenCalledTimes(1);
  });
  it('archives a removed preset while retaining its images for other references', async () => {
    const api = { assetLibrary: vi.fn(async (args: any) => args.action === 'read' ? { item: { revision: 3, archived: false, payload: preset } } : {}) };
    await saveAssetSetting(api, 'stylePromptPresets', [preset], []);
    expect(api.assetLibrary).toHaveBeenLastCalledWith({ action: 'mutate', command: 'archive', items: [{ kind: 'style_preset', id: preset.id, expectedRevision: 3 }], patch: { archived: true } });
  });
});
