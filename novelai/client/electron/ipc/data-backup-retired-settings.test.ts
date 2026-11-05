// A configuration backed up by a version that still had removed features carries their
// settings. Importing it must drop those keys (as loading a settings file does), write
// only known keys to the settings file and count only the keys actually imported.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => key === 'exe' ? path.join(fixture.root, 'app', 'MCP for NovelAI') : path.join(fixture.root, key),
    getVersion: () => 'fixture',
    isPackaged: false,
  },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unavailable'); }, decryptString: () => { throw new Error('unavailable'); } },
}));

const closers: Array<() => void> = [];
afterEach(async () => {
  closers.splice(0).forEach(close => { try { close(); } catch { /* closed */ } });
  vi.resetModules();
  await fs.rm(fixture.root, { recursive: true, force: true });
});

const REMOVED = {
  reversePromptTemplates: { tags: 'old reverse template', natural: '', mixed: '' },
  proxyForMcp: false,
  comicAnalyzePromptTemplate: 'split the story into panels',
};

describe('importing a configuration from a version with removed features', () => {
  it('keeps only known settings in the settings file and in the import count', async () => {
    fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-backup-retired-settings-'));
    const userData = path.join(fixture.root, 'userData');
    const libraryDirectory = path.join(fixture.root, 'library');
    await fs.mkdir(userData, { recursive: true }); await fs.mkdir(libraryDirectory, { recursive: true });
    const outputDir = path.join(fixture.root, 'pictures', 'out');
    await fs.mkdir(outputDir, { recursive: true });
    const settingsFile = path.join(userData, 'settings.json');
    await fs.writeFile(settingsFile, JSON.stringify({ settings: { hasOnboarded: true, outputDir, backupDir: path.join(userData, 'backups'), language: 'zh-CN' } }));

    const { openLibraryRepository } = await import('../library/repository');
    const repository = openLibraryRepository({ filePath: path.join(fixture.root, 'library.sqlite'), libraryDirectory, userDataRoot: userData });
    closers.push(() => repository.close());
    const { activateLibrary, deactivateLibrary } = await import('../library-runtime');
    activateLibrary(repository, { libraryDirectory, userDataRoot: userData });
    closers.unshift(() => deactivateLibrary());
    const backup = await import('./data-backup');
    const store = await import('./store');

    const exported = await backup.exportDataBackup({ destination: 'internal', categories: ['configuration'] });
    expect(exported.ok, exported.message).toBe(true);
    const zip = await JSZip.loadAsync(await fs.readFile(exported.path!));
    const configuration = { ...JSON.parse(await zip.file('data/configuration.json')!.async('string')), language: 'en-US', imageNameTemplate: '{seq}_imported', ...REMOVED };
    const params = JSON.parse(await zip.file('data/generation-params.json')!.async('string'));
    zip.file('data/configuration.json', JSON.stringify(configuration));
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    manifest.categories.find((item: any) => item.category === 'configuration').items = Object.keys(configuration).length + Object.keys(params).length;
    zip.file('manifest.json', JSON.stringify(manifest));
    await fs.writeFile(exported.path!, await zip.generateAsync({ type: 'nodebuffer' }));

    const restored = await backup.importDataBackup({ path: exported.path!, categories: ['configuration'], confirmConfigurationOverwrite: true });
    expect(restored.ok, restored.message).toBe(true);
    const removedCount = Object.keys(REMOVED).length;
    expect(restored.imported).toBe(Object.keys(configuration).length - removedCount + Object.keys(params).length);

    const file = JSON.parse(await fs.readFile(settingsFile, 'utf8')), written = file.settings;
    // The settings file holds the settings (and token/account when there are any), nothing of the library.
    expect(Object.keys(file)).toEqual(['settings']);
    for (const key of ['stylePromptPresets', 'stylePromptPresetGroups', 'positivePromptPresets', 'promptChunks']) expect(Object.hasOwn(written, key), key).toBe(false);
    for (const key of Object.keys(REMOVED)) {
      expect(Object.hasOwn(written, key), `settings file: ${key}`).toBe(false);
      expect(Object.hasOwn(store.getSettings(), key), `settings: ${key}`).toBe(false);
    }
    expect(written).toMatchObject({ language: 'en-US', imageNameTemplate: '{seq}_imported', outputDir });
    expect(store.getSettings()).toMatchObject({ language: 'en-US', imageNameTemplate: '{seq}_imported', outputDir });
  });
});
