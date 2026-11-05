/** Appends a snippet to a prompt field as one more comma-separated part (the library picker and Use on canvas). */
export function appendPromptChunk(value: string, chunk: string): string {
  const current = value.trim();
  const addition = chunk.trim().replace(/^,+\s*/, "").replace(/\s*,+$/, "");
  if (!addition) return value;
  if (!current) return `${addition}, `;
  return `${current.replace(/\s*,?\s*$/, "")}, ${addition}, `;
}
