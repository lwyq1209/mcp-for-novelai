/** Cancels a decoded mask when a newer image, revision or edit supersedes it. */
export function createMaskRestoreGate() {
  let sequence = 0;
  return {
    cancel: () => { sequence += 1; },
    async restore<T>(decode: () => Promise<T>, isCurrent: () => boolean, apply: (value: T) => void): Promise<boolean> {
      const ticket = ++sequence;
      const decoded = await decode();
      if (ticket !== sequence || !isCurrent()) return false;
      apply(decoded);
      return true;
    },
  };
}
