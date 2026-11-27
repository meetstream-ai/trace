"use client";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function requestJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
      signal: init?.signal ?? AbortSignal.timeout(120000),
    });
  } catch {
    throw new Error(
      "Could not reach Trace. Check that the local server is running, then try again.",
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      `Trace returned an unexpected response (${response.status}). Reload and try again.`,
    );
  }
  if (!response.ok) {
    if (response.status === 401 && !url.startsWith("/api/auth/"))
      location.replace(
        `/login?next=${encodeURIComponent(location.pathname + location.search)}`,
      );
    throw new ApiError(
      (data as { error?: string }).error || "The request failed. Try again.",
      response.status,
    );
  }
  return data as T;
}
