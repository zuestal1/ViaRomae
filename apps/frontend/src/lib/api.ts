/**
 * Typed API client – thin fetch wrapper.
 * Uses the shared @jlw/contracts types for request/response shapes.
 */
const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/+$/, "") ?? "";

export type ApiTransport = "http" | "websocket";

/**
 * API root shared by all frontend clients. A configured value may either be a
 * host (for example `https://api.example.com`) or the complete `/api/v1` root.
 */
export function getApiBaseUrl(transport: ApiTransport = "http"): string {
  const httpBase = configuredBaseUrl
    ? configuredBaseUrl.endsWith("/api/v1")
      ? configuredBaseUrl
      : `${configuredBaseUrl}/api/v1`
    : "/api/v1";

  if (transport === "http") return httpBase;

  // Relative API URLs use the current origin (Vite proxy in development and
  // nginx in same-origin production). Absolute API URLs retain their host.
  const websocketBase = new URL(httpBase, window.location.origin);
  websocketBase.protocol = websocketBase.protocol === "https:" ? "wss:" : "ws:";
  return websocketBase.href.replace(/\/$/, "");
}

export const API_BASE = getApiBaseUrl();

async function request<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const token = localStorage.getItem("jlw_token");
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const errorBody = body as { message?: string; error?: string };
    throw new Error(errorBody.message ?? errorBody.error ?? `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
