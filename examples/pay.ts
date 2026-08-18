import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import type { PublicPaymentAttempt } from "@payops/sdk";
import WalletManagerSolana from "@tetherto/wdk-wallet-solana";

import {
  buildReferencedUsdtTransaction,
  createWdkSolanaRpc,
  parsePayOpsUsdtRequest,
  submitPayOpsUsdtPayment,
} from "../src/index.js";

const HELP = `Usage: pnpm example -- --attempt <path> --recipient <address> --rpc <url> [options]

Options:
  --attempt <path>              Public PayOps payment attempt JSON
  --recipient <address>         Trusted merchant recipient address
  --rpc <url>                   Solana HTTP or HTTPS RPC URL
  --broadcast                   Submit the signed transaction
  --max-status-checks <number>  Bound finalization checks after submission
  --help                        Show this help

--broadcast submits the transaction and can spend SOL fees and USDT.
Without --broadcast, the command only prepares and signs the transaction.
`;

interface ExampleOptions {
  readonly attemptPath: string;
  readonly broadcast: boolean;
  readonly help: boolean;
  readonly maxStatusChecks?: number;
  readonly recipient: string;
  readonly rpcUrl: string;
}

export interface ExampleDependencies {
  readonly createWalletManager?: (
    seed: string,
    config: ConstructorParameters<typeof WalletManagerSolana>[1],
  ) => WalletManagerSolana;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: Date;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
}

function parseArguments(argv: readonly string[]): ExampleOptions {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const valueFlags = new Set([
    "--attempt",
    "--max-status-checks",
    "--recipient",
    "--rpc",
  ]);
  const switchFlags = new Set(["--broadcast", "--help"]);

  const firstArgumentIndex = argv[0] === "--" ? 1 : 0;
  for (let index = firstArgumentIndex; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      !argument ||
      (!valueFlags.has(argument) && !switchFlags.has(argument))
    ) {
      throw new Error(`Unknown argument: ${argument ?? ""}`);
    }
    if (values.has(argument) || switches.has(argument)) {
      throw new Error(`Duplicate argument: ${argument}`);
    }
    if (switchFlags.has(argument)) {
      switches.add(argument);
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }
    values.set(argument, value);
    index += 1;
  }

  const help = switches.has("--help");
  if (help) {
    return {
      attemptPath: values.get("--attempt") ?? "",
      broadcast: switches.has("--broadcast"),
      help,
      recipient: values.get("--recipient") ?? "",
      rpcUrl: values.get("--rpc") ?? "",
    };
  }

  const attemptPath = values.get("--attempt");
  const recipient = values.get("--recipient");
  const rpcUrl = values.get("--rpc");
  if (!attemptPath || !recipient || !rpcUrl) {
    throw new Error("--attempt, --recipient, and --rpc are required");
  }

  const rawMaxStatusChecks = values.get("--max-status-checks");
  let maxStatusChecks: number | undefined;
  if (rawMaxStatusChecks !== undefined) {
    maxStatusChecks = Number(rawMaxStatusChecks);
    if (
      !/^[1-9]\d*$/.test(rawMaxStatusChecks) ||
      !Number.isSafeInteger(maxStatusChecks)
    ) {
      throw new Error("--max-status-checks must be a positive safe integer");
    }
  }

  return {
    attemptPath,
    broadcast: switches.has("--broadcast"),
    help,
    ...(maxStatusChecks === undefined ? {} : { maxStatusChecks }),
    recipient,
    rpcUrl,
  };
}

function writeJson(
  stream: Pick<NodeJS.WriteStream, "write">,
  value: Readonly<Record<string, unknown>>,
): void {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runPayOpsExample(
  argv: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
  dependencies: ExampleDependencies = {},
): Promise<void> {
  const options = parseArguments(argv);
  const stdout = dependencies.stdout ?? process.stdout;
  if (options.help) {
    stdout.write(HELP);
    return;
  }

  const serializedAttempt = await readFile(options.attemptPath, "utf8");
  const attempt = JSON.parse(serializedAttempt) as PublicPaymentAttempt;
  const intent = parsePayOpsUsdtRequest(attempt, {
    expectedRecipient: options.recipient,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });

  const seed = env.PAYOPS_WDK_SEED_PHRASE;
  if (!seed || seed.trim().length === 0) {
    throw new Error("PAYOPS_WDK_SEED_PHRASE is required");
  }

  const createWalletManager =
    dependencies.createWalletManager ??
    ((walletSeed, config) => new WalletManagerSolana(walletSeed, config));
  const manager = createWalletManager(seed, {
    commitment: "finalized",
    provider: options.rpcUrl,
  });

  try {
    const account = await manager.getAccount(0);
    const rpc = createWdkSolanaRpc({
      account,
      commitment: "finalized",
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      rpcUrl: options.rpcUrl,
    });
    if (options.broadcast) {
      const result = await submitPayOpsUsdtPayment({
        account,
        attempt,
        expectedRecipient: options.recipient,
        ...(options.maxStatusChecks === undefined
          ? {}
          : { finalization: { maxStatusChecks: options.maxStatusChecks } }),
        ...(dependencies.now ? { now: dependencies.now } : {}),
        rpc,
      });
      writeJson(stdout, {
        broadcast: true,
        ...(result.status === "submitted"
          ? { confirmationStatus: result.confirmationStatus }
          : {}),
        mode: "broadcast",
        signature: result.signature,
        status: result.status,
      });
      if (result.status === "failed") {
        const stderr = dependencies.stderr ?? process.stderr;
        stderr.write("Transaction submission failed on-chain.\n");
      }
      return;
    }

    const lifetime = await rpc.getLatestBlockhash();
    const transaction = await buildReferencedUsdtTransaction(
      intent,
      await account.getAddress(),
      lifetime,
    );
    await account.signTransaction(transaction);

    writeJson(stdout, {
      amountBaseUnits: attempt.amountBaseUnits,
      amountTokens: attempt.amountTokens,
      asset: attempt.assetSymbol,
      broadcast: false,
      mode: "prepare",
      payer: await account.getAddress(),
      quoteExpiresAt: attempt.quoteExpiresAt,
      recipient: options.recipient,
      reference: attempt.reference,
    });
  } finally {
    manager.dispose();
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

if (isMainModule()) {
  runPayOpsExample(process.argv.slice(2), process.env).catch(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      process.stderr.write(`Error: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
