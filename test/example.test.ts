import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import WalletManagerSolana from "@tetherto/wdk-wallet-solana";

import { runPayOpsExample } from "../examples/pay.js";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const RECIPIENT = "7Ecwo1uPym3WrdhV7vxkgeBpgpDHFYkGAPs8tD5dBEKf";
const REFERENCE = "Vote111111111111111111111111111111111111111";
const SIGNATURE = "5".repeat(88);
const NOW = new Date("2026-08-18T10:00:00.000Z");
const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/payment-attempt.json", import.meta.url),
);

function collectOutput(): {
  readonly stream: Pick<NodeJS.WriteStream, "write">;
  readonly text: () => string;
} {
  let output = "";
  return {
    stream: {
      write(chunk: string | Uint8Array) {
        output += String(chunk);
        return true;
      },
    },
    text: () => output,
  };
}

function blockhashResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      result: {
        context: { slot: 123 },
        value: {
          blockhash: "11111111111111111111111111111111",
          lastValidBlockHeight: 456,
        },
      },
    }),
    { status: 200 },
  );
}

function commandArguments(...extra: string[]): string[] {
  return [
    "--attempt",
    FIXTURE_PATH,
    "--recipient",
    RECIPIENT,
    "--rpc",
    "https://rpc.example.test",
    ...extra,
  ];
}

describe("runPayOpsExample", () => {
  it("prepares and signs without broadcasting by default", async () => {
    const stdout = collectOutput();
    const fetchMock = vi.fn(async () => blockhashResponse());

    await runPayOpsExample(
      commandArguments(),
      { PAYOPS_WDK_SEED_PHRASE: MNEMONIC },
      { fetch: fetchMock, now: NOW, stdout: stdout.stream },
    );

    expect(JSON.parse(stdout.text())).toEqual(
      expect.objectContaining({
        amountTokens: "12.500001",
        asset: "USDT",
        broadcast: false,
        mode: "prepare",
        recipient: RECIPIENT,
        reference: REFERENCE,
      }),
    );
    expect(stdout.text()).not.toContain(MNEMONIC);
    expect(stdout.text()).not.toContain("messageBytes");
    expect(stdout.text()).not.toContain("signatures");
  });

  it("prints help without requiring a wallet or RPC", async () => {
    const stdout = collectOutput();
    const fetchMock = vi.fn();

    await runPayOpsExample(
      ["--", "--help"],
      {},
      {
        fetch: fetchMock,
        stdout: stdout.stream,
      },
    );

    expect(stdout.text()).toContain("Without --broadcast");
    expect(stdout.text()).toContain("can spend SOL fees and USDT");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unknown arguments", async () => {
    await expect(runPayOpsExample(["--unknown"], {})).rejects.toThrow(
      "Unknown argument: --unknown",
    );
  });

  it("requires a seed only after validating the public attempt", async () => {
    const fetchMock = vi.fn();

    await expect(
      runPayOpsExample(commandArguments(), {}, { fetch: fetchMock, now: NOW }),
    ).rejects.toThrow("PAYOPS_WDK_SEED_PHRASE is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed attempt JSON before wallet or RPC use", async () => {
    const directory = await mkdtemp(join(tmpdir(), "payops-wdk-example-"));
    const path = join(directory, "attempt.json");
    await writeFile(path, "{not-json", "utf8");
    const fetchMock = vi.fn();
    const createWalletManager = vi.fn();

    try {
      await expect(
        runPayOpsExample(
          commandArguments().map((value) =>
            value === FIXTURE_PATH ? path : value,
          ),
          { PAYOPS_WDK_SEED_PHRASE: MNEMONIC },
          { createWalletManager, fetch: fetchMock, now: NOW },
        ),
      ).rejects.toBeInstanceOf(SyntaxError);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(createWalletManager).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects an invalid trusted recipient before wallet or RPC use", async () => {
    const fetchMock = vi.fn();
    const createWalletManager = vi.fn();
    const args = commandArguments().map((value) =>
      value === RECIPIENT ? "not-a-solana-address" : value,
    );

    await expect(
      runPayOpsExample(
        args,
        { PAYOPS_WDK_SEED_PHRASE: MNEMONIC },
        { createWalletManager, fetch: fetchMock, now: NOW },
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_attempt" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createWalletManager).not.toHaveBeenCalled();
  });

  it("rejects an expired attempt before wallet or RPC use", async () => {
    const fetchMock = vi.fn();
    const createWalletManager = vi.fn();

    await expect(
      runPayOpsExample(
        commandArguments(),
        { PAYOPS_WDK_SEED_PHRASE: MNEMONIC },
        {
          createWalletManager,
          fetch: fetchMock,
          now: new Date("2036-01-01T00:00:00.000Z"),
        },
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "expired_attempt" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createWalletManager).not.toHaveBeenCalled();
  });

  it("broadcasts only when explicitly requested", async () => {
    const manager = new WalletManagerSolana(MNEMONIC, {
      commitment: "finalized",
      provider: "http://127.0.0.1:1",
    });
    const account = await manager.getAccount(0);
    const sendTransaction = vi
      .spyOn(account, "sendTransaction")
      .mockResolvedValue({ fee: 5_000n, hash: SIGNATURE });
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "getLatestBlockhash") {
          return blockhashResponse();
        }
        if (request.method === "getSignatureStatuses") {
          return new Response(
            JSON.stringify({
              id: 2,
              jsonrpc: "2.0",
              result: {
                context: { slot: 124 },
                value: [{ confirmationStatus: "finalized", err: null }],
              },
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected RPC method: ${request.method}`);
      },
    );
    const stdout = collectOutput();

    await runPayOpsExample(
      commandArguments("--broadcast", "--max-status-checks", "2"),
      { PAYOPS_WDK_SEED_PHRASE: MNEMONIC },
      {
        createWalletManager: () => manager,
        fetch: fetchMock,
        now: NOW,
        stdout: stdout.stream,
      },
    );

    expect(JSON.parse(stdout.text())).toEqual({
      broadcast: true,
      mode: "broadcast",
      signature: SIGNATURE,
      status: "finalized",
    });
    expect(sendTransaction).toHaveBeenCalledOnce();
    expect(stdout.text()).not.toContain(MNEMONIC);
    expect(stdout.text()).not.toContain("messageBytes");
    expect(stdout.text()).not.toContain("signatures");
  });
});
