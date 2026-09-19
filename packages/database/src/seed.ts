import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { transaction, tokenHash, type DatabasePool } from "./index.ts";

export const DEMO_IDS = {
  supplierOrg: "10000000-0000-4000-8000-000000000001",
  buyerOrg: "10000000-0000-4000-8000-000000000002",
  bankOrg: "10000000-0000-4000-8000-000000000003",
  supplier: "20000000-0000-4000-8000-000000000001",
  buyer: "20000000-0000-4000-8000-000000000002",
  bank: "20000000-0000-4000-8000-000000000003",
  documents: [1, 2, 3].map((n) => `40000000-0000-4000-8000-00000000000${n}`),
};

export async function seedDemo(pool: DatabasePool) {
  const credentials: Record<string, { userId: string; organizationId: string; token: string }> = {};
  await transaction(pool, async (c) => {
    for (const [i, key, name, kind, role] of [
      [1, "supplier", "대구 식자재 납품 역할", "SUPPLIER", "SUPPLIER_OPERATOR"],
      [2, "buyer", "시장 식당 역할", "BUYER", "BUYER_CONFIRMER"],
      [3, "bank", "iM뱅크 역할 · 시연용", "BANK", "BANK_REVIEWER"],
    ] as const) {
      const orgId = `10000000-0000-4000-8000-00000000000${i}`;
      const userId = `20000000-0000-4000-8000-00000000000${i}`;
      const membershipId = `30000000-0000-4000-8000-00000000000${i}`;
      await c.query("INSERT INTO organization(id,name,display_name,kind,approval_status) VALUES($1,$2,$2,$3,'APPROVED') ON CONFLICT DO NOTHING", [orgId, name, kind]);
      await c.query("INSERT INTO app_user(id,auth_provider,auth_subject,display_name,status) VALUES($1,'demo',$2,$3,'ACTIVE') ON CONFLICT DO NOTHING", [userId, key, name]);
      await c.query("INSERT INTO user_membership(id,user_id,organization_id,status) VALUES($1,$2,$3,'ACTIVE') ON CONFLICT DO NOTHING", [membershipId, userId, orgId]);
      await c.query("INSERT INTO membership_role(membership_id,role) VALUES($1,$2) ON CONFLICT DO NOTHING", [membershipId, role]);
      if (key === "bank") await c.query("INSERT INTO membership_role(membership_id,role) VALUES($1,'BANK_APPROVER') ON CONFLICT DO NOTHING", [membershipId]);
      await c.query("INSERT INTO wallet_binding(id,organization_id,chain_id,address,verification_status,approved_at) VALUES($1,$2,31337,$3,'DEMO_ONLY',NULL) ON CONFLICT DO NOTHING",
        [`50000000-0000-4000-8000-00000000000${i}`, orgId, `0x${String(i).padStart(40, "0")}`]);
      const token = randomBytes(32).toString("hex");
      await c.query("INSERT INTO demo_session(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '24 hours')", [tokenHash(token), userId]);
      credentials[key] = { userId, organizationId: orgId, token };
    }
    const files = ["purchase-order.txt", "delivery-note.txt", "invoice.txt"];
    const types = ["PURCHASE_ORDER", "DELIVERY_NOTE", "INVOICE"];
    for (const [i, filename] of files.entries()) {
      const body = await readFile(new URL(`../fixtures/${filename}`, import.meta.url));
      const hash = (await import("node:crypto")).createHash("sha256").update(body).digest("hex");
      await c.query(`INSERT INTO document(id,owner_org_id,document_type,original_filename,storage_key,mime_type,file_size,file_hash,uploaded_by)
        VALUES($1,$2,$3,$4,$5,'text/plain',$6,$7,$8) ON CONFLICT DO NOTHING`,
        [DEMO_IDS.documents[i], DEMO_IDS.supplierOrg, types[i], filename, `demo/${filename}`, body.length, hash, DEMO_IDS.supplier]);
    }
  });
  return { credentials, ids: DEMO_IDS, expiresInHours: 24 };
}
