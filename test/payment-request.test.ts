import { MAINNET_USDT } from "@payops/core";
import type { PublicPaymentAttempt } from "@payops/sdk";
import { describe, expect, it } from "vitest";

import { PayOpsWdkError } from "../src/errors.js";
import { parsePayOpsUsdtRequest } from "../src/payment-request.js";

const RECIPIENT = "7Ecwo1uPym3WrdhV7vxkgeBpgpDHFYkGAPs8tD5dBEKf";
const OTHER_RECIPIENT = "6Vce6L6aDSeVN3HJzi14ucfzBmPZykHhgwut2cq9vX6V";
const REFERENCE = "Vote111111111111111111111111111111111111111";
const NOW = new Date("2026-08-18T10:00:00.000Z");

function paymentUrl(overrides: Record<string, string> = {}): string {
  const recipient = overrides.recipient ?? RECIPIENT;
  const params = new URLSearchParams({
    amount: overrides.amount ?? "12.500001",
    "spl-token": overrides.mint ?? String(MAINNET_USDT.mint),
    reference: overrides.reference ?? REFERENCE,
  });
  return `solana:${recipient}?${params.toString()}`;
}

function attempt(
  overrides: Partial<PublicPaymentAttempt> = {},
): PublicPaymentAttempt {
  return {
    publicAttemptId: "0191a72c-19e4-7a86-93a9-a7e0dff9db97",
    assetSymbol: "USDT",
    mint: String(MAINNET_USDT.mint),
    amountTokens: "12.500001",
    amountBaseUnits: "12500001",
    paymentUrl: paymentUrl(),
    reference: REFERENCE,
    quoteExpiresAt: "2026-08-18T10:05:00.000Z",
    status: "awaiting_payment",
    statusUpdatedAt: "2026-08-18T09:59:00.000Z",
    ...overrides,
  };
}

function parse(value: PublicPaymentAttempt) {
  return parsePayOpsUsdtRequest(value, {
    expectedRecipient: RECIPIENT,
    now: NOW,
  });
}

function expectCode(run: () => unknown, code: PayOpsWdkError["code"]): void {
  expect(run).toThrowError(
    expect.objectContaining({ name: "PayOpsWdkError", code }),
  );
}

describe("parsePayOpsUsdtRequest", () => {
  it("normalizes an exact unexpired PayOps USDT request", () => {
    expect(parse(attempt())).toEqual({
      amountBaseUnits: 12_500_001n,
      decimals: 6,
      mint: String(MAINNET_USDT.mint),
      recipient: RECIPIENT,
      reference: REFERENCE,
    });
  });

  it("rejects an unsupported asset or mint", () => {
    expectCode(
      () => parse(attempt({ assetSymbol: "USDC" })),
      "unsupported_asset",
    );
    expectCode(
      () => parse(attempt({ mint: OTHER_RECIPIENT })),
      "unsupported_asset",
    );
  });

  it("rejects changed payment URL constraints", () => {
    const changed = [
      paymentUrl({ amount: "12.500002" }),
      paymentUrl({ mint: OTHER_RECIPIENT }),
      paymentUrl({ reference: OTHER_RECIPIENT }),
      paymentUrl({ recipient: OTHER_RECIPIENT }),
      `${paymentUrl()}&reference=${OTHER_RECIPIENT}`,
    ];

    for (const url of changed) {
      expectCode(
        () => parse(attempt({ paymentUrl: url })),
        "tampered_payment_url",
      );
    }
  });

  it("rejects inconsistent or non-base-unit amounts", () => {
    expectCode(
      () => parse(attempt({ amountBaseUnits: "12500002" })),
      "invalid_attempt",
    );
    expectCode(
      () =>
        parse(
          attempt({
            amountTokens: "0.0000001",
            amountBaseUnits: "1",
            paymentUrl: paymentUrl({ amount: "0.0000001" }),
          }),
        ),
      "invalid_attempt",
    );
  });

  it("rejects an inactive or expired attempt", () => {
    expectCode(() => parse(attempt({ status: "detected" })), "invalid_attempt");
    expectCode(
      () => parse(attempt({ quoteExpiresAt: "2026-08-18T10:00:00.000Z" })),
      "expired_attempt",
    );
  });
});
