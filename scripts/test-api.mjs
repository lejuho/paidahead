import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test creates/drops only its own randomly named schema, including with an external URL.
function run(url) {
  const result = spawnSync(process.execPath, ["--test", "apps/api/test/confirmation.test.ts", "apps/api/test/document-ai.test.ts"], {
    cwd: new URL("../", import.meta.url), stdio: "inherit",
    env: { ...process.env, TEST_DATABASE_URL: url },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (result.status === 0 && process.argv.includes("--with-contracts")) {
    const contracts = spawnSync("npm", ["run", "test", "-w", "@paidahead/contracts"], {
      cwd: new URL("../", import.meta.url), stdio: "inherit", env: { ...process.env, TEST_DATABASE_URL: url },
    });
    if (contracts.error) throw contracts.error;
    process.exitCode = contracts.status ?? 1;
  }
}
if (process.env.TEST_DATABASE_URL) {
  run(process.env.TEST_DATABASE_URL);
} else {
  let bindir;
  try { bindir = process.env.PG_BINDIR ?? execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim(); }
  catch { throw new Error("Install PostgreSQL server tools or provide TEST_DATABASE_URL. Integration tests cannot run without PostgreSQL."); }
  const base = mkdtempSync(join(tmpdir(), "paidahead-pg-"));
  const data = join(base, "data"), socket = join(base, "socket");
  mkdirSync(socket);
  let started = false;
  try {
    execFileSync(join(bindir, "initdb"), ["-D", data, "-U", "paidahead_test", "--auth=trust", "--no-locale", "--encoding=UTF8"], { stdio: "pipe" });
    execFileSync(join(bindir, "pg_ctl"), ["-D", data, "-l", join(base, "postgres.log"), "-o", `-F -k ${socket} -h ''`, "-w", "start"], { stdio: "pipe" });
    started = true;
    run(`postgresql://paidahead_test@localhost/postgres?host=${encodeURIComponent(socket)}`);
  } finally {
    if (started) execFileSync(join(bindir, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { stdio: "pipe" });
    rmSync(base, { recursive: true, force: true });
  }
}
