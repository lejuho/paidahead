import { transaction, type DatabasePool } from "@paidahead/database";
import { ApiError, requireRole, type Actor } from "./service.ts";

/** Read-only views for the web client. Every query is scoped to the caller's organization and role. */
export function queries(pool: DatabasePool) {
  return {
    me: (a: Actor) => transaction(pool, async (c) => {
      const organization = (await c.query("SELECT id,display_name,kind FROM organization WHERE id=$1", [a.organizationId])).rows[0];
      const user = (await c.query("SELECT display_name FROM app_user WHERE id=$1", [a.userId])).rows[0];
      const roles = (await c.query(`SELECT r.role FROM membership_role r JOIN user_membership m ON m.id=r.membership_id
        WHERE m.user_id=$1 AND m.organization_id=$2 AND m.status='ACTIVE' ORDER BY r.role`, [a.userId, a.organizationId])).rows.map((r) => r.role);
      // Only approved bindings are usable for settlement; DEMO_ONLY placeholders are never returned.
      const wallets = (await c.query(`SELECT chain_id,address FROM wallet_binding WHERE organization_id=$1
        AND verification_status='APPROVED' AND approved_at IS NOT NULL ORDER BY created_at`, [a.organizationId])).rows;
      return { ...a, displayName: user.display_name, organization, roles, wallets, authMode: "DEMO" };
    }),
    chain: async () => {
      const d = (await pool.query(`SELECT chain_id,receivable_contract,settlement_contract,payment_token,confirmations,environment
        FROM chain_deployment WHERE active LIMIT 1`)).rows[0];
      if (!d) throw new ApiError(409, "SETTLEMENT_NOT_CONFIGURED");
      return { chainId: Number(d.chain_id), receivableContract: d.receivable_contract, settlementContract: d.settlement_contract,
        paymentToken: d.payment_token, confirmations: d.confirmations, environment: d.environment };
    },
    applications: (a: Actor) => transaction(pool, async (c) => {
      await requireRole(c, a, "SUPPLIER_OPERATOR");
      return (await c.query(`SELECT a.id,a.created_at,a.updated_at,v.version,v.title,v.trade_reference,v.confirmed_amount,v.confirmed_due_at,
          v.status AS revision_status,v.frozen_at,b.display_name AS buyer_name,
          cf.id AS confirmation_id,cf.status AS confirmation_status,
          op.status AS registration_status,rv.id AS receivable_id,rv.chain_status
        FROM application a JOIN application_revision v ON v.id=a.current_revision_id
        JOIN organization b ON b.id=v.buyer_org_id
        LEFT JOIN LATERAL (SELECT id,status FROM buyer_confirmation WHERE revision_id=v.id ORDER BY requested_at DESC,id LIMIT 1) cf ON true
        LEFT JOIN LATERAL (SELECT status,receivable_id FROM chain_operation WHERE application_id=a.id AND revision_id=v.id
          ORDER BY created_at DESC,id DESC LIMIT 1) op ON true
        LEFT JOIN receivable rv ON rv.id=op.receivable_id
        WHERE a.supplier_org_id=$1 ORDER BY a.created_at DESC,a.id LIMIT 100`, [a.organizationId])).rows;
    }),
    operations: (a: Actor, receivableId: string) => transaction(pool, async (c) => {
      const r = (await c.query("SELECT supplier_org_id,buyer_org_id,bank_org_id FROM receivable WHERE id=$1", [receivableId])).rows[0];
      if (!r || ![r.supplier_org_id, r.buyer_org_id, r.bank_org_id].includes(a.organizationId)) throw new ApiError(404, "NOT_FOUND");
      await requireRole(c, a, r.supplier_org_id === a.organizationId ? "SUPPLIER_OPERATOR" : r.buyer_org_id === a.organizationId ? "BUYER_CONFIRMER" : "BANK_REVIEWER");
      // Own organization's operations only: another party's prepared calldata is not exposed.
      return (await c.query(`SELECT id,kind,status,tx_hash AS "transactionHash",failure_code AS "failureCode",created_at AS "createdAt"
        FROM wallet_operation WHERE receivable_id=$1 AND organization_id=$2 ORDER BY created_at DESC,id LIMIT 20`, [receivableId, a.organizationId])).rows;
    }),
  };
}
