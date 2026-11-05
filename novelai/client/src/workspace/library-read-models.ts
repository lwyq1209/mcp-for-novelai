import { isCancelledError } from '@tanstack/react-query';
import { libraryChangeAffectsKinds, libraryChangeIds, SETTINGS_LIBRARY_KINDS, type LibraryChangeBatch } from '../asset-library/library-changes';
import { hostErrorText } from '../host-errors';
import { normalizeAppLanguage } from '../i18n';
import { useAppStore } from '../store';

export interface LibraryReadModelPorts {
  refreshSettings(): Promise<unknown>;
  refreshHistoryItems(ids: readonly string[] | null): Promise<unknown>;
}
export type LibraryReadModel = 'settings' | 'history';
export interface LibraryReadModelRefresh { model: LibraryReadModel; read: Promise<unknown> }
/**
 * Per read model: null = the read succeeded, otherwise what it failed with (kept as it came, rendered in the interface
 * language when shown: step 4c1); superseded (cancelled) reads are absent.
 */
export type LibraryReadModelOutcome = Partial<Record<LibraryReadModel, LibraryReadModelFailure | null>>;
export type LibraryReadModelErrors = Partial<Record<LibraryReadModel, LibraryReadModelFailure>>;
/** A failed read: the error it rejected with, or { unknown: true } when it rejected with something else. */
export type LibraryReadModelFailure = Error | { unknown: true };
const READ_FAILED = { 'zh-CN': '素材变化回读失败，请刷新核对。', 'en-US': 'The library changed but reading it again failed; refresh to check.' } as const;
const SEPARATOR = { 'zh-CN': '；', 'en-US': '; ' } as const;

/**
 * Background read models a library change batch can affect (2026-11-01):
 * settings only for the kinds getSettings() projects, history (incrementally
 * when the batch names its identities) only for history. An unknown batch
 * refreshes both in full. (Artist favorites have had no renderer read model of
 * their own since the artist lab was removed.)
 */
export function refreshLibraryReadModels(batch: LibraryChangeBatch, ports: LibraryReadModelPorts): LibraryReadModelRefresh[] {
  const reads: LibraryReadModelRefresh[] = [];
  if (libraryChangeAffectsKinds(batch, SETTINGS_LIBRARY_KINDS)) reads.push({ model: 'settings', read: ports.refreshSettings() });
  if (libraryChangeAffectsKinds(batch, ['history'])) reads.push({ model: 'history', read: ports.refreshHistoryItems(libraryChangeIds(batch, 'history')) });
  return reads;
}

/** Settles one batch's reads per read model; a newer snapshot cancelling an old read is neither success nor failure. */
export async function settleLibraryReadModels(reads: readonly LibraryReadModelRefresh[]): Promise<LibraryReadModelOutcome> {
  const settled = await Promise.allSettled(reads.map(entry => entry.read)), outcome: LibraryReadModelOutcome = {};
  settled.forEach((result, index) => {
    const model = reads[index].model;
    if (result.status === 'fulfilled') outcome[model] = null;
    // A host error reads in the interface language (src/host-errors).
    else if (!isCancelledError(result.reason)) outcome[model] = result.reason instanceof Error ? result.reason : { unknown: true };
  });
  return outcome;
}

/**
 * A read model's error stays until that same read model reads successfully
 * (review P3-1): an unrelated success, or a batch that does not touch it, must
 * not hide it. A successful history read includes every identity whose earlier
 * incremental read failed, so clearing it means those items were repaired.
 */
export function nextLibraryReadModelErrors(previous: LibraryReadModelErrors, outcome: LibraryReadModelOutcome): LibraryReadModelErrors {
  const next: LibraryReadModelErrors = { ...previous };
  for (const [model, error] of Object.entries(outcome) as Array<[LibraryReadModel, LibraryReadModelFailure | null]>) {
    if (error === null) delete next[model]; else next[model] = error;
  }
  return next;
}

/** The banner text in the interface language (a host error by its catalog text; distinct texts joined). */
export function libraryReadModelErrorText(errors: LibraryReadModelErrors | LibraryReadModelOutcome, language: unknown = useAppStore.getState().settings?.language): string {
  const lang = normalizeAppLanguage(language);
  const texts = Object.values(errors).filter((error): error is LibraryReadModelFailure => !!error)
    .map(error => error instanceof Error ? hostErrorText(error, lang, READ_FAILED[lang]) : READ_FAILED[lang]);
  return [...new Set(texts)].join(SEPARATOR[lang]);
}
