import type { AppLanguage } from '../src/types';

/**
 * Texts the main process shows by itself, outside the window's catalog (step 4c1): the text field context menu and
 * the titles of the native file dialogs. They follow the interface language (settings.language); without readable
 * settings they are English. Errors still go to the window as code + reason (src/host-errors), never from here.
 * main.ts names where the language is read (the settings store), so these modules do not load the store themselves.
 */
let languageSource: () => unknown = () => 'en-US';
export function setInterfaceLanguageSource(source: () => unknown) { languageSource = source; }
export function interfaceLanguage(): AppLanguage {
  try { return languageSource() === 'zh-CN' ? 'zh-CN' : 'en-US'; } catch { return 'en-US'; }
}

export const HOST_TEXTS = {
  'menu.cut': { 'zh-CN': '剪切', 'en-US': 'Cut' },
  'menu.copy': { 'zh-CN': '复制', 'en-US': 'Copy' },
  'menu.paste': { 'zh-CN': '粘贴', 'en-US': 'Paste' },
  'menu.selectAll': { 'zh-CN': '全选', 'en-US': 'Select all' },
  'dialog.chooseImage': { 'zh-CN': '选择图片', 'en-US': 'Choose an image' },
  'dialog.imageFiles': { 'zh-CN': '图片文件', 'en-US': 'Image files' },
  'dialog.exportBackup': { 'zh-CN': '导出 MCP for NovelAI 数据', 'en-US': 'Export MCP for NovelAI data' },
  'dialog.chooseBackup': { 'zh-CN': '选择 MCP for NovelAI 备份', 'en-US': 'Choose an MCP for NovelAI backup' },
  'dialog.backupFiles': { 'zh-CN': 'MCP for NovelAI 备份', 'en-US': 'MCP for NovelAI backup' },
  'dialog.backupFolder': { 'zh-CN': '选择自动备份目录', 'en-US': 'Choose the automatic backup folder' },
  'dialog.logFolder': { 'zh-CN': '选择日志存放文件夹', 'en-US': 'Choose the log folder' },
  'dialog.exportReferences': { 'zh-CN': '导出参考图预设', 'en-US': 'Export reference presets' },
  'dialog.referenceFiles': { 'zh-CN': 'MCP for NovelAI 参考图预设', 'en-US': 'MCP for NovelAI reference presets' },
  'dialog.chooseReferences': { 'zh-CN': '选择参考预设包，先预览差异', 'en-US': 'Choose a reference preset pack (its changes are shown first)' },
  'dialog.exportGroup': { 'zh-CN': '导出分组为 ZIP', 'en-US': 'Export the project as ZIP' },
  'dialog.zipFiles': { 'zh-CN': 'ZIP 压缩包', 'en-US': 'ZIP archive' },
  'dialog.outputFolder': { 'zh-CN': '选择图片保存目录', 'en-US': 'Choose the image folder' },
  'dialog.exportImages': { 'zh-CN': '导出所选素材图片（新 ZIP 文件）', 'en-US': 'Export the selected images (a new ZIP file)' },
  'name.ungrouped': { 'zh-CN': '未分组', 'en-US': 'Ungrouped' },
  'name.all': { 'zh-CN': '全部', 'en-US': 'All' },
} as const satisfies Record<string, Record<AppLanguage, string>>;
export type HostTextKey = keyof typeof HOST_TEXTS;

/** The text in the interface language. */
export const hostText = (key: HostTextKey): string => HOST_TEXTS[key][interfaceLanguage()];
