import { api, post } from "./client";

export const worldDataApi = {
  storage: () => api<{ rows: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>("/api/storage"),
  storageItems: (id: string) => api<{ rows: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>(`/api/storage/${encodeURIComponent(id)}/items`),
  storageGiveItem: (id: string, body: { itemName: string; quantity: number; confirmation: string }) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/storage/${encodeURIComponent(id)}/give-item`, body),
  storageExportUrl: (id: string) => `/api/storage/${encodeURIComponent(id)}/export`,
  bases: () => api<{ rows: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>("/api/bases"),
  baseExportUrl: (id: string) => `/api/bases/${encodeURIComponent(id)}/export`,
  baseExportBlueprint: (id: string) => post<Record<string, unknown>>(`/api/bases/${encodeURIComponent(id)}/export-blueprint`),
  baseImport: (payload: unknown, confirmation: string) => post<Record<string, unknown>>("/api/bases/import", { payload, confirmation }),
  blueprints: () => api<{ rows: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>("/api/blueprints"),
  blueprintExportUrl: (id: string) => `/api/blueprints/${encodeURIComponent(id)}/export`,
  blueprintImport: (payload: unknown, confirmation: string) => post<Record<string, unknown>>("/api/blueprints/import", { payload, confirmation }),
  blueprintClone: (id: string, confirmation: string) => post<Record<string, unknown>>(`/api/blueprints/${encodeURIComponent(id)}/clone`, { confirmation })
};
