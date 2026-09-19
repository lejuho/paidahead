import type { NextConfig } from "next";

// Share the monorepo's root .env (DEMO_MODE, API_PORT, REGISTRATION_RPC_URL). Server-side only: nothing here is NEXT_PUBLIC.
try { process.loadEnvFile(new URL("../../.env", import.meta.url).pathname); } catch { /* optional */ }

const config: NextConfig = {
  // The monorepo pins the native TypeScript 7 compiler, which has no JS API for Next's built-in checker.
  // Types are checked by `npm run typecheck -w @paidahead/web` (part of the root `npm run check`).
  typescript: { ignoreBuildErrors: true },
  poweredByHeader: false,
  agentRules: false,
  devIndicators: false,
};
export default config;
