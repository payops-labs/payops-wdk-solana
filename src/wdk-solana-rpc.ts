import type {
  PayOpsSolanaRpc,
  PayOpsSolanaSignatureStatus,
} from "./adapter.js";
import { PayOpsWdkError } from "./errors.js";

type Commitment = "confirmed" | "finalized";
type JsonObject = Record<string, unknown>;

export interface WdkSolanaSubmissionAccount<TSignedTransaction> {
  sendTransaction(transaction: TSignedTransaction): Promise<{
    hash: string;
    fee: bigint;
  }>;
}

export interface CreateWdkSolanaRpcOptions<TSignedTransaction> {
  readonly account: WdkSolanaSubmissionAccount<TSignedTransaction>;
  readonly commitment?: Commitment;
  readonly fetch?: typeof globalThis.fetch;
  readonly rpcUrl: string;
}

function invalidResponse(message: string): never {
  throw new PayOpsWdkError("invalid_rpc_response", message);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBlockHeight(value: unknown, field: string): bigint {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalidResponse(`${field} must be a non-negative safe integer`);
  }
  return BigInt(value as number);
}

function parseRpcUrl(rpcUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new PayOpsWdkError(
      "invalid_rpc_config",
      "Solana RPC URL must be a valid HTTP or HTTPS URL",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PayOpsWdkError(
      "invalid_rpc_config",
      "Solana RPC URL must use HTTP or HTTPS",
    );
  }
  return url;
}

function parseSignatureStatus(
  value: unknown,
): PayOpsSolanaSignatureStatus | null {
  if (!isJsonObject(value) || !Array.isArray(value.value)) {
    return invalidResponse("Signature status result is malformed");
  }
  const status = value.value[0];
  if (status === null) {
    return null;
  }
  if (!isJsonObject(status) || !Object.hasOwn(status, "err")) {
    return invalidResponse("Signature status must include an error field");
  }
  const confirmationStatus = status.confirmationStatus;
  if (
    confirmationStatus !== null &&
    confirmationStatus !== "processed" &&
    confirmationStatus !== "confirmed" &&
    confirmationStatus !== "finalized"
  ) {
    return invalidResponse("Signature confirmation status is unsupported");
  }
  return {
    confirmationStatus,
    err: status.err ?? null,
  };
}

export function createWdkSolanaRpc<TSignedTransaction>(
  options: CreateWdkSolanaRpcOptions<TSignedTransaction>,
): PayOpsSolanaRpc<TSignedTransaction> {
  const rpcUrl = parseRpcUrl(options.rpcUrl);
  const commitment = options.commitment ?? "finalized";
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  let requestId = 0;

  async function call(
    method: string,
    params: readonly unknown[],
  ): Promise<unknown> {
    const response = await fetchImplementation(rpcUrl, {
      body: JSON.stringify({
        id: ++requestId,
        jsonrpc: "2.0",
        method,
        params,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      return invalidResponse(`Solana RPC returned HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return invalidResponse("Solana RPC did not return valid JSON");
    }
    if (!isJsonObject(body)) {
      return invalidResponse("Solana RPC response must be an object");
    }
    if (Object.hasOwn(body, "error")) {
      return invalidResponse("Solana RPC returned a JSON-RPC error");
    }
    if (!Object.hasOwn(body, "result")) {
      return invalidResponse("Solana RPC response did not include a result");
    }
    return body.result;
  }

  return {
    async getBlockHeight() {
      return parseBlockHeight(
        await call("getBlockHeight", [{ commitment }]),
        "Block height",
      );
    },
    async getLatestBlockhash() {
      const result = await call("getLatestBlockhash", [{ commitment }]);
      if (!isJsonObject(result) || !isJsonObject(result.value)) {
        return invalidResponse("Latest blockhash result is malformed");
      }
      const { blockhash, lastValidBlockHeight } = result.value;
      if (typeof blockhash !== "string" || blockhash.trim().length === 0) {
        return invalidResponse("Latest blockhash is missing");
      }
      return {
        blockhash,
        lastValidBlockHeight: parseBlockHeight(
          lastValidBlockHeight,
          "Last valid block height",
        ),
      };
    },
    async getSignatureStatus(signature) {
      return parseSignatureStatus(
        await call("getSignatureStatuses", [
          [signature],
          { searchTransactionHistory: true },
        ]),
      );
    },
    async sendTransaction(transaction) {
      const result = await options.account.sendTransaction(transaction);
      if (typeof result.hash !== "string" || result.hash.trim().length === 0) {
        throw new PayOpsWdkError(
          "invalid_signature",
          "WDK submission did not return a transaction signature",
        );
      }
      return result.hash;
    },
  };
}
