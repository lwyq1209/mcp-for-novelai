import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DATA_BACKUP_CATEGORIES,
  initialImportConfirmationStage,
  integrityReasonsForSelection,
  requiresCredentialExportConfirmation,
  withMergedCounts,
} from './data-backup';
import { hostMessageText } from '../../host-errors/compose';

describe('backup settings safety defaults',()=>{
  it('excludes credentials by default while requiring a separate confirmation when explicitly selected',()=>{
    expect(DEFAULT_DATA_BACKUP_CATEGORIES).not.toContain('apiCredentials');
    expect(requiresCredentialExportConfirmation(DEFAULT_DATA_BACKUP_CATEGORIES)).toBe(false);
    expect(requiresCredentialExportConfirmation([...DEFAULT_DATA_BACKUP_CATEGORIES,'apiCredentials'])).toBe(true);
  });
  it('routes degraded archives through their dedicated confirmation before ordinary import confirmation',()=>{
    expect(initialImportConfirmationStage(false)).toBe(1);
    expect(initialImportConfirmationStage(undefined)).toBe(1);
    expect(initialImportConfirmationStage(true)).toBe(4);
    const reasons=[{code:'library-assets-missing',message:'library',categories:['imageHistory','artistLibrary','referencePresets','promptPresets'] as any},{code:'portable-assets-missing:imageHistory',message:'image',categories:['imageHistory'] as any}];
    expect(integrityReasonsForSelection(reasons,['promptPresets'])).toEqual([]);
    expect(integrityReasonsForSelection(reasons,['imageHistory'])).toMatchObject([{code:'portable-assets-missing:imageHistory'}]);
    expect(integrityReasonsForSelection(reasons,['imageHistory','artistLibrary','referencePresets','promptPresets'])).toHaveLength(2);
  });
});

describe('backup result texts',()=>{
  it('renders the import receipt with the counts after the workspace merge in either language',()=>{
    const result={ok:true,code:'backup_imported',reason:'backup.imported',message:'Import complete: 2 added, 0 skipped, 0 renamed.',params:{imported:2,skipped:0,renamed:0},imported:5,skipped:1,renamed:0};
    expect(hostMessageText(withMergedCounts(result),'zh-CN')).toBe('导入完成：新增 5 项，跳过 1 项，重命名 0 项。');
    expect(hostMessageText(withMergedCounts(result),'en-US')).toBe('Import complete: 5 added, 1 skipped, 0 renamed.');
    // A result without params (an older host) keeps its message.
    expect(hostMessageText(withMergedCounts({ok:false,message:'旧消息',imported:0,skipped:0,renamed:0}),'en-US')).toBe('旧消息');
  });
});
