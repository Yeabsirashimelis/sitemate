/**
 * API client. Every call goes through `api`, which adds the session token,
 * turns error responses into ApiError with the server's message, and signs
 * the person out when the session has expired.
 */

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "http://localhost:3000";
const TOKEN_KEY = "sitemate.token";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode or blocked storage: the session lasts until the tab closes.
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; raw?: boolean; csv?: string } = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.csv !== undefined) headers["content-type"] = "text/csv";

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : init.csv !== undefined ? { body: init.csv } : {}),
    });
  } catch {
    throw new ApiError(0, "network", "Cannot reach the SiteMate server. Check your connection.");
  }

  if (response.status === 401 && token) {
    setToken(null);
    onUnauthorized();
  }
  if (!response.ok) {
    let payload: { error?: { code?: string; message?: string; details?: unknown } } = {};
    try {
      payload = await response.json();
    } catch {
      // Not JSON; fall back to the status text.
    }
    throw new ApiError(
      response.status,
      payload.error?.code ?? "error",
      payload.error?.message ?? response.statusText ?? "Something went wrong",
      payload.error?.details,
    );
  }
  if (response.status === 204) return undefined as T;
  if (init.raw) return (await response.blob()) as T;
  return (await response.json()) as T;
}

/** Downloads a protected file (CSV, photo) with the session token and opens it. */
export async function download(path: string, fileName: string): Promise<void> {
  const blob = await api<Blob>(path, { raw: true });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function mediaUrl(path: string): Promise<string> {
  const blob = await api<Blob>(path, { raw: true });
  return URL.createObjectURL(blob);
}
