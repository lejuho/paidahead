import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { credentials, demoEnabled, isRole, rpcUrl, sameOrigin, ROLE_COOKIE } from "@/lib/demo-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!demoEnabled()) return NextResponse.json({ enabled: false, role: null });
  const role = (await cookies()).get(ROLE_COOKIE)?.value;
  return NextResponse.json({ enabled: true, role: isRole(role) ? role : null, rpcUrl: rpcUrl() });
}
export async function POST(request: NextRequest) {
  if (!demoEnabled()) return NextResponse.json({ error: "DEMO_DISABLED" }, { status: 404 });
  if (!sameOrigin(request.headers)) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const role = (await request.json().catch(() => ({}))).role;
  if (!isRole(role)) return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
  if (!(await credentials(role))) return NextResponse.json({ error: "DEMO_ACCESS_MISSING" }, { status: 503 });
  const response = NextResponse.json({ enabled: true, role });
  response.cookies.set(ROLE_COOKIE, role, { httpOnly: true, sameSite: "strict", path: "/", maxAge: 86400 });
  return response;
}
export async function DELETE(request: NextRequest) {
  if (!sameOrigin(request.headers)) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const response = NextResponse.json({ enabled: demoEnabled(), role: null });
  response.cookies.delete(ROLE_COOKIE);
  return response;
}
