export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
/** All business calls go through the same-origin bridge; credentials are attached server-side. */
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/backend${path}`, { method: body === undefined ? "GET" : "POST", cache: "no-store",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  } catch { throw new ApiError(0, "NETWORK"); }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(response.status, typeof data.error === "string" ? data.error : "INTERNAL_ERROR");
  }
  return (response.headers.get("content-type") ?? "").includes("json") ? response.json() : (response.text() as Promise<T>);
}
export const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "INTERNAL_ERROR");
