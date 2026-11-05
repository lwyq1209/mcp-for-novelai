// Short entrance and exit animations with the Web Animations API (Element.animate), in place of the former GSAP
// tweens: same durations, offsets and easing curves. Callers skip them when "Reduce motion" is on
// (html.motion-reduced) and where the API is unavailable; an animation never leaves inline styles behind.

/** GSAP power2.out (ease-out cubic). */
export const EASE_OUT_CUBIC = "cubic-bezier(0.215, 0.61, 0.355, 1)";
/** GSAP power1.in (ease-in quad). */

/** True when "Reduce motion" is on or the element cannot be animated: show the end state at once. */
export function skipMotion(element: Element): boolean {
  return document.documentElement.classList.contains("motion-reduced") || typeof (element as HTMLElement).animate !== "function";
}

function cancelRunning(element: HTMLElement) {
  for (const running of element.getAnimations?.() ?? []) running.cancel();
}

/**
 * Fade and slide `element` in from `transform` (for example translateY(10px)), replacing any animation still running
 * on it (such as an unfinished exit); it ends at its own styles.
 */
export function animateIn(element: HTMLElement, transform: string, duration: number): Animation {
  cancelRunning(element);
  return element.animate([{ opacity: 0, transform }, { opacity: 1, transform: "none" }], { duration, easing: EASE_OUT_CUBIC });
}
