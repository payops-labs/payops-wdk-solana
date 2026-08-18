import { MAINNET_USDT } from "@payops/core";
import type { PublicPaymentAttempt } from "@payops/sdk";
import WalletManagerSolana from "@tetherto/wdk-wallet-solana";
import { describe, expect, it, vi } from "vitest";

import {
  submitPayOpsUsdtPayment,
  type PayOpsSolanaRpc,
  type PayOpsSolanaSignatureStatus,
  type SubmitPayOpsUsdtPaymentOptions,
  type WdkSolanaSigner,
} from "../src/index.js";
import { PayOpsWdkError } from "../src/errors.js";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const RECIPIENT = "7Ecwo1uPym3WrdhV7vxkgeBpgpDHFYkGAPs8tD5dBEKf";
const PAYER = "6Vce6L6aDSeVN3HJzi14ucfzBmPZykHhgwut2cq9vX6V";
const REFERENCE = "Vote111111111111111111111111111111111111111";
const SIGNATURE = "5".repeat(88);
const NOW = new Date("2026-08-18T10:00:00.000Z");
const LIFETIME = {
  blockhash: "11111111111111111111111111111111",
  lastValidBlockHeight: 100n,
} as const;

function attempt(): PublicPaymentAttempt {
  const params = new URLSearchParams({
    amount: "12.500001",
    "spl-token": String(MAINNET_USDT.mint),
    reference: REFERENCE,
  });

  return {
    publicAttemptId: "0191a72c-19e4-7a86-93a9-a7e0dff9db97",
    assetSymbol: "USDT",
    mint: String(MAINNET_USDT.mint),
    amountTokens: "12.500001",
    amountBaseUnits: "12500001",
    paymentUrl: `solana:${RECIPIENT}?${params.toString()}`,
    reference: REFERENCE,
    quoteExpiresAt: "2026-08-18T10:05:00.000Z",
    status: "awaiting_payment",
    statusUpdatedAt: "2026-08-18T09:59:00.000Z",
  };
}

interface MockSignedTransaction {
  readonly marker: "signed";
}

function mockOptions(
  status: PayOpsSolanaSignatureStatus | null,
  blockHeight: bigint,
): {
  readonly account: WdkSolanaSigner<MockSignedTransaction>;
  readonly options: SubmitPayOpsUsdtPaymentOptions<MockSignedTransaction>;
  readonly rpc: PayOpsSolanaRpc<MockSignedTransaction>;
} {
  const account = {
    getAddress: vi.fn(async () => PAYER),
    signTransaction: vi.fn(async () => ({ marker: "signed" as const })),
  };
  const rpc = {
    getBlockHeight: vi.fn(async () => blockHeight),
    getLatestBlockhash: vi.fn(async () => LIFETIME),
    getSignatureStatus: vi.fn(async () => status),
    sendTransaction: vi.fn(async () => SIGNATURE),
  };

  return {
    account,
    options: {
      account,
      attempt: attempt(),
      expectedRecipient: RECIPIENT,
      finalization: {
        maxStatusChecks: 1,
        waitBetweenChecks: vi.fn(async () => undefined),
      },
      now: NOW,
      rpc,
    },
    rpc,
  };
}

describe("submitPayOpsUsdtPayment", () => {
  it("uses caller-owned WDK signing and injected RPC until finalized", async () => {
    const manager = new WalletManagerSolana(MNEMONIC, {
      commitment: "finalized",
      provider: "http://127.0.0.1:1",
    });

    try {
      const account = await manager.getAccount(0);
      const statuses: Array<PayOpsSolanaSignatureStatus | null> = [
        null,
        { confirmationStatus: "confirmed", err: null },
        { confirmationStatus: "finalized", err: null },
      ];
      const getLatestBlockhash = vi.fn(async () => LIFETIME);
      const sendTransaction = vi.fn(async (signedTransaction: unknown) => {
        expect(signedTransaction).toEqual(
          expect.objectContaining({
            messageBytes: expect.any(Uint8Array),
            signatures: expect.any(Object),
          }),
        );
        return SIGNATURE;
      });
      const getSignatureStatus = vi.fn(async () => statuses.shift() ?? null);
      const getBlockHeight = vi.fn(async () => 90n);
      const wait = vi.fn(async () => undefined);

      const result = await submitPayOpsUsdtPayment({
        account,
        attempt: attempt(),
        expectedRecipient: RECIPIENT,
        finalization: { maxStatusChecks: 3, waitBetweenChecks: wait },
        now: NOW,
        rpc: {
          getBlockHeight,
          getLatestBlockhash,
          getSignatureStatus,
          sendTransaction,
        },
      });

      expect(result).toEqual({ signature: SIGNATURE, status: "finalized" });
      expect(getLatestBlockhash).toHaveBeenCalledOnce();
      expect(sendTransaction).toHaveBeenCalledOnce();
      expect(getSignatureStatus).toHaveBeenCalledTimes(3);
      expect(getBlockHeight).toHaveBeenCalledTimes(2);
      expect(wait).toHaveBeenCalledTimes(2);
    } finally {
      manager.dispose();
    }
  });

  it("returns an on-chain failure without losing the signature", async () => {
    const chainError = { InstructionError: [1, "Custom"] };
    const { options } = mockOptions(
      { confirmationStatus: "confirmed", err: chainError },
      90n,
    );

    await expect(submitPayOpsUsdtPayment(options)).resolves.toEqual({
      error: chainError,
      signature: SIGNATURE,
      status: "failed",
    });
  });

  it("returns expired when the blockhash lifetime passes", async () => {
    const { options } = mockOptions(null, 101n);

    await expect(submitPayOpsUsdtPayment(options)).resolves.toEqual({
      signature: SIGNATURE,
      status: "expired",
    });
  });

  it("returns submitted when bounded polling has not finalized", async () => {
    const { options } = mockOptions(
      { confirmationStatus: "confirmed", err: null },
      90n,
    );

    await expect(submitPayOpsUsdtPayment(options)).resolves.toEqual({
      confirmationStatus: "confirmed",
      signature: SIGNATURE,
      status: "submitted",
    });
  });

  it("rejects invalid polling configuration before wallet or RPC use", async () => {
    const { account, options, rpc } = mockOptions(
      { confirmationStatus: "finalized", err: null },
      90n,
    );

    await expect(
      submitPayOpsUsdtPayment({
        ...options,
        finalization: { ...options.finalization, maxStatusChecks: 0 },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PayOpsWdkError>>({
        code: "invalid_finalization_options",
      }),
    );
    expect(account.getAddress).not.toHaveBeenCalled();
    expect(rpc.getLatestBlockhash).not.toHaveBeenCalled();
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
  });

  it("rejects an empty signature returned by the injected RPC", async () => {
    const { options, rpc } = mockOptions(
      { confirmationStatus: "finalized", err: null },
      90n,
    );
    vi.mocked(rpc.sendTransaction).mockResolvedValueOnce("   ");

    await expect(submitPayOpsUsdtPayment(options)).rejects.toEqual(
      expect.objectContaining<Partial<PayOpsWdkError>>({
        code: "invalid_signature",
      }),
    );
    expect(rpc.getSignatureStatus).not.toHaveBeenCalled();
  });
});
