# PayOps WDK Solana

Reference integration for preparing, signing, and optionally submitting an exact
PayOps Solana USDT payment with Tether WDK.

This repository is part of [PayOps Labs](https://github.com/payops-labs). The
wallet-neutral payment verification and reconciliation system lives in
[solana-payment-ops](https://github.com/payops-labs/solana-payment-ops).

## Install the beta

The adapter is published as a beta while Tether WDK Solana remains beta and the
integration contract is intentionally narrow.

```bash
npm install @payops/wdk-solana@beta
```

The package is non-custodial. Applications provide and retain control of the WDK
account, RPC endpoint, trusted recipient, and transaction submission policy.

## What this proves

The adapter takes a public PayOps payment attempt, checks its security-sensitive
fields, builds the matching SPL Token transaction, adds the PayOps invoice
reference as a read-only account, and passes the prebuilt message to a
caller-owned Tether WDK account for signing. The concrete RPC adapter delegates
submission to that WDK account, then checks Solana status until the transaction
is finalized, fails, expires, or reaches the configured polling bound.

The runnable command prepares and signs by default without broadcasting. The
automated workflow uses deterministic public data and mocked RPC responses, so
tests need no funded wallet, external network, or paid infrastructure.

## Trust boundary

- The caller owns and configures its WDK wallet.
- The caller chooses the RPC endpoint and owns its credentials and retry policy.
- Tether WDK owns key handling, signing, fee calculation, and submission.
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

## Runnable example

Install and build the project:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Prepare and sign the public fixture without broadcasting:

```bash
PAYOPS_WDK_SEED_PHRASE="..." pnpm example -- \
  --attempt test/fixtures/payment-attempt.json \
  --recipient 7Ecwo1uPym3WrdhV7vxkgeBpgpDHFYkGAPs8tD5dBEKf \
  --rpc https://your-solana-rpc.example
```

Prepare mode validates the attempt before creating the wallet or contacting RPC.
Its output contains only the public payment fields and derived payer address. It
does not print the seed phrase, signed transaction, message bytes, or
signatures.

Add `--broadcast` only when using an intended live attempt, recipient, wallet,
and RPC endpoint:

```bash
PAYOPS_WDK_SEED_PHRASE="..." pnpm example -- \
  --attempt path/to/live-payment-attempt.json \
  --recipient YOUR_TRUSTED_MERCHANT_ADDRESS \
  --rpc https://your-solana-rpc.example \
  --broadcast
```

Broadcast mode can transfer USDT and spend SOL fees. It delegates submission to
the WDK account and reports the signature plus the bounded finalization result.
PayOps still verifies the finalized transfer independently before changing the
invoice state.

Run `pnpm example -- --help` for all command options.

## Library usage

```ts
import type { PublicPaymentAttempt } from "@payops/sdk";
import type { WalletAccountSolana } from "@tetherto/wdk-wallet-solana";
import {
  createWdkSolanaRpc,
  submitPayOpsUsdtPayment,
} from "@payops/wdk-solana";

type WdkSignedTransaction = Awaited<
  ReturnType<WalletAccountSolana["signTransaction"]>
>;

async function submitPayOpsPayment(
  account: WalletAccountSolana,
  attempt: PublicPaymentAttempt,
  expectedRecipient: string,
  rpcUrl: string,
) {
  const rpc = createWdkSolanaRpc<WdkSignedTransaction>({
    account,
    rpcUrl,
  });

  return submitPayOpsUsdtPayment({
    account,
    attempt,
    expectedRecipient,
    rpc,
  });
}
```

The concrete RPC adapter obtains a recent blockhash, reads transaction status,
and checks the current block height through Solana JSON-RPC. Signed transaction
submission stays inside Tether WDK.

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
support Token-2022, or claim endorsement by Tether.

## Releases

Beta releases are built from reviewed tags by the protected GitHub release
workflow. The workflow reruns tests, type checks, the production audit, and a
package-content dry run before publishing to npm with provenance. See
[RELEASING.md](RELEASING.md) for the operator checklist.
