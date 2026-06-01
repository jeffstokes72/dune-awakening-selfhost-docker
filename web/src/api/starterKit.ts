import { api, post } from "./client";

export type StarterKitConfig = {
  enabled: boolean;
  version: string;
  items: { itemName?: string; itemId?: string; quantity: number; durability: number }[];
  xp: number;
  allowRepeatGrants: boolean;
};

export const starterKitApi = {
  capabilities: () => api<Record<string, unknown>>("/api/starter-kit/capabilities"),
  config: () => api<StarterKitConfig>("/api/starter-kit/config"),
  saveConfig: (config: StarterKitConfig, confirmation: string) => post<StarterKitConfig>("/api/starter-kit/config", { ...config, confirmation }),
  grants: () => api<{ rows: Record<string, unknown>[] }>("/api/starter-kit/grants"),
  history: () => api<{ rows: Record<string, unknown>[] }>("/api/starter-kit/history"),
  run: () => post<Record<string, unknown>>("/api/starter-kit/run"),
  grant: (playerId: string, confirmation: string) => post<Record<string, unknown>>(`/api/starter-kit/grant/${encodeURIComponent(playerId)}`, { confirmation }),
  retry: (grantId: string, confirmation: string) => post<Record<string, unknown>>(`/api/starter-kit/retry/${encodeURIComponent(grantId)}`, { confirmation }),
  enable: (confirmation: string) => post<StarterKitConfig>("/api/starter-kit/enable", { confirmation }),
  disable: (confirmation: string) => post<StarterKitConfig>("/api/starter-kit/disable", { confirmation })
};
