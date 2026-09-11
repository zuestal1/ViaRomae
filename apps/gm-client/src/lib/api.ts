const configured = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";
export const API_ROOT = configured.endsWith("/api/v1") ? configured : `${configured}/api/v1`;

export async function gmFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("gm_token");
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("gm:unauthorized"));
    const body = await response.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
