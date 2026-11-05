import { describe, expect, it } from 'vitest';
import { hostError } from './host-error';
import { errorText, hostDetail, hostMessage, MAX_DETAILS } from './host-message';

describe('host messages with details', () => {
  it('carries code, English message, reason, params and one level of details', () => {
    const inner = hostError('backup_invalid_archive', 'The backup file is empty.', 'backup.file_empty');
    expect(hostMessage('backup_read_failed', 'Could not read the backup: The backup file is empty.', undefined, { detail: 'The backup file is empty.' }, { detail: inner })).toEqual({
      code: 'backup_read_failed', message: 'Could not read the backup: The backup file is empty.', params: { detail: 'The backup file is empty.' },
      details: { detail: { code: 'backup_invalid_archive', message: 'The backup file is empty.', reason: 'backup.file_empty' } },
    });
    expect(hostMessage('backup_auto_disabled', 'Automatic backup is off.')).toEqual({ code: 'backup_auto_disabled', message: 'Automatic backup is off.' });
  });

  it('flattens a detail to code, clipped message, reason and params (no nested details)', () => {
    const nested = hostMessage('reference_imported', 'x'.repeat(3000), 'reference_import.partial', { imported: 1 }, { detail: new Error('inner') });
    const detail = hostDetail(nested);
    expect(detail).toEqual({ code: 'reference_imported', message: 'x'.repeat(2000), reason: 'reference_import.partial', params: { imported: 1 } });
    expect(hostDetail('plain text')).toMatchObject({ code: 'host_error', message: 'plain text' });
    expect(hostDetail(Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }))).toEqual({ code: 'host_error', message: 'EACCES: denied' });
    expect(hostDetail(undefined, 'reference_import_failed', 'The import did not complete.')).toEqual({ code: 'reference_import_failed', message: 'The import did not complete.' });
  });

  it(`keeps at most ${MAX_DETAILS} entries of an array detail`, () => {
    const warnings = Array.from({ length: 30 }, (_, index) => ({ code: 'backup_warning', message: `w${index}` }));
    expect((hostMessage('backup_imported', 'done', 'backup.imported_warnings', undefined, { warnings }).details!.warnings as unknown[]).length).toBe(MAX_DETAILS);
  });

  it('reads the English text of an unknown error', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText({ message: 'object' })).toBe('object');
    expect(errorText('text')).toBe('text');
    expect(errorText(null, 'fallback')).toBe('fallback');
  });
});
