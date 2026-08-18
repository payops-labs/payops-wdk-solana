import type { PublicPaymentAttempt } from "@payops/sdk";

import { PayOpsWdkError } from "./errors.js";
import { parsePayOpsUsdtRequest } from "./payment-request.js";
import {
  buildReferencedUsdtTransaction,
  type BlockhashLifetime,
} from "./transaction-builder.js";

export type ReferencedUsdtTransaction = Awaited<
  ReturnType<typeof buildReferencedUsdtTransaction>
>;

export type PayOpsSolanaConfirmationStatus =
  "processed" | "confirmed" | "finalized";

export interface PayOpsSolanaSignatureStatus {
  readonly confirmationStatus: PayOpsSolanaConfirmationStatus | null;
  readonly err: unknown | null;
}

export interface WdkSolanaSigner<TSignedTransaction> {
  getAddress(): Promise<string>;
  signTransaction(
    transaction: ReferencedUsdtTransaction,
  ): Promise<TSignedTransaction>;
}

export interface PayOpsSolanaRpc<TSignedTransaction> {
  getBlockHeight(): Promise<bigint>;
  getLatestBlockhash(): Promise<BlockhashLifetime>;
  getSignatureStatus(
    signature: string,
  ): Promise<PayOpsSolanaSignatureStatus | null>;
  sendTransaction(transaction: TSignedTransaction): Promise<string>;
}

export interface PayOpsFinalizationOptions {
  readonly maxStatusChecks?: number;
  readonly waitBetweenChecks?: (completedStatusChecks: number) => Promise<void>;
}

export interface SubmitPayOpsUsdtPaymentOptions<TSignedTransaction> {
  readonly account: WdkSolanaSigner<TSignedTransaction>;
  readonly attempt: PublicPaymentAttempt;
  readonly expectedRecipient: string;
  readonly finalization?: PayOpsFinalizationOptions;
  readonly now?: Date;
  readonly rpc: PayOpsSolanaRpc<TSignedTransaction>;
}

export interface FinalizedPayOpsUsdtSubmission {
  readonly signature: string;
  readonly status: "finalized";
}

export interface FailedPayOpsUsdtSubmission {
  readonly error: unknown;
  readonly signature: string;
  readonly status: "failed";
}

export interface ExpiredPayOpsUsdtSubmission {
  readonly signature: string;
  readonly status: "expired";
}

export interface SubmittedPayOpsUsdtSubmission {
  readonly confirmationStatus: Exclude<
    PayOpsSolanaConfirmationStatus,
    "finalized"
  > | null;
  readonly signature: string;
  readonly status: "submitted";
}

export type PayOpsUsdtSubmission =
  | ExpiredPayOpsUsdtSubmission
  | FailedPayOpsUsdtSubmission
  | FinalizedPayOpsUsdtSubmission
  | SubmittedPayOpsUsdtSubmission;

const DEFAULT_MAX_STATUS_CHECKS = 20;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

async function defaultWait(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS);
  });
}

export async function submitPayOpsUsdtPayment<TSignedTransaction>(
  options: SubmitPayOpsUsdtPaymentOptions<TSignedTransaction>,
): Promise<PayOpsUsdtSubmission> {
  const maxStatusChecks =
    options.finalization?.maxStatusChecks ?? DEFAULT_MAX_STATUS_CHECKS;
  if (!Number.isSafeInteger(maxStatusChecks) || maxStatusChecks < 1) {
    throw new PayOpsWdkError(
      "invalid_finalization_options",
      "Finalization status checks must be a positive safe integer",
    );
  }

  const intent = parsePayOpsUsdtRequest(options.attempt, {
    expectedRecipient: options.expectedRecipient,
    ...(options.now ? { now: options.now } : {}),
  });
  const payer = await options.account.getAddress();
  const lifetime = await options.rpc.getLatestBlockhash();
  const transaction = await buildReferencedUsdtTransaction(
    intent,
    payer,
    lifetime,
  );
  const signedTransaction = await options.account.signTransaction(transaction);
  const signature = await options.rpc.sendTransaction(signedTransaction);
  if (typeof signature !== "string" || signature.trim().length === 0) {
    throw new PayOpsWdkError(
      "invalid_signature",
      "RPC submission did not return a transaction signature",
    );
  }
  const waitBetweenChecks =
    options.finalization?.waitBetweenChecks ?? defaultWait;

  for (let completedStatusChecks = 1; ; completedStatusChecks += 1) {
    const status = await options.rpc.getSignatureStatus(signature);
    if (status?.err !== null && status?.err !== undefined) {
      return { error: status.err, signature, status: "failed" };
    }
    if (status?.confirmationStatus === "finalized" && status.err === null) {
      return { signature, status: "finalized" };
    }

    const blockHeight = await options.rpc.getBlockHeight();
    if (blockHeight > lifetime.lastValidBlockHeight) {
      return { signature, status: "expired" };
    }
    if (completedStatusChecks >= maxStatusChecks) {
      return {
        confirmationStatus:
          status?.confirmationStatus === "finalized"
            ? null
            : (status?.confirmationStatus ?? null),
        signature,
        status: "submitted",
      };
    }
    await waitBetweenChecks(completedStatusChecks);
  }
}
