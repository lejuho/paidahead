import {
  parseAbi, encodeFunctionData, keccak256, parseEventLogs,
  TransactionReceiptNotFoundError, ContractFunctionRevertedError, BaseError,
  type Address, type Hex, type LocalAccount, type PublicClient, type TransactionReceipt,
} from "viem";

export const registrationAbi = parseAbi([
  "function register(uint256 tokenId, (bytes32 tradeKey, bytes32 snapshotHash, bytes32 confirmationHash, address supplier, address payer, uint256 faceAmount, uint64 dueAt, uint8 status) data)",
  "event ReceivableRegistered(uint256 indexed tokenId, bytes32 indexed tradeKey, address indexed supplier, address payer, uint256 faceAmount, uint64 dueAt, bytes32 snapshotHash, bytes32 confirmationHash)",
]);
export interface Registration {
  tokenId: bigint;
  data: { tradeKey: Hex; snapshotHash: Hex; confirmationHash: Hex; supplier: Address;
    payer: Address; faceAmount: bigint; dueAt: bigint; status: number };
}
export interface Deployment {
  id: string; chain_id: string; receivable_contract: Address; registrar_address: Address;
  confirmations: number; deployment_block: string;
}
export interface Signed { hash: Hex; raw: Hex; nonce: number }
export interface RegistrationChain {
  chainId(): Promise<number>;
  registrar: Address;
  prepare(deployment: Deployment, registration: Registration): Promise<Signed>;
  broadcast(raw: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<TransactionReceipt | null>;
  head(): Promise<bigint>;
  blockHash(number: bigint): Promise<Hex>;
  blockTime(number: bigint): Promise<bigint>;
}
export class RegistrationError extends Error {
  constructor(code: string) { super(code); }
}

export function viemRegistrationChain(client: PublicClient, account: LocalAccount): RegistrationChain {
  return {
    registrar: account.address,
    chainId: () => client.getChainId(),
    async prepare(d, r) {
      const code = await client.getCode({ address: d.receivable_contract });
      if (!code || code === "0x") throw new RegistrationError("CONTRACT_MISSING");
      const data = encodeFunctionData({ abi: registrationAbi, functionName: "register", args: [r.tokenId, r.data] });
      let gas: bigint;
      try {
        gas = await client.estimateContractGas({ account: account.address, address: d.receivable_contract,
          abi: registrationAbi, functionName: "register", args: [r.tokenId, r.data] });
      } catch (error) {
        if (error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError) {
          throw new RegistrationError("CONTRACT_REJECTED");
        }
        throw error;
      }
      const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
      const raw = await account.signTransaction({ chainId: Number(d.chain_id), to: d.receivable_contract,
        data, value: 0n, nonce, gas: gas * 120n / 100n, gasPrice: await client.getGasPrice(), type: "legacy" });
      return { raw, hash: keccak256(raw), nonce };
    },
    broadcast: (raw) => client.sendRawTransaction({ serializedTransaction: raw }),
    async receipt(hash) {
      try { return await client.getTransactionReceipt({ hash }); }
      catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; }
    },
    head: () => client.getBlockNumber({ cacheTime: 0 }),
    blockHash: async (number) => (await client.getBlock({ blockNumber: number })).hash!,
    blockTime: async (number) => (await client.getBlock({ blockNumber: number })).timestamp,
  };
}

export function verifyRegistration(d: Deployment, r: Registration, receipt: TransactionReceipt, expectedHash: Hex) {
  if (receipt.transactionHash !== expectedHash || receipt.to?.toLowerCase() !== d.receivable_contract
      || receipt.from.toLowerCase() !== d.registrar_address || receipt.blockNumber < BigInt(d.deployment_block)) {
    throw new RegistrationError("RECEIPT_MISMATCH");
  }
  const events = parseEventLogs({ abi: registrationAbi, eventName: "ReceivableRegistered", strict: true,
    logs: receipt.logs.filter((l) => l.address.toLowerCase() === d.receivable_contract) });
  if (events.length !== 1) throw new RegistrationError("REGISTRATION_EVENT_MISSING");
  const event = events[0], a = event.args;
  if (a.tokenId !== r.tokenId || a.tradeKey !== r.data.tradeKey || a.snapshotHash !== r.data.snapshotHash
      || a.confirmationHash !== r.data.confirmationHash || a.supplier.toLowerCase() !== r.data.supplier
      || a.payer.toLowerCase() !== r.data.payer || a.faceAmount !== r.data.faceAmount || a.dueAt !== r.data.dueAt) {
    throw new RegistrationError("REGISTRATION_EVENT_MISMATCH");
  }
  return event;
}
