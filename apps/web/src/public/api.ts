import type { PublicAnalytics } from "./types";

export class PublicApiError extends Error {
  readonly status: number;
  readonly retryAfter: number | null;
  constructor(message: string, status = 0, retryAfter: number | null = null) {
    super(message);
    this.name = "PublicApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const messageFor = (status: number) => {
  if (status === 404) return "Public analytics are not enabled for this deployment.";
  if (status === 429) return "The public analytics endpoint is receiving too many requests. Try again shortly.";
  if (status === 503) return "Public analytics are temporarily unavailable.";
  if (status === 400) return "The requested window or filter is not valid for public analytics.";
  if (status >= 500) return "The public analytics endpoint could not complete this request.";
  return "Public analytics could not be loaded.";
};

export async function fetchPublicAnalytics(
  query: URLSearchParams,
  signal: AbortSignal,
): Promise<PublicAnalytics> {
  let response: Response;
  try {
    response = await fetch(`/api/public/analytics?${query.toString()}`, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new PublicApiError("Could not reach the public analytics endpoint. Check the connection and retry.");
  }
  const retryAfter = Number(response.headers.get("Retry-After"));
  if (!response.ok) {
    throw new PublicApiError(messageFor(response.status), response.status, Number.isFinite(retryAfter) ? retryAfter : null);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PublicApiError("The public analytics endpoint returned an unreadable response.", response.status);
  }
  const data = payload as Partial<PublicAnalytics> | null;
  if (!data || typeof data !== "object" || !data.summary || !Array.isArray(data.series) || !data.timeframe) {
    throw new PublicApiError("The public analytics endpoint returned an unexpected response.", response.status);
  }
  return {
    ...data,
    summary: data.summary,
    series: data.series,
    modelGroups: Array.isArray(data.modelGroups) ? data.modelGroups : [],
    providerGroups: Array.isArray(data.providerGroups) ? data.providerGroups : [],
    groupSeries: Array.isArray(data.groupSeries) ? data.groupSeries : [],
    outputDistribution: Array.isArray(data.outputDistribution) ? data.outputDistribution : [],
    contextDistribution: Array.isArray(data.contextDistribution) ? data.contextDistribution : [],
  } as PublicAnalytics;
}
