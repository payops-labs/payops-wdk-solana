# PayOps WDK Solana

Reference integration for signing an exact PayOps Solana USDT payment with
Tether WDK.

This repository is part of [PayOps Labs](https://github.com/payops-labs). The
wallet-neutral payment verification and reconciliation system lives in
[solana-payment-ops](https://github.com/payops-labs/solana-payment-ops).

## What this proves

The compatibility proof takes a public PayOps payment attempt, checks its
security-sensitive fields, builds the matching SPL Token transaction, adds the
PayOps invoice reference as a read-only account, and passes the prebuilt message
to Tether WDK for signing.

The automated proof uses an unreachable local RPC endpoint. It signs but never
broadcasts, so it needs no funded wallet or paid infrastructure.

## Trust boundary

- The caller owns and configures its WDK wallet.
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
  buildReferencedUsdtTransaction,
  parsePayOpsUsdtRequest,
} from "@payops/wdk-solana";

async function signPayOpsPayment(
  account: WalletAccountSolana,
  attempt: PublicPaymentAttempt,
  expectedRecipient: string,
  lifetime: { blockhash: string; lastValidBlockHeight: bigint },
) {
  const intent = parsePayOpsUsdtRequest(attempt, { expectedRecipient });
  const payer = await account.getAddress();
  const transaction = await buildReferencedUsdtTransaction(
    intent,
    payer,
    lifetime,
  );

  return account.signTransaction(transaction);
}
```

The package is not published in PR 1. The example documents the intended adapter
API while the repository remains a reviewed compatibility proof.

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
This repository does not broadcast transactions, poll payment state, publish an
npm package, support Token-2022, or claim endorsement by Tether.
