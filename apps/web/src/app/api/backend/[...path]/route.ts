import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { apiUrl, credentials, demoEnabled, isRole, sameOrigin, ROLE_COOKIE } from "@/lib/demo-auth";

export const dynamic = "force-dynamic";

/** Same-origin bridge to the business API. It adds the demo credentials server-side and never relaxes API checks. */
async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  if (!demoEnabled()) return NextResponse.json({ error: "DEMO_DISABLED" }, { status: 404 });
  const role = (await cookies()).get(ROLE_COOKIE)?.value;
  if (!isRole(role)) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const { path } = await context.params;
  if (!path.every((segment) => /^[A-Za-z0-9-]{1,64}$/.test(segment))) return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  const write = request.method === "POST";
  if (write && (!sameOrigin(request.headers) || !request.headers.get("content-type")?.startsWith("application/json"))) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  const access = await credentials(role);
  if (!access) return NextResponse.json({ error: "DEMO_ACCESS_MISSING" }, { status: 503 });
  try {
    const upstream = await fetch(`${apiUrl()}/${path.join("/")}${request.nextUrl.search}`, {
      method: request.method, cache: "no-store", signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${access.token}`, "x-organization-id": access.organizationId, ...(write ? { "content-type": "application/json" } : {}) },
      ...(write ? { body: await request.text() } : {}),
    });
    return new NextResponse(await upstream.arrayBuffer(), { status: upstream.status, headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "private, no-store" } });
  } catch { return NextResponse.json({ error: "API_UNAVAILABLE" }, { status: 502 }); }
}
export { forward as GET, forward as POST };
