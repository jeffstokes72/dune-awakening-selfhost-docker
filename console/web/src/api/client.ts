export type ApiResult<T = unknown> = Promise<T>;

let csrfToken: string | null = null;

export function setCsrfToken(value: string | null) {
  csrfToken = value;
}

export async function api<T>(path: string, options: RequestInit = {}): ApiResult<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData) && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (csrfToken && !["GET", "HEAD"].includes(options.method || "GET")) headers.set("x-csrf-token", csrfToken);
  const response = await fetch(path, { ...options, headers, credentials: "include" });
  const text = await response.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: response.ok ? "The server returned an unexpected response." : text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) };
    }
  }
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  if (response.status === 401 || response.status === 403) {
    const rawError = String(record.error || "");
    if (/authentication required|csrf token/i.test(rawError)) {
      throw new Error("Your console session expired or the console restarted. Refresh the page, then sign in again.");
    }
  }
  if (!response.ok) throw new Error(String(record.error || `Request failed: ${response.status}`));
  return data as T;
}

export function post<T>(path: string, body: unknown = {}) {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}
