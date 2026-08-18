# PayOps WDK Solana

Reference integration for signing and submitting an exact PayOps Solana USDT
payment with Tether WDK.

This repository is part of [PayOps Labs](https://github.com/payops-labs). The
wallet-neutral payment verification and reconciliation system lives in
[solana-payment-ops](https://github.com/payops-labs/solana-payment-ops).

## What this proves

The adapter takes a public PayOps payment attempt, checks its security-sensitive
fields, builds the matching SPL Token transaction, adds the PayOps invoice
reference as a read-only account, and passes the prebuilt message to a
caller-owned Tether WDK account for signing. It then submits the signed
transaction through a caller-supplied RPC port and checks its status until it is
finalized, fails, expires, or reaches the configured polling bound.

The automated workflow uses an unreachable WDK provider and a mocked submission
port. It signs a real transaction without broadcasting it, so tests need no
funded wallet or paid infrastructure.

## Trust boundary

- The caller owns and configures its WDK wallet.
- The caller owns RPC transport, credentials, retry policy, and submission.
- This adapter never accepts or reads a mnemonic or private key.
- PayOps never treats signing or submission as payment proof.
- PayOps verifies the finalized transfer independently before changing invoice
  state.
- The caller supplies its trusted merchant recipient because that recipient is
  not duplicated outside the Solana Pay URL in the public payment attempt.

## Supported contract

This first compatibility surface is intentionally narrow:

- Solana mainnet
- canonical mainnet USDT
- legacy SPL Token Program
- six-decimal positive integer amounts
- one unexpired `awaiting_payment` attempt
- one dedicated PayOps reference account

Anything outside that contract fails closed.

## Usage

```ts
import type { PublicPaymentAttempt } from "@payops/sdk";
import type { WalletAccountSolana } from "@tetherto/wdk-wallet-solana";
import {
  submitPayOpsUsdtPayment,
  type PayOpsSolanaRpc,
} from "@payops/wdk-solana";

type WdkSignedTransaction = Awaited<
  ReturnType<WalletAccountSolana["signTransaction"]>
>;

async function submitPayOpsPayment(
  account: WalletAccountSolana,
  attempt: PublicPaymentAttempt,
  expectedRecipient: string,
  rpc: PayOpsSolanaRpc<WdkSignedTransaction>,
) {
  return submitPayOpsUsdtPayment({
    account,
    attempt,
    expectedRecipient,
    rpc,
  });
}
```

The injected RPC port provides four operations: obtain a recent blockhash,
submit the caller-signed transaction, inspect its signature status, and read the
current block height. This keeps provider SDKs and credentials outside the
adapter.

Every post-submit result includes the transaction signature:

- `finalized` means the injected RPC observed finalized commitment with no
  transaction error.
- `failed` includes the on-chain error reported for the signature.
- `expired` means the transaction passed its last valid block height before
  finalization.
- `submitted` means bounded polling ended at `processed`, `confirmed`, or no
  observed commitment. The caller can continue checking the returned signature.

These statuses describe wallet submission only. PayOps still verifies the
finalized transfer and invoice constraints independently before marking an
invoice paid.

The package remains private while this integration surface is reviewed.

## Development

Requires Node.js 22.18 or newer and pnpm 11.15.

```bash
pnpm install --frozen-lockfile
pnpm check
```

Only public test data is used. Do not place production mnemonics, private keys,
signed transaction bytes, or private payment data in this repository.

## Current limitations

Tether WDK Solana is pinned to `1.0.0-beta.12` and is itself a beta package.
This repository does not own RPC infrastructure, update PayOps invoice state,
publish an npm package, support Token-2022, or claim endorsement by Tether.
