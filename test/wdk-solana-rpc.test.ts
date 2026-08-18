import type { WalletAccountSolana } from "@tetherto/wdk-wallet-solana";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  createWdkSolanaRpc,
  type WdkSolanaSubmissionAccount,
} from "../src/index.js";
import type { PayOpsWdkError } from "../src/errors.js";

const SIGNATURE = "5".repeat(88);
const SIGNED_TRANSACTION = { marker: "signed" } as const;

function jsonResponse(result: unknown): Response {
  return new Response(JSON.stringify({ id: 1, jsonrpc: "2.0", result }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

describe("createWdkSolanaRpc", () => {
  it("maps Solana reads and delegates signed submission to WDK", async () => {
    const responses = {
      getLatestBlockhash: {
        context: { slot: 123 },
        value: {
          blockhash: "11111111111111111111111111111111",
          lastValidBlockHeight: 456,
        },
      },
      getBlockHeight: 400,
      getSignatureStatuses: {
        context: { slot: 124 },
        value: [{ confirmationStatus: "finalized", err: null }],
      },
    } as const;
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          method: keyof typeof responses;
        };
        return jsonResponse(responses[request.method]);
      },
    );
    const account = {
      sendTransaction: vi.fn(async () => ({ fee: 5_000n, hash: SIGNATURE })),
    };
    const rpc = createWdkSolanaRpc({
      account,
      commitment: "finalized",
      fetch: fetchMock,
      rpcUrl: "https://rpc.example.test",
    });

    await expect(rpc.getLatestBlockhash()).resolves.toEqual({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 456n,
    });
    await expect(rpc.getBlockHeight()).resolves.toBe(400n);
    await expect(rpc.getSignatureStatus(SIGNATURE)).resolves.toEqual({
      confirmationStatus: "finalized",
      err: null,
    });
    await expect(rpc.sendTransaction(SIGNED_TRANSACTION)).resolves.toBe(
      SIGNATURE,
    );
    expect(account.sendTransaction).toHaveBeenCalledWith(SIGNED_TRANSACTION);
    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))),
    ).toEqual([
      {
        id: 1,
        jsonrpc: "2.0",
        method: "getLatestBlockhash",
        params: [{ commitment: "finalized" }],
      },
      {
        id: 2,
        jsonrpc: "2.0",
        method: "getBlockHeight",
        params: [{ commitment: "finalized" }],
      },
      {
        id: 3,
        jsonrpc: "2.0",
        method: "getSignatureStatuses",
        params: [[SIGNATURE], { searchTransactionHistory: true }],
      },
    ]);
  });

  it("accepts the WDK Solana account submission surface without a cast", () => {
    type WdkSignedTransaction = Awaited<
      ReturnType<WalletAccountSolana["signTransaction"]>
    >;
    expectTypeOf<WalletAccountSolana>().toMatchTypeOf<
      WdkSolanaSubmissionAccount<WdkSignedTransaction>
    >();
  });

  it("rejects a non-HTTP RPC URL before network or WDK use", () => {
    const fetchMock = vi.fn();
    const account = { sendTransaction: vi.fn() };

    expect(() =>
      createWdkSolanaRpc({
        account,
        fetch: fetchMock,
        rpcUrl: "file:///tmp/solana.sock",
      }),
    ).toThrow(
      expect.objectContaining<Partial<PayOpsWdkError>>({
        code: "invalid_rpc_config",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(account.sendTransaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an HTTP failure",
      response: new Response("unavailable", { status: 500 }),
    },
    {
      name: "a JSON-RPC error",
      response: new Response(
        JSON.stringify({
          error: { code: -32_000, message: "upstream error" },
          id: 1,
          jsonrpc: "2.0",
        }),
        { status: 200 },
      ),
    },
    {
      name: "a response without result",
      response: new Response(JSON.stringify({ id: 1, jsonrpc: "2.0" }), {
        status: 200,
      }),
    },
    {
      name: "invalid JSON",
      response: new Response("{not-json", { status: 200 }),
    },
  ])("fails closed for $name", async ({ response }) => {
    const rpc = createWdkSolanaRpc({
      account: { sendTransaction: vi.fn() },
      fetch: vi.fn(async () => response),
      rpcUrl: "https://rpc.example.test",
    });

    await expect(rpc.getBlockHeight()).rejects.toEqual(
      expect.objectContaining<Partial<PayOpsWdkError>>({
        code: "invalid_rpc_response",
      }),
    );
  });

  it.each([-1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects the invalid block height %s",
    async (blockHeight) => {
      const rpc = createWdkSolanaRpc({
        account: { sendTransaction: vi.fn() },
        fetch: vi.fn(async () => jsonResponse(blockHeight)),
        rpcUrl: "https://rpc.example.test",
      });

      await expect(rpc.getBlockHeight()).rejects.toEqual(
        expect.objectContaining<Partial<PayOpsWdkError>>({
          code: "invalid_rpc_response",
        }),
      );
    },
  );

  it("rejects an invalid last valid block height", async () => {
    const rpc = createWdkSolanaRpc({
      account: { sendTransaction: vi.fn() },
      fetch: vi.fn(async () =>
        jsonResponse({
          context: { slot: 123 },
          value: {
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: -1,
          },
        }),
      ),
      rpcUrl: "https://rpc.example.test",
    });

    await expect(rpc.getLatestBlockhash()).rejects.toEqual(
      expect.objectContaining<Partial<PayOpsWdkError>>({
        code: "invalid_rpc_response",
      }),
    );
  });

  it.each([
    {
      name: "an unsupported confirmation status",
      status: { confirmationStatus: "rooted", err: null },
    },
    {
      name: "a missing error field",
      status: { confirmationStatus: "finalized" },
    },
  ])("rejects $name", async ({ status }) => {
    const rpc = createWdkSolanaRpc({
      account: { sendTransaction: vi.fn() },
      fetch: vi.fn(async () =>
        jsonResponse({ context: { slot: 124 }, value: [status] }),
      ),
      rpcUrl: "https://rpc.example.test",
    });

    await expect(rpc.getSignatureStatus(SIGNATURE)).rejects.toEqual(
      expect.objectContaining<Partial<PayOpsWdkError>>({
        code: "invalid_rpc_response",
      }),
    );
  });

  it("rejects an empty signature returned by WDK", async () => {
    const rpc = createWdkSolanaRpc({
      account: {
        sendTransaction: vi.fn(async () => ({ fee: 5_000n, hash: "  " })),
      },
      fetch: vi.fn(),
      rpcUrl: "https://rpc.example.test",
    });

    await expect(rpc.sendTransaction(SIGNED_TRANSACTION)).rejects.toEqual(
      expect.objectContaining<Partial<PayOpsWdkError>>({
        code: "invalid_signature",
      }),
    );
  });
});
