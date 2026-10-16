/** Fingerprint of tool calls. Kept tiny: the hook loads it on every tool call. */
export function sig(tool: string, input: unknown): string {
  const s = `${tool}:${JSON.stringify(input ?? null).slice(0, 4000)}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${tool}:${(h >>> 0).toString(36)}`;
}
