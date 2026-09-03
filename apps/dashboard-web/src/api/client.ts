import type { DashboardLanes, JobLogsResponse, IntegrationErrorsResponse } from "../types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
const TOKEN_KEY = "dashboard_token";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (!res.ok) {
    if (res.status === 401) clearStoredToken();
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.error ?? `Request failed with status ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export function login(username: string, password: string): Promise<{ token: string }> {
  return request("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
}

export function fetchDashboard(): Promise<DashboardLanes> {
  return request("/api/dashboard");
}

export function fetchJobLogs(jobId: number, after: number): Promise<JobLogsResponse> {
  return request(`/api/jobs/${jobId}/logs?after=${after}`);
}

export function deleteJobLogs(jobId: number): Promise<{ deleted: number }> {
  return request(`/api/jobs/${jobId}/logs`, { method: "DELETE" });
}

export function fetchIntegrationErrors(): Promise<IntegrationErrorsResponse> {
  return request("/api/errors");
}

export function deleteIntegrationErrors(): Promise<{ deleted: number }> {
  return request("/api/errors", { method: "DELETE" });
}
