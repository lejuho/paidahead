import "server-only";
import { browserRpc } from "./chain-config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Local demo authentication bridge. The bearer tokens created by `npm run db:seed` stay on the Next.js server:
 * the browser only holds an httpOnly cookie naming the demo role. This is NOT production authentication.
 */
export const DEMO_ROLES = ["supplier", "buyer", "bank"] as const;
export type DemoRole = (typeof DEMO_ROLES)[number];
export const ROLE_COOKIE = "paidahead_demo_role";

export function demoEnabled(): boolean {
  return process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production";
}
function loopback(url: string): string {
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) throw new Error("Demo mode only talks to loopback services");
  return url.replace(/\/$/, "");
}
export const apiUrl = () => loopback(process.env.API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 3003}`);
export const rpcUrl = () => browserRpc(process.env.WEB_CHAIN_RPC_URL ?? process.env.REGISTRATION_RPC_URL ?? "http://127.0.0.1:8545", process.env.PAIDAHEAD_NETWORK);
export const isRole = (value: unknown): value is DemoRole => DEMO_ROLES.includes(value as DemoRole);

export async function credentials(role: DemoRole): Promise<{ token: string; organizationId: string } | null> {
  try {
    const file = process.env.DEMO_ACCESS_FILE ?? resolve(process.cwd(), "../../.local/demo-access.json");
    const entry = JSON.parse(await readFile(file, "utf8")).credentials?.[role];
    return entry && /^[a-f0-9]{64}$/.test(entry.token) ? { token: entry.token, organizationId: entry.organizationId } : null;
  } catch { return null; }
}

/** CSRF guard for state-changing routes: the browser-sent Origin must be the host this request was addressed to. */
export function sameOrigin(headers: Headers): boolean {
  try { return new URL(headers.get("origin") ?? "").host === headers.get("host"); } catch { return false; }
}
