import { MAINNET_USDT } from "@payops/core";
import type { PublicPaymentAttempt } from "@payops/sdk";
import { address, type Address } from "@solana/addresses";

import { PayOpsWdkError } from "./errors.js";

const USDT_DECIMALS = 6;
const U64_MAX = 18_446_744_073_709_551_615n;

export interface PayOpsUsdtIntent {
  readonly amountBaseUnits: bigint;
  readonly decimals: 6;
  readonly mint: Address;
  readonly recipient: Address;
  readonly reference: Address;
}

export interface ParsePayOpsUsdtRequestOptions {
  readonly expectedRecipient: string;
  readonly now?: Date;
}

function fail(code: PayOpsWdkError["code"], message: string): never {
  throw new PayOpsWdkError(code, message);
}

function parseAddress(value: string, code: PayOpsWdkError["code"]): Address {
  try {
    return address(value);
  } catch {
    return fail(code, "Payment request contains an invalid Solana address");
  }
}

function parseBaseUnits(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    return fail("invalid_attempt", "Payment amount base units are invalid");
  }

  const amount = BigInt(value);
  if (amount <= 0n || amount > U64_MAX) {
    return fail("invalid_attempt", "Payment amount is outside the SPL range");
  }
  return amount;
}

function decimalToBaseUnits(value: string): bigint {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) {
    return fail("invalid_attempt", "Payment token amount is not exact USDT");
  }

  const whole = match[1];
  const fraction = (match[2] ?? "").padEnd(USDT_DECIMALS, "0");
  return parseBaseUnits(`${whole}${fraction}`.replace(/^0+(?=\d)/, ""));
}

function oneQueryValue(url: URL, name: string): string {
  const values = url.searchParams.getAll(name);
  const [value] = values;
  if (values.length !== 1 || !value) {
    return fail(
      "tampered_payment_url",
      `Payment URL must contain one ${name} value`,
    );
  }
  return value;
}

function parsePaymentUrl(value: string): {
  amount: string;
  mint: Address;
  recipient: Address;
  reference: Address;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("tampered_payment_url", "Payment URL is invalid");
  }

  if (url.protocol !== "solana:" || url.pathname.length === 0) {
    return fail("tampered_payment_url", "Payment URL is not a Solana Pay URL");
  }

  return {
    amount: oneQueryValue(url, "amount"),
    mint: parseAddress(oneQueryValue(url, "spl-token"), "tampered_payment_url"),
    recipient: parseAddress(url.pathname, "tampered_payment_url"),
    reference: parseAddress(
      oneQueryValue(url, "reference"),
      "tampered_payment_url",
    ),
  };
}

export function parsePayOpsUsdtRequest(
  attempt: PublicPaymentAttempt,
  options: ParsePayOpsUsdtRequestOptions,
): PayOpsUsdtIntent {
  if (
    attempt.assetSymbol !== "USDT" ||
    attempt.mint !== String(MAINNET_USDT.mint)
  ) {
    return fail(
      "unsupported_asset",
      "Only canonical mainnet USDT is supported",
    );
  }
  if (attempt.status !== "awaiting_payment") {
    return fail("invalid_attempt", "Payment attempt is not awaiting payment");
  }

  const expiresAt = Date.parse(attempt.quoteExpiresAt);
  const now = options.now ?? new Date();
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now.getTime())) {
    return fail("invalid_attempt", "Payment attempt expiry is invalid");
  }
  if (expiresAt <= now.getTime()) {
    return fail("expired_attempt", "Payment attempt has expired");
  }

  const amountBaseUnits = parseBaseUnits(attempt.amountBaseUnits);
  if (decimalToBaseUnits(attempt.amountTokens) !== amountBaseUnits) {
    return fail("invalid_attempt", "Payment attempt amounts disagree");
  }

  const expectedRecipient = parseAddress(
    options.expectedRecipient,
    "invalid_attempt",
  );
  const reference = parseAddress(attempt.reference, "invalid_attempt");
  const payment = parsePaymentUrl(attempt.paymentUrl);

  if (
    payment.mint !== MAINNET_USDT.mint ||
    decimalToBaseUnits(payment.amount) !== amountBaseUnits ||
    payment.reference !== reference ||
    payment.recipient !== expectedRecipient
  ) {
    return fail(
      "tampered_payment_url",
      "Payment URL constraints do not match the trusted payment request",
    );
  }

  return {
    amountBaseUnits,
    decimals: USDT_DECIMALS,
    mint: payment.mint,
    recipient: payment.recipient,
    reference: payment.reference,
  };
}
