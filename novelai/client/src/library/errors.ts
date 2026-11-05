import { readHostError } from '../host-errors';
import { stripHostErrorSuffixes } from '../host-errors/bridge';
import { hostMessageText } from '../host-errors/compose';
import type { UiLang, UiText } from '../ui/i18n';
import type { UiStringKey } from '../ui/strings';
import { PartialRunError } from './api';

/**
 * Host refusals on the library page in the user's words (review rework): no internal ids ("history:h1", trashIds)
 * and no raw request-validation text. A conflict names the item by its name when the page knows it.
 */
// Every field is read with readHostError: a host error that crossed contextBridge has its structure in its message.
const inner = (failure: unknown) => failure instanceof PartialRunError ? failure.failure : failure;
export const reasonOf = (failure: unknown) => readHostError(inner(failure)).reason ?? '';
export const codeOf = (failure: unknown) => readHostError(inner(failure)).code ?? '';

/** Reasons that mean "the list the confirmation showed is no longer current": check again with the saved state. */
export const STALE_REASONS = new Set(['trash.item_changed', 'trash.item_already_deleted', 'trash.item_not_found', 'library.item_changed', 'library.item_not_found', 'library.item_or_revision_not_found', 'library.item_in_trash', 'trash.entry_not_found']);
export const isStale = (failure: unknown) => STALE_REASONS.has(reasonOf(failure));

/** The kind:id key a host conflict names (params.item), if any. */
export function conflictKey(failure: unknown): string | null {
  const item = readHostError(inner(failure)).params?.item;
  return typeof item === 'string' ? item : null;
}

export function libraryErrorText(failure: unknown, t: UiText, lang: UiLang, names?: ReadonlyMap<string, string>): string {
  const error = inner(failure);
  const reason = reasonOf(error);
  const key = conflictKey(error);
  const name = key ? names?.get(key) : undefined;
  const named = (with_: UiStringKey, without: UiStringKey) => name ? t(with_, { name }) : t(without);
  let text: string;
  switch (reason) {
    case 'trash.item_changed': case 'library.item_changed': text = named('err.changedNamed', 'err.changed'); break;
    case 'trash.item_already_deleted': case 'library.item_in_trash': text = named('err.trashedNamed', 'err.trashed'); break;
    case 'trash.item_not_found': case 'library.item_not_found': case 'library.item_or_revision_not_found': text = named('err.goneNamed', 'err.gone'); break;
    case 'trash.entry_not_found': text = t('err.entryGone'); break;
    case 'library.invalid_request': case 'library.selection_size': case 'trash.trash_ids_size': text = t('err.invalid', { max: 500 }); break;
    default: text = hostMessageText(error, lang === 'zh' ? 'zh-CN' : 'en-US');
  }
  return stripHostErrorSuffixes(failure instanceof PartialRunError && failure.done > 0 ? t('err.partial', { n: failure.done, reason: text }) : text);
}
