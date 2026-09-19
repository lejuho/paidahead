import pg, { type PoolClient } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

export const { Pool } = pg;
export type { PoolClient, Pool as DatabasePool } from "pg";
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Local demo evidence only. Real object storage is a later adapter. */
export async function readDemoDocument(key: string, expectedHash: string): Promise<Buffer> {
  const allowed = ["demo/purchase-order.txt", "demo/delivery-note.txt", "demo/invoice.txt"];
  if (!allowed.includes(key)) throw new Error("Unknown demo file");
  const data = await readFile(new URL(`../fixtures/${key.slice(5)}`, import.meta.url));
  if (createHash("sha256").update(data).digest("hex") !== expectedHash) throw new Error("Demo evidence hash mismatch");
  return data;
}

export async function transaction<T>(pool: pg.Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function migrate(pool: pg.Pool): Promise<void> {
  const directory = new URL("../migrations/", import.meta.url);
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(72419201)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const name of (await readdir(directory)).filter((n) => n.endsWith(".sql")).sort()) {
      const sql = await readFile(new URL(name, directory), "utf8");
      const checksum = tokenHash(sql);
      const applied = await client.query("SELECT checksum FROM schema_migration WHERE name=$1", [name]);
      if (applied.rowCount) {
        if (applied.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query("INSERT INTO schema_migration(name,checksum) VALUES($1,$2)", [name, checksum]);
    }
  });
}
