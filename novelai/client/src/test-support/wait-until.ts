import { getCurrentTest } from "vitest/suite";

// Captured before any test can install fake timers: the re-check pause is real, whatever the test fakes.
const pause = globalThis.setTimeout.bind(globalThis);

/**
 * Waits until `assertion` stops throwing (and returns its value): a condition that asynchronous work (file I/O, a
 * service loop, real timers) reaches eventually. Unlike vi.waitFor (default 1 s) it has no deadline of its own, so a
 * busy machine only makes it slower, never wrong: the test's own timeout bounds a condition that never comes true,
 * and the last assertion error is then reported. Re-checks every `interval` ms and stops when the test ends. Not for
 * fake timers that must be advanced (use vi.waitFor there), and never a way to sleep.
 */
export async function waitUntil<T>(assertion: () => T | Promise<T>, { interval = 2 }: { interval?: number } = {}): Promise<T> {
  const signal = getCurrentTest()?.context.signal;
  if (!signal) throw new Error("waitUntil runs inside a test body, where the test timeout bounds it.");
  let last: unknown;
  for (;;) {
    if (signal.aborted) throw last instanceof Error ? last : new Error("waitUntil: the test ended before the condition held.");
    try { return await assertion(); } catch (error) { last = error; }
    await new Promise(resolve => pause(resolve, interval));
  }
}
