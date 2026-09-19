import { network } from "hardhat";
import { randomUUID } from "node:crypto";
import { Pool, transaction } from "@paidahead/database";
import { CHAIN_ROLES } from "@paidahead/domain";

if (process.env.DEMO_MODE !== "true" || process.env.NODE_ENV === "production" || !process.env.DATABASE_URL) throw new Error("Local demo DB configuration required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const connection = await network.create("localhost");
try {
  const client = await connection.viem.getPublicClient();
  if (await client.getChainId() !== 31337) throw new Error("Local chain 31337 only");
  if ((await pool.query("SELECT id FROM chain_deployment WHERE active")).rowCount) throw new Error("Active deployment already configured; reuse it. A reset local chain needs a fresh demo DB.");
  const orgs = (await pool.query("SELECT id,kind FROM organization WHERE is_demo=true AND approval_status='APPROVED' AND kind IN ('SUPPLIER','BUYER','BANK')")).rows;
  if (orgs.length !== 3 || new Set(orgs.map((o) => o.kind)).size !== 3) throw new Error("Run db:seed with one demo organization per role first");
  const [admin, registrar, supplier, payer, bank] = await connection.viem.getWalletClients();
  const token = await connection.viem.deployContract("ReceivableToken", [admin.account.address]);
  const payment = await connection.viem.deployContract("MockPaymentToken", [admin.account.address]);
  const settlement = await connection.viem.deployContract("Settlement", [token.address, payment.address, bank.account.address]);
  const wait = async (hash: `0x${string}`) => {
    if ((await client.waitForTransactionReceipt({ hash })).status !== "success") throw new Error("Local setup transaction reverted");
  };
  await wait(await token.write.configureSettlement([settlement.address]));
  for (const [role, wallet] of [[CHAIN_ROLES.REGISTRAR_ROLE, registrar], [CHAIN_ROLES.SUPPLIER_ROLE, supplier],
    [CHAIN_ROLES.PAYER_ROLE, payer], [CHAIN_ROLES.BANK_ROLE, bank]] as const) {
    await wait(await token.write.grantRole([role, wallet.account.address]));
  }
  const deploymentId = randomUUID();
  await transaction(pool, async (c) => {
    for (const [kind, wallet] of [["SUPPLIER", supplier], ["BUYER", payer], ["BANK", bank]] as const) {
      const org = orgs.find((o) => o.kind === kind)!;
      await c.query(`INSERT INTO wallet_binding(id,organization_id,chain_id,address,verification_status,approved_at)
        VALUES($1,$2,31337,$3,'APPROVED',now())`, [randomUUID(), org.id, wallet.account.address.toLowerCase()]);
    }
    const bankWallet = (await c.query("SELECT id FROM wallet_binding WHERE chain_id=31337 AND address=$1", [bank.account.address.toLowerCase()])).rows[0];
    await c.query(`INSERT INTO chain_deployment(id,chain_id,receivable_contract,registrar_address,deployment_block,environment,active,settlement_contract,payment_token,bank_wallet_id)
      VALUES($1,31337,$2,$3,$4,'local',true,$5,$6,$7)`, [deploymentId, token.address.toLowerCase(), registrar.account.address.toLowerCase(), (await client.getBlockNumber()).toString(), settlement.address.toLowerCase(), payment.address.toLowerCase(), bankWallet.id]);
  });
  console.log(JSON.stringify({ deploymentId, chainId: 31337, receivable: token.address, settlement: settlement.address,
    mockPayment: payment.address, registrar: registrar.account.address, environment: "local demo only" }, null, 2));
} finally { await connection.close(); await pool.end(); }
