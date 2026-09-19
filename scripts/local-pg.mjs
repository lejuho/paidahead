// Docker-free alternative to `docker compose up postgres`: a private PostgreSQL cluster under .local/pg on 127.0.0.1:54329.
// Matches DATABASE_URL in .env.example. Local demo only (trust auth on loopback). Usage: node scripts/local-pg.mjs start|stop|status
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../.local/pg/", import.meta.url));
const data = join(root, "data"), port = process.env.LOCAL_PG_PORT ?? "54329";
let bindir;
try { bindir = process.env.PG_BINDIR ?? execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim(); }
catch { throw new Error("PostgreSQL server tools (initdb, pg_ctl) are required, or use `docker compose up -d --wait postgres`."); }
const pg = (tool, args, stdio = "inherit") => execFileSync(join(bindir, tool), args, { stdio });
const running = () => { try { pg("pg_ctl", ["-D", data, "status"], "pipe"); return true; } catch { return false; } };
const command = process.argv[2] ?? "start";
if (command === "start") {
  if (!existsSync(data)) {
    mkdirSync(root, { recursive: true });
    pg("initdb", ["-D", data, "-U", "paidahead", "--auth=trust", "--no-locale", "--encoding=UTF8"], "pipe");
  }
  if (!running()) pg("pg_ctl", ["-D", data, "-l", join(root, "postgres.log"), "-o", `-F -p ${port} -h 127.0.0.1 -k ${root}`, "-w", "start"]);
  try { pg("createdb", ["-h", "127.0.0.1", "-p", port, "-U", "paidahead", "paidahead"], "pipe"); } catch { /* already exists */ }
  console.log(`PostgreSQL ready: postgresql://paidahead:paidahead_local_only@127.0.0.1:${port}/paidahead`);
} else if (command === "stop") { if (running()) pg("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]); }
else if (command === "status") console.log(running() ? "running" : "stopped");
else throw new Error("Usage: node scripts/local-pg.mjs start|stop|status");
