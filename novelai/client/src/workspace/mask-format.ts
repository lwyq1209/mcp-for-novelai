/** NovelAI's canonical selection mask carries selection in both RGB and alpha.
 * Conventional opaque grayscale masks instead carry it in luminance. */
export function canonicalizeWorkspaceMask(source: Uint8ClampedArray, width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || source.length !== width * height * 4) throw new RangeError("Invalid mask dimensions or RGBA pixels.");
  let hasTransparency = false;
  for (let index = 3; index < source.length; index += 4) if (source[index] !== 255) { hasTransparency = true; break; }
  const rgba = new Uint8ClampedArray(source.length);
  let changed = false;
  for (let index = 0; index < source.length; index += 4) {
    const selected = hasTransparency ? source[index + 3] > 0
      : (0.2126 * source[index] + 0.7152 * source[index + 1] + 0.0722 * source[index + 2]) >= 128;
    const value = selected ? 255 : 0;
    for (let channel = 0; channel < 4; channel += 1) {
      rgba[index + channel] = value;
      changed ||= source[index + channel] !== value;
    }
  }
  return { rgba, changed, interpretation: hasTransparency ? "alpha" as const : "luminance" as const };
}
