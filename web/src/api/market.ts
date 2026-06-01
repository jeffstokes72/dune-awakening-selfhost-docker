import { api, post } from "./client";

export const marketApi = {
  capabilities: () => api<Record<string, unknown>>("/api/market/capabilities"),
  items: (q = "") => api<{ rows: Record<string, unknown>[]; capabilities?: Record<string, unknown>; reason?: string }>(`/api/market/items${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  search: (q: string) => api<{ rows: Record<string, unknown>[]; capabilities?: Record<string, unknown>; reason?: string }>(`/api/market/search?q=${encodeURIComponent(q)}`),
  listings: (templateId = "", owner = "") => api<{ rows: Record<string, unknown>[]; reason?: string }>(`/api/market/listings?template_id=${encodeURIComponent(templateId)}&owner=${encodeURIComponent(owner)}`),
  sales: () => api<{ rows: Record<string, unknown>[]; reason?: string }>("/api/market/sales"),
  stats: () => api<{ stats: Record<string, unknown>; reason?: string }>("/api/market/stats"),
  categories: () => api<{ categories: string[] }>("/api/market/categories"),
  catalog: (q = "") => api<{ rows: Record<string, unknown>[] }>(`/api/market/catalog${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  automationStatus: () => api<Record<string, unknown>>("/api/market/automation/status"),
  automationStart: () => post<Record<string, unknown>>("/api/market/automation/start"),
  automationStop: () => post<Record<string, unknown>>("/api/market/automation/stop"),
  automationRunOnce: () => post<Record<string, unknown>>("/api/market/automation/run-once"),
  automationCleanup: () => post<Record<string, unknown>>("/api/market/automation/cleanup"),
  automationHistory: () => api<{ rows: Record<string, unknown>[]; reason?: string }>("/api/market/automation/history")
};
