import type { HostErrorTexts } from "./types";

/**
 * The account (token check, electron/ipc/nai.ts verifyToken; the window wraps them in 没有连上：…) and the settings
 * page's own host answers (step 4c1).
 */
export const ACCOUNT_ERROR_TEXTS: HostErrorTexts = {
  "token.empty": { "zh-CN": "请输入 NovelAI Persistent API Token。", "en-US": "Enter your NovelAI Persistent API Token." },
  "token.invalid": { "zh-CN": "Token 无效或已过期。", "en-US": "The token is invalid or has expired." },
  "token.verify_failed": { "zh-CN": "{detail}", "en-US": "{detail}" },
  "settings.library_kept": { "zh-CN": "风格预设、正文预设与提示词片段保存在素材库中，请使用带版本的素材保存操作。", "en-US": "Style presets, prompt presets and snippets are kept in the library; save them through its versioned save." },
  "settings.output_empty": { "zh-CN": "请选择图片保存目录，保存位置不可留空。", "en-US": "Choose an image folder; it cannot be empty." },
  "settings.folder_relative": { "zh-CN": "保存目录必须是绝对路径。", "en-US": "A save folder must be an absolute path." },
  "settings.folder_in_install": { "zh-CN": "请选择软件安装目录以外的保存位置，例如系统“图片”目录；安装新版本时安装目录会被替换。{folder}", "en-US": "Choose a folder outside the app’s install folder, for example your Pictures folder; installing a new version replaces the install folder. {folder}" },
  "log.file_missing": { "zh-CN": "日志文件还不存在（暂无记录）。", "en-US": "The log file does not exist yet (nothing was logged)." },
};
