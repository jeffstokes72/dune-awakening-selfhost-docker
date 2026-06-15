import { api } from "./client";

export const logsApi = {
  services: () => api<{ services: string[] }>("/api/logs/services"),
  get: (service: string) => api<{ stdout: string }>(`/api/logs/${encodeURIComponent(service)}`),
  streamUrl: (service: string) => `/api/logs/${encodeURIComponent(service)}/stream`,
  downloadUrl: (service: string) => `/api/logs/${encodeURIComponent(service)}/download`
};
