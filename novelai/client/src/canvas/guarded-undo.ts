import { showToast, type ToastTone } from '../ui';
import type { UiText } from '../ui/i18n';

/**
 * Undo of one step of the canvas (an insert from the library, an artist pick, a combo, a clear): it restores the
 * values from before the step only while the fields it touched still hold the values the step left (step 4b3
 * review rework). A field edited since is never overwritten: the undo says so and does nothing.
 */
export interface GuardedStep<T> {
  /** The fields now (read at the moment of the undo). */
  read(): T;
  /** The fields right after the step. */
  after: T;
  /** Puts the fields from before the step back. */
  restore(): void;
}

/** Same values (structurally): the fields are plain data (text, numbers, arrays and records of them). */
export const sameValues = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Runs the undo of a step: restores it when nothing changed since, else says that it changed. Returns whether it undid. */
export function undoStep<T>(step: GuardedStep<T>, t: UiText): boolean {
  if (!sameValues(step.read(), step.after)) {
    showToast({ message: t('cv.undo.changed'), tone: 'warn' });
    return false;
  }
  step.restore();
  showToast({ message: t('cv.lib.undone') });
  return true;
}

/** The toast of a step with its 撤销 action. */
export function showStepToast<T>(t: UiText, message: string, step: GuardedStep<T>, tone: ToastTone = 'ok', durationMs = 8000) {
  showToast({ message, tone, durationMs, action: { label: t('cv.draft.undo'), onClick: () => { undoStep(step, t); } } });
}
