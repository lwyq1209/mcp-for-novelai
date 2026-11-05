import { useEffect, useMemo, useState } from 'react';
import { libraryErrorText } from './errors';
import { Button, Dialog, Icon, Spinner, Tag, showToast } from '../ui';
import { useUiText, type UiText } from '../ui/i18n';
import type { ImageMetadataReport } from '../png-meta';
import type { LibraryApi } from './api';
import { applyReportToCanvas, checkImportFile, fileBase64, IMPORT_BATCH_LIMIT, readReport, reportFields, reportHasSettings } from './image-meta';
import { modelName, samplerName } from './present';

/** Files dropped or chosen on 导入图片: the valid ones, and the names refused (by reason). */
export function acceptImportFiles(files: readonly File[], t: UiText) {
  const accepted: File[] = [], refused: string[] = [];
  for (const file of files) {
    const check = checkImportFile(file);
    if (check.ok) accepted.push(file); else refused.push(check.reason === 'size' ? t('imp.tooLarge', { name: file.name }) : t('imp.badType', { name: file.name }));
  }
  if (accepted.length > IMPORT_BATCH_LIMIT) { refused.push(t('imp.tooMany')); accepted.length = IMPORT_BATCH_LIMIT; }
  return { accepted, refused };
}

type Row = { file: File; url: string; report: ImageMetadataReport | null | undefined; state: 'new' | 'imported' | 'duplicate' };

/**
 * 导入图片 with 读取图片原数据 (user decision 4, prototype 11): every dropped image is read first; then it is imported
 * into the library, used on the canvas (its prompt and settings), or closed without importing. importable false (the
 * canvas's 图片原数据 of an image already in the library, step 4c1) offers no import: it would copy a history image
 * into a second, imported one.
 */
export function ImportReader({ api, files, onClose, onReused, importable = true }: { api: LibraryApi; files: File[]; onClose(): void; onReused(): void; importable?: boolean }) {
  const { t, lang } = useUiText();
  const [rows, setRows] = useState<Row[]>(() => files.map(file => ({ file, url: typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '', report: undefined, state: 'new' })));
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    rows.forEach((row, at) => { void row.file.arrayBuffer().then(buffer => readReport(buffer)).catch(() => null).then(report => { if (live) setRows(current => current.map((value, i) => i === at ? { ...value, report } : value)); }); });
    return () => { live = false; rows.forEach(row => row.url && URL.revokeObjectURL?.(row.url)); };
  }, []);
  const row = rows[index];
  const left = useMemo(() => rows.filter(value => value.state === 'new'), [rows]);
  const importRows = async (targets: Row[]) => {
    setBusy(true);
    let imported = 0;
    try {
      for (const target of targets) {
        const result = await api.materialStudies!({ action: 'import', name: target.file.name, data: await fileBase64(target.file) }) as { duplicate?: boolean };
        if (!result.duplicate) imported++;
        setRows(current => current.map(value => value === target || value.file === target.file ? { ...value, state: result.duplicate ? 'duplicate' : 'imported' } : value));
        if (result.duplicate && targets.length === 1) showToast({ message: t('imp.duplicate') });
      }
      if (imported) showToast({ message: t('imp.imported', { n: imported }), tone: 'ok' });
      const next = rows.findIndex((value, i) => i > index && value.state === 'new' && !targets.includes(value));
      if (targets.length > 1 || next < 0) onClose(); else setIndex(next);
    } catch (failure) { showToast({ message: libraryErrorText(failure, t, lang), tone: 'danger' }); }
    finally { setBusy(false); }
  };
  if (!row) return null;
  const settings = reportHasSettings(row.report);
  const fields = row.report ? reportFields(row.report) : null;
  return <Dialog open onClose={onClose} busy={busy} title={t('imp.read.title')} description={rows.length > 1 ? t('imp.read.position', { i: index + 1, n: rows.length }) : row.file.name} icon="imported" width={640}
    footer={<>
      <Button variant="ghost" onClick={onClose} disabled={busy}>{t('imp.read.skip')}</Button>
      {rows.length > 1 && index < rows.length - 1 && <Button variant="ghost" iconAfter="right" disabled={busy} onClick={() => setIndex(index + 1)}>{t('imp.read.next')}</Button>}
      <Button icon="canvas" variant={importable ? 'default' : 'primary'} disabled={busy || !settings} title={t('imp.read.reuseHint')} onClick={() => { applyReportToCanvas(row.report!); showToast({ message: t('imp.reused'), tone: 'ok' }); onReused(); }} data-testid="import-reader-reuse">{t('imp.read.reuse')}</Button>
      {importable && left.length > 1 && <Button disabled={busy} onClick={() => void importRows(left)}>{t('imp.read.importAll', { n: left.length })}</Button>}
      {importable && <Button variant="primary" icon="download" busy={busy} disabled={row.state !== 'new'} onClick={() => void importRows([row])} data-testid="import-reader-import">{t('imp.read.import')}</Button>}
    </>}>
    <div className="lib-read">
      <div className="lib-read-img">{row.url ? <img src={row.url} alt={row.file.name} /> : <Icon name="image" size={28} />}</div>
      <div className="lib-read-body">
        {rows.length > 1 && <p className="lib-read-name ui-mono">{row.file.name}</p>}
        {row.state !== 'new' && <p>{row.state === 'imported' ? <Tag tone="ok" icon="check">{t('imp.imported', { n: 1 })}</Tag> : <Tag>{t('imp.duplicate')}</Tag>}</p>}
        {row.report === undefined ? <p className="ui-muted" role="status"><Spinner size={14} /> {t('imp.read.reading')}</p> : !settings || !fields ? <p className="ui-muted">{t('imp.read.none')}</p> : <>
          <p className="ui-faint">{t('imp.read.kind', { kind: row.report!.kind === 'novelai' ? 'NovelAI' : row.report!.kind === 'stable-diffusion' ? 'Stable Diffusion' : row.report!.kind === 'comfyui' ? 'ComfyUI' : row.report!.software || '—' })}</p>
          {fields.stylePrompt && <><div className="lib-plabel">{t('d.style')}</div><div className="lib-ptext ui-mono is-clamped">{fields.stylePrompt}</div></>}
          {fields.positivePrompt && <><div className="lib-plabel">{t('d.positive')}</div><div className="lib-ptext ui-mono is-clamped">{fields.positivePrompt}</div></>}
          {fields.negativePrompt && <><div className="lib-plabel">{t('d.negative')}</div><div className="lib-ptext ui-mono is-clamped">{fields.negativePrompt}</div></>}
          <dl className="lib-kv">
            {fields.model && <div className="lib-kv-row"><dt>{t('d.p.model')}</dt><dd>{modelName(fields.model)}</dd></div>}
            {fields.width && fields.height && <div className="lib-kv-row"><dt>{t('d.p.size')}</dt><dd className="ui-num">{fields.width} × {fields.height}</dd></div>}
            {fields.steps !== undefined && <div className="lib-kv-row"><dt>{t('d.p.steps')}</dt><dd className="ui-num">{fields.steps}</dd></div>}
            {fields.cfgScale !== undefined && <div className="lib-kv-row"><dt>{t('d.p.cfg')}</dt><dd className="ui-num">{fields.cfgScale}</dd></div>}
            {fields.sampler && <div className="lib-kv-row"><dt>{t('d.p.sampler')}</dt><dd>{samplerName(fields.sampler)}</dd></div>}
            {fields.seed !== undefined && <div className="lib-kv-row"><dt>{t('d.p.seed')}</dt><dd className="ui-num">{fields.seed}</dd></div>}
            {fields.characters.length > 0 && <div className="lib-kv-row"><dt>{t('imp.read.characters', { n: fields.characters.length })}</dt><dd className="ui-mono lib-kv-file">{fields.characters.map(value => value.prompt).join(' | ')}</dd></div>}
          </dl>
        </>}
      </div>
    </div>
  </Dialog>;
}
