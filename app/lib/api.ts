/**
 * Writes to the Fleet server. The custom header and the JSON body force a CORS preflight that foreign pages
 * never pass; the server checks both.
 */
/** Like post, but keeps the status: some answers (409 "may still run elsewhere") ask for a second step. */
export async function postStatus(
  path: string,
  body: unknown,
): Promise<{ status: number; ok: boolean; json: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Fleet": "1" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, ok: res.ok, json: json && typeof json === "object" ? json : {} };
}

export async function post<T = Record<string, unknown>>(path: string, body: unknown): Promise<T & { demo?: boolean }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Fleet": "1" },
    body: JSON.stringify(body),
    keepalive: true,
  });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string; demo?: boolean };
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}
