import { MAINNET_USDT } from "@payops/core";
import { address } from "@solana/addresses";
import { AccountRole } from "@solana/instructions";
import WalletManagerSolana from "@tetherto/wdk-wallet-solana";
import { describe, expect, it } from "vitest";

import { PayOpsWdkError } from "../src/errors.js";
import { buildReferencedUsdtTransaction } from "../src/transaction-builder.js";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const RECIPIENT = address("7Ecwo1uPym3WrdhV7vxkgeBpgpDHFYkGAPs8tD5dBEKf");
const REFERENCE = address("Vote111111111111111111111111111111111111111");
const INTENT = {
  amountBaseUnits: 12_500_001n,
  decimals: 6,
  mint: address(String(MAINNET_USDT.mint)),
  recipient: RECIPIENT,
  reference: REFERENCE,
} as const;
const LIFETIME = {
  blockhash: "11111111111111111111111111111111",
  lastValidBlockHeight: 1n,
} as const;

function isSignedTransaction(value: unknown): value is {
  readonly messageBytes: Uint8Array;
  readonly signatures: Readonly<Record<string, Uint8Array | null>>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "messageBytes" in value &&
    value.messageBytes instanceof Uint8Array &&
    "signatures" in value &&
    typeof value.signatures === "object" &&
    value.signatures !== null
  );
}

describe("buildReferencedUsdtTransaction", () => {
  it("builds the exact PayOps transfer and lets WDK sign it offline", async () => {
    const manager = new WalletManagerSolana(MNEMONIC, {
      commitment: "finalized",
      provider: "http://127.0.0.1:1",
    });

    try {
      const account = await manager.getAccount(0);
      const payer = await account.getAddress();
      const message = await buildReferencedUsdtTransaction(
        INTENT,
        payer,
        LIFETIME,
      );

      expect(message.feePayer.address).toBe(payer);
      expect(message.instructions).toHaveLength(2);

      const createRecipientAta = message.instructions[0];
      expect(createRecipientAta?.accounts?.[2]?.address).toBe(RECIPIENT);
      expect(createRecipientAta?.accounts?.[3]?.address).toBe(
        String(MAINNET_USDT.mint),
      );

      const transfer = message.instructions[1];
      const referenceAccounts =
        transfer?.accounts?.filter(
          (accountMeta) => accountMeta.address === REFERENCE,
        ) ?? [];
      expect(referenceAccounts).toEqual([
        { address: REFERENCE, role: AccountRole.READONLY },
      ]);
      expect(transfer?.accounts?.[1]?.address).toBe(String(MAINNET_USDT.mint));
      expect(transfer?.data?.[0]).toBe(12);
      expect(transfer?.data?.[9]).toBe(6);

      const transferData = transfer?.data;
      expect(transferData).toBeDefined();
      if (!transferData)
        throw new Error("Transfer instruction data is missing");
      const view = new DataView(
        transferData.buffer,
        transferData.byteOffset,
        transferData.byteLength,
      );
      expect(view.getBigUint64(1, true)).toBe(12_500_001n);

      const signed = await account.signTransaction(message);
      expect(isSignedTransaction(signed)).toBe(true);
      if (!isSignedTransaction(signed)) {
        throw new Error("WDK returned an invalid signed transaction");
      }
      expect(signed.messageBytes.byteLength).toBeGreaterThan(0);
      expect(Object.keys(signed.signatures)).toContain(payer);
    } finally {
      manager.dispose();
    }
  });

  it("rejects invalid transaction authority and lifetime inputs", async () => {
    await expect(
      buildReferencedUsdtTransaction(INTENT, "not-an-address", LIFETIME),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PayOpsWdkError>>({
        code: "invalid_payer",
      }),
    );
    await expect(
      buildReferencedUsdtTransaction(INTENT, RECIPIENT, {
        blockhash: "not-a-blockhash",
        lastValidBlockHeight: 1n,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PayOpsWdkError>>({
        code: "invalid_lifetime",
      }),
    );
  });

  it("keeps the PayOps reference as a dedicated read-only account", async () => {
    await expect(
      buildReferencedUsdtTransaction(
        { ...INTENT, reference: INTENT.mint },
        RECIPIENT,
        LIFETIME,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PayOpsWdkError>>({
        code: "invalid_attempt",
      }),
    );
  });
});
