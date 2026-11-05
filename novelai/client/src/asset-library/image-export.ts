import type { AssetKind } from './types';

/** Desktop-only. No paths, URLs, titles, prompts or global settings cross this boundary. */
export interface ImageExportRequest {
  items: Array<{ kind: AssetKind; id: string; revision: number }>;
  stripMetadata: boolean;
}
export type ImageExportReason = 'original' | 'preview' | 'no_image' | 'changed' | 'unavailable' | 'unsupported' | 'animated' | 'limit' | 'stealth' | 'verification' | 'io' | 'destination_exists';
export interface ImageExportRow {
  item: number;
  image?: number;
  status: 'success' | 'skipped' | 'failed';
  reason: ImageExportReason;
  file?: string;
}
export interface ImageExportResult {
  status: 'saved' | 'cancelled' | 'failed';
  stripMetadata: boolean;
  rows: ImageExportRow[];
  success: number;
  skipped: number;
  failed: number;
}
export const IMAGE_EXPORT_REASONS: Record<ImageExportReason, string> = {
  destination_exists: '目标已存在或是源文件，请选择新的 ZIP 文件名',
  original: '原图', preview: '配图／预览（非生成原图）', no_image: '没有已登记图片', changed: '版本或图片关系已变化，请刷新重选',
  unavailable: '原文件缺失、变化或路径不安全', unsupported: '不支持的格式／位深', animated: '多帧图片不支持隐私清理',
  limit: '超过大小、尺寸或批次数量限制', stealth: '发现已知隐写，无法可靠清理，未导出', verification: '清理／发布验证失败，未确认保存', io: '输出失败，请检查保存位置',
};
/** Unknown/incomplete IPC acknowledgements are never displayed as saved. */
export function isImageExportResult(value: unknown): value is ImageExportResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as ImageExportResult;
  if (!['saved','cancelled','failed'].includes(result.status) || typeof result.stripMetadata !== 'boolean' || !Array.isArray(result.rows) || result.rows.length > 400) return false;
  if (result.rows.some(row => !row || !Number.isInteger(row.item) || row.item<1 || row.item>100 || (row.image!==undefined && (!Number.isInteger(row.image)||row.image<1||row.image>300)) || !['success','skipped','failed'].includes(row.status) || !Object.hasOwn(IMAGE_EXPORT_REASONS,row.reason))) return false;
  if (result.success!==result.rows.filter(row=>row.status==='success').length || result.skipped!==result.rows.filter(row=>row.status==='skipped').length || result.failed!==result.rows.filter(row=>row.status==='failed').length) return false;
  return result.status==='saved' ? result.success>0 : result.success===0 && (result.status!=='cancelled'||result.rows.length===0);
}
