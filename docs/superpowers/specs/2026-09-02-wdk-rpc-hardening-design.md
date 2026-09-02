# WDK Solana RPC Hardening Design

## Goal

Make payment submission safe when Solana confirmation polling fails, and bound every HTTP RPC request so a slow or malformed endpoint cannot hang the adapter indefinitely.

## Compatibility

The existing submission status names and required fields remain unchanged. `SubmittedPayOpsUsdtSubmission` gains an optional `finalizationError` field. Existing consumers can continue switching on `status`, while consumers that want diagnostics can inspect the new field.

## Submission behavior

Before `sendTransaction` returns a valid signature, errors continue to reject normally because no transaction identifier is available.

After a valid signature exists, errors from signature-status lookup, block-height lookup, or the polling wait callback return:

```ts
{
  status: "submitted",
  signature,
  confirmationStatus,
  finalizationError,
}
```

This communicates that broadcast succeeded but finality is unknown. It prevents callers from treating a polling failure as proof that submission failed and blindly sending the payment again.

On-chain transaction errors still return `status: "failed"`; blockhash expiry still returns `status: "expired"`; finalized transactions still return `status: "finalized"`.

## RPC transport bounds

`createWdkSolanaRpc` gains optional transport settings with conservative defaults:

- request timeout: 10 seconds;
- maximum response size: 1 MiB;
- redirects rejected;
- optional caller abort signal combined with the timeout signal.

Responses are read as text, bounded by `Content-Length` when available and by the actual encoded body size, then parsed as JSON. Timeout, cancellation, redirect, oversized response, malformed JSON, HTTP, and JSON-RPC failures are converted to stable `PayOpsWdkError` failures.

## Testing

Tests are written before production changes and must demonstrate:

- a status lookup failure after broadcast preserves the signature;
- a block-height failure after broadcast preserves the signature and latest known confirmation status;
- a polling callback failure after broadcast preserves the signature;
- timeout and caller cancellation are passed to fetch and reported predictably;
- redirects are rejected;
- declared and actual oversized responses are rejected;
- normal finalized, failed, expired, and submitted paths remain unchanged.

The focused tests and the complete `pnpm check` and package verification commands must pass before the branch is pushed.
