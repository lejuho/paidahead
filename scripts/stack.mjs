// One-command local demo stack: PostgreSQL → migrate/seed → Hardhat chain → contracts → API → worker → web.
// Usage: npm run stack -- <up|down|status|logs> [--fresh] [--fund[=KRW]] [--docker] [--no-web]
//   up --fresh   wipe the local DB and restart the chain together (they must always be reset as a pair)
//   up --fund    mint mock tokens to the bank and buyer wallets after start (default 10,000,000 each)
//   up --docker  use `docker compose` PostgreSQL instead of the private cluster in .local/pg
// Local demo only: every endpoint is loopback, and the chain uses public Hardhat keys.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const local = `${root}.local/`, logs = `${local}logs/`, run = `${local}run/`;
const [command = "status", ...flags] = process.argv.slice(2);
const has = (name) => flags.some((f) => f === name || f.startsWith(`${name}=`));
const valueOf = (name, fallback) => flags.find((f) => f.startsWith(`${name}=`))?.split("=")[1] ?? fallback;
if (process.env.NODE_ENV === "production") throw new Error("Local demo only");

const SERVICES = [ // start order; stopped in reverse
  { name: "chain", script: "chain:local", port: 8545, pattern: "hardhat node" },
  { name: "api", script: "dev:api", port: 3003, pattern: "src/server.ts" },
  { name: "worker", script: "worker:start", port: null, pattern: "src/cli.ts --watch" },
  { name: "web", script: "dev:web", port: 3000, pattern: "next dev" },
];
const say = (text) => console.log(`▸ ${text}`);
const npm = (script, args = []) => execFileSync("npm", ["run", "--silent", script, ...(args.length ? ["--", ...args] : [])], { cwd: root, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
const listening = (port) => new Promise((resolve) => {
  const socket = createConnection({ host: "127.0.0.1", port }).once("connect", () => { socket.destroy(); resolve(true); }).once("error", () => resolve(false));
});
async function waitFor(label, check, seconds = 60) {
  for (let i = 0; i < seconds * 4; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`${label} did not become ready. See .local/logs/`);
}
const pidFile = (name) => `${run}${name}.pid`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = (name) => { try { const pid = Number(readFileSync(pidFile(name), "utf8")); return alive(pid) ? pid : null; } catch { return null; } };

async function start(service) {
  if (pidOf(service.name) || (service.port && await listening(service.port))) return say(`${service.name}: 이미 실행 중`);
  const log = openSync(`${logs}${service.name}.log`, "a");
  const child = spawn("npm", ["run", service.script], { cwd: root, detached: true, stdio: ["ignore", log, log] });
  child.unref(); closeSync(log); writeFileSync(pidFile(service.name), String(child.pid));
  if (service.port) await waitFor(service.name, () => listening(service.port));
  say(`${service.name}: 시작${service.port ? ` (127.0.0.1:${service.port})` : ""} · 로그 .local/logs/${service.name}.log`);
}
function stop(service) {
  const pid = pidOf(service.name);
  if (pid) { try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ } }
  // Also covers processes started by hand in another terminal.
  try { execFileSync("pkill", ["-f", service.pattern], { stdio: "ignore" }); } catch { /* nothing matched */ }
  rmSync(pidFile(service.name), { force: true });
}
const database = (action) => {
  if (has("--docker")) return execFileSync("docker", action === "start" ? ["compose", "up", "-d", "--wait", "postgres"] : ["compose", "stop", "postgres"], { cwd: root, stdio: "inherit" });
  execFileSync(process.execPath, ["scripts/local-pg.mjs", action], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
};
async function apiGet(path, role = "bank") {
  const user = JSON.parse(readFileSync(`${local}demo-access.json`, "utf8")).credentials[role];
  return fetch(`http://127.0.0.1:${process.env.API_PORT ?? 3003}${path}`, { headers: { authorization: `Bearer ${user.token}`, "x-organization-id": user.organizationId } });
}
async function rpc(method, params) {
  const res = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await res.json()).result;
}

async function up() {
  mkdirSync(logs, { recursive: true }); mkdirSync(run, { recursive: true });
  if (!existsSync(`${root}.env`)) { copyFileSync(`${root}.env.example`, `${root}.env`); say(".env 생성 (.env.example 복사)"); }
  if (!existsSync(`${root}node_modules`)) throw new Error("먼저 `npm ci`를 실행하세요.");
  if (!existsSync(`${root}packages/domain/dist`) || !existsSync(`${root}contracts/artifacts`)) { say("최초 빌드 중… (1~2분)"); npm("build"); }
  if (has("--fresh")) {
    say("--fresh: 스택을 멈추고 DB와 체인을 함께 초기화합니다");
    await down(true);
    if (has("--docker")) execFileSync("docker", ["compose", "down", "-v"], { cwd: root, stdio: "inherit" }); else rmSync(`${local}pg`, { recursive: true, force: true });
  }
  database("start"); say("PostgreSQL 준비");
  npm("db:migrate"); npm("db:seed"); say("마이그레이션·시연 계정 준비 (토큰 24시간 유효)");
  await start(SERVICES[0]); await start(SERVICES[1]);
  await waitFor("api health", async () => (await fetch(`http://127.0.0.1:${process.env.API_PORT ?? 3003}/health`).catch(() => null))?.ok === true);
  const deployment = await apiGet("/chain");
  if (deployment.status === 409) { npm("chain:setup"); say("계약 배포·조직 지갑 연결 완료"); }
  else {
    const { settlementContract } = await deployment.json();
    if ((await rpc("eth_getCode", [settlementContract, "latest"])) === "0x") {
      throw new Error("DB에는 배포 기록이 있는데 체인에는 계약이 없습니다(체인만 재시작됨). `npm run stack -- up --fresh`로 DB와 체인을 함께 초기화하세요.");
    }
    say("기존 계약 배포 재사용");
  }
  await start(SERVICES[2]);
  if (!has("--no-web")) await start(SERVICES[3]);
  if (has("--fund")) { npm("demo:fund", ["--krw", valueOf("--fund", "10000000")]); say(`은행·구매처 지갑에 모의 토큰 ${valueOf("--fund", "10000000")} mKRW씩 발행`); }
  console.log(`
준비 완료 → http://localhost:3000
  지갑 네트워크: RPC http://127.0.0.1:8545 · 체인 ID 31337
  승인 지갑: 납품업체 Account #2 · 구매처 #3 · 은행 #4  (개인키: head -60 .local/logs/chain.log)
  중지: npm run stack -- down   상태: npm run stack -- status   로그: npm run stack -- logs [chain|api|worker|web]`);
}
async function down(keepDatabase = false) {
  for (const service of [...SERVICES].reverse()) stop(service);
  for (const service of SERVICES) if (service.port) await waitFor(`${service.name} stop`, async () => !(await listening(service.port)), 15);
  if (!keepDatabase) { try { database("stop"); } catch { /* not running */ } }
  if (!keepDatabase) say("스택 중지 (DB 데이터는 .local/pg 에 보존 · 체인 데이터는 사라졌으므로 다음에는 `up --fresh`)");
}
const matches = (pattern) => { try { execFileSync("pgrep", ["-f", pattern], { stdio: "ignore" }); return true; } catch { return false; } };
async function status() {
  for (const service of SERVICES) console.log(`${service.name.padEnd(7)} ${(service.port ? await listening(service.port) : !!pidOf(service.name) || matches(service.pattern)) ? "실행 중" : "중지"}${service.port ? `  127.0.0.1:${service.port}` : ""}`);
  console.log(`${"db".padEnd(7)} ${(await listening(Number(process.env.LOCAL_PG_PORT ?? 54329))) ? "실행 중" : "중지"}  127.0.0.1:54329`);
}

try {
  if (command === "up") await up();
  else if (command === "down") await down();
  else if (command === "status") await status();
  else if (command === "logs") execFileSync("tail", ["-n", "40", "-f", `${logs}${flags.find((f) => !f.startsWith("--")) ?? "api"}.log`], { stdio: "inherit" });
  else throw new Error("Usage: npm run stack -- <up|down|status|logs> [--fresh] [--fund[=KRW]] [--docker] [--no-web]");
} catch (error) { console.error(`✖ ${error.message}`); process.exit(1); }
