import { afterEach, describe, expect, it } from 'vitest';
import { HOST_TEXTS, hostText, interfaceLanguage, setInterfaceLanguageSource } from './host-language';

afterEach(() => setInterfaceLanguageSource(() => 'en-US'));

describe('the main process’s own texts follow the interface language (step 4c1)', () => {
  it('reads the language from its source; English without one or when it fails', () => {
    expect(interfaceLanguage()).toBe('en-US');
    setInterfaceLanguageSource(() => 'zh-CN');
    expect(hostText('menu.paste')).toBe('粘贴');
    setInterfaceLanguageSource(() => { throw new Error('settings not ready'); });
    expect(hostText('menu.paste')).toBe('Paste');
    setInterfaceLanguageSource(() => 'ja');
    expect(interfaceLanguage()).toBe('en-US');
  });
  it('every text has both languages; English has no Chinese', () => {
    for (const [key, text] of Object.entries(HOST_TEXTS)) {
      expect(text['zh-CN'].trim(), key).not.toBe('');
      expect(text['en-US'], key).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });
});
