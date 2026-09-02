# WDK Solana RPC Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve a submitted transaction signature when confirmation polling
fails and bound every Solana JSON-RPC request.

**Architecture:** Keep the existing submission state union and add optional
diagnostics only to the `submitted` branch. Harden the HTTP adapter at its
single `call` boundary so timeout, cancellation, redirects, response-size
limits, parsing, and transport errors are handled consistently.

**Tech Stack:** TypeScript 5.9, Node.js 22, Vitest 4, Fetch and AbortSignal
APIs, pnpm 11.

## Global Constraints

- Existing required result fields and status names remain unchanged.
- Default request timeout is 10,000 milliseconds.
- Default maximum response size is 1 MiB.
- On-chain failure, expiration, finalization, and bounded-polling behavior
  remain unchanged.
- Tests must be written and observed failing before production code changes.

---

### Task 1: Preserve broadcast identity when finalization infrastructure fails

**Files:**

- Modify: `test/adapter.test.ts`
- Modify: `src/adapter.ts`

**Interfaces:**

- Consumes: `PayOpsSolanaRpc<TSignedTransaction>` and
  `submitPayOpsUsdtPayment(options)`.
- Produces: `SubmittedPayOpsUsdtSubmission.finalizationError?: unknown`.

- [ ] **Step 1: Add regression tests for all post-broadcast failure points**

Add three tests using `mockOptions`:

```ts
it("preserves the signature when status lookup fails after broadcast", async () => {
  const statusError = new Error("status unavailable");
  const { options, rpc } = mockOptions(null, 90n);
  vi.mocked(rpc.getSignatureStatus).mockRejectedValueOnce(statusError);

  await expect(submitPayOpsUsdtPayment(options)).resolves.toEqual({
    confirmationStatus: null,
    finalizationError: statusError,
    signature: SIGNATURE,
    status: "submitted",
  });
});

it("preserves the latest status when block-height lookup fails", async () => {
  const heightError = new Error("height unavailable");
  const { options, rpc } = mockOptions(
    { confirmationStatus: "confirmed", err: null },
    90n,
  );
  vi.mocked(rpc.getBlockHeight).mockRejectedValueOnce(heightError);

  await expect(submitPayOpsUsdtPayment(options)).resolves.toEqual({
    confirmationStatus: "confirmed",
    finalizationError: heightError,
    signature: SIGNATURE,
    status: "submitted",
  });
});

it("preserves the signature when the polling wait fails", async () => {
  const waitError = new Error("wait interrupted");
  const { options } = mockOptions(null, 90n);
  const waitBetweenChecks = vi.fn(async () => {
    throw waitError;
  });

  await expect(
    submitPayOpsUsdtPayment({
      ...options,
      finalization: { maxStatusChecks: 2, waitBetweenChecks },
    }),
  ).resolves.toEqual({
    confirmationStatus: null,
    finalizationError: waitError,
    signature: SIGNATURE,
    status: "submitted",
  });
});
```

- [ ] **Step 2: Run the focused tests and observe the expected rejection**

Run: `pnpm test -- test/adapter.test.ts`

Expected: the three new cases fail because the current function rejects after
broadcast.

- [ ] **Step 3: Add the optional diagnostic and catch only the finalization
      phase**

Add this optional property to `SubmittedPayOpsUsdtSubmission`:

```ts
readonly finalizationError?: unknown;
```

Replace the existing polling loop with this complete block:

```ts
let confirmationStatus: SubmittedPayOpsUsdtSubmission["confirmationStatus"] =
  null;

for (let completedStatusChecks = 1; ; completedStatusChecks += 1) {
  try {
    const status = await options.rpc.getSignatureStatus(signature);
    if (status?.err !== null && status?.err !== undefined) {
      return { error: status.err, signature, status: "failed" };
    }
    if (status?.confirmationStatus === "finalized" && status.err === null) {
      return { signature, status: "finalized" };
    }
    confirmationStatus =
      status?.confirmationStatus === "finalized"
        ? null
        : (status?.confirmationStatus ?? null);

    const blockHeight = await options.rpc.getBlockHeight();
    if (blockHeight > lifetime.lastValidBlockHeight) {
      return { signature, status: "expired" };
    }
    if (completedStatusChecks >= maxStatusChecks) {
      return { confirmationStatus, signature, status: "submitted" };
    }
    await waitBetweenChecks(completedStatusChecks);
  } catch (finalizationError) {
    return {
      confirmationStatus,
      finalizationError,
      signature,
      status: "submitted",
    };
  }
}
```

- [ ] **Step 4: Run the focused tests**

Run: `pnpm test -- test/adapter.test.ts`

Expected: all adapter tests pass.

- [ ] **Step 5: Commit the submission safety change**

```bash
git add src/adapter.ts test/adapter.test.ts
git commit -m "fix: preserve submitted signature on polling errors"
```

### Task 2: Bound and normalize Solana RPC transport behavior

**Files:**

- Modify: `test/wdk-solana-rpc.test.ts`
- Modify: `src/wdk-solana-rpc.ts`

**Interfaces:**

- Consumes: `CreateWdkSolanaRpcOptions<TSignedTransaction>`.
- Produces: optional `requestTimeoutMs?: number`, `maxResponseBytes?: number`,
  and `signal?: AbortSignal`.

- [ ] **Step 1: Add failing transport tests**

Add tests that:

- inspect the fetch options and require `redirect: "error"` plus an
  `AbortSignal`;
- abort a pending request through a caller-owned `AbortController` and expect
  `PayOpsWdkError.code === "invalid_rpc_response"`;
- set `requestTimeoutMs: 1` on a pending request and expect the same stable
  error code;
- return `Content-Length: 1048577` and reject before parsing;
- return an actual UTF-8 body larger than the configured `maxResponseBytes` and
  reject;
- reject zero, negative, non-integer, and unsafe timeout/size values as
  `invalid_rpc_config`.

- [ ] **Step 2: Run the focused RPC tests and observe the failures**

Run: `pnpm test -- test/wdk-solana-rpc.test.ts`

Expected: failures show missing option types, missing redirect/signal controls,
raw abort rejection, and unbounded responses.

- [ ] **Step 3: Add validated transport defaults**

Add constants and options:

```ts
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface CreateWdkSolanaRpcOptions<TSignedTransaction> {
  readonly account: WdkSolanaSubmissionAccount<TSignedTransaction>;
  readonly commitment?: Commitment;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxResponseBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly rpcUrl: string;
  readonly signal?: AbortSignal;
}
```

Validate both numeric options as positive safe integers and throw
`PayOpsWdkError("invalid_rpc_config", ...)` before network or wallet use.

- [ ] **Step 4: Implement bounded fetch and JSON parsing**

For every request:

1. Create `AbortSignal.timeout(requestTimeoutMs)`.
2. Combine it with `options.signal` through `AbortSignal.any` when supplied.
3. Pass `redirect: "error"` and the combined signal to fetch.
4. Convert fetch/abort failures into
   `PayOpsWdkError("invalid_rpc_response", "Solana RPC request failed")`.
5. Reject a numeric `Content-Length` larger than `maxResponseBytes`.
6. Read `response.text()`, reject when
   `new TextEncoder().encode(text).byteLength` exceeds the limit, and parse with
   `JSON.parse`.
7. Retain all existing HTTP, JSON-RPC, result-shape, block-height, status, and
   signature validation.

- [ ] **Step 5: Run the focused RPC tests**

Run: `pnpm test -- test/wdk-solana-rpc.test.ts`

Expected: all RPC tests pass without unhandled abort or timer failures.

- [ ] **Step 6: Run all WDK verification**

Run: `pnpm check && pnpm package:verify && pnpm audit --prod`

Expected: formatting, type checking, all tests, build, package contents, and
dependency audit pass.

- [ ] **Step 7: Commit the transport hardening**

```bash
git add src/wdk-solana-rpc.ts test/wdk-solana-rpc.test.ts
git commit -m "fix: bound Solana RPC transport"
```

### Task 3: Review and publish

**Files:**

- Review: `src/adapter.ts`
- Review: `src/wdk-solana-rpc.ts`
- Review: `test/adapter.test.ts`
- Review: `test/wdk-solana-rpc.test.ts`

**Interfaces:**

- Consumes: completed Tasks 1 and 2.
- Produces: a pushed `fix/wdk-rpc-hardening` branch and GitHub pull request.

- [ ] **Step 1: Confirm the branch diff contains only the approved scope**

Run:
`git diff --check origin/main...HEAD && git diff --stat origin/main...HEAD && git status --short`

Expected: no whitespace errors, only spec/plan plus adapter and RPC hardening
files, and a clean worktree.

- [ ] **Step 2: Push and create the PR**

```bash
git push -u origin fix/wdk-rpc-hardening
gh pr create --base main --head fix/wdk-rpc-hardening --title "fix: harden WDK submission finalization and RPC transport" --body $'## Summary\n- preserve a valid transaction signature when finalization polling fails\n- bound Solana RPC requests with timeout, cancellation, redirect, and response-size controls\n- add regression coverage for post-broadcast and transport failures\n\n## Verification\n- pnpm check\n- pnpm package:verify\n- pnpm audit --prod'
```

- [ ] **Step 3: Verify GitHub checks**

Run: `gh pr checks --watch --interval 10`

Expected: all GitHub Actions checks succeed.
