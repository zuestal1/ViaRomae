/**
 * Typed API client – thin fetch wrapper.
 * Uses the shared @jlw/contracts types for request/response shapes.
 */
const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";

/**
 * API root shared by all frontend clients. A configured value may either be a
 * host (for example `https://api.example.com`) or the complete `/api/v1` root.
 */
export const API_BASE = configuredBaseUrl
  ? configuredBaseUrl.endsWith("/api/v1")
    ? configuredBaseUrl
    : `${configuredBaseUrl}/api/v1`
  : "/api/v1";

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
