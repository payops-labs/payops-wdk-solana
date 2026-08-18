import { MAINNET_USDT } from "@payops/core";
import {
  getCreateAssociatedTokenIdempotentInstructionDataEncoder,
  getTransferCheckedInstructionDataEncoder,
} from "@solana-program/token";
import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/addresses";
import { AccountRole, type Instruction } from "@solana/instructions";
import { blockhash, type Blockhash } from "@solana/rpc-types";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/transaction-messages";

import { PayOpsWdkError } from "./errors.js";
import type { PayOpsUsdtIntent } from "./payment-request.js";

const ASSOCIATED_TOKEN_PROGRAM = address(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const U64_MAX = 18_446_744_073_709_551_615n;
const addressEncoder = getAddressEncoder();

export interface BlockhashLifetime {
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
}

function fail(code: PayOpsWdkError["code"], message: string): never {
  throw new PayOpsWdkError(code, message);
}

function checkedAddress(value: string, code: PayOpsWdkError["code"]): Address {
  try {
    return address(value);
  } catch {
    return fail(code, "Transaction contains an invalid Solana address");
  }
}

function checkedBlockhash(value: string): Blockhash {
  try {
    return blockhash(value);
  } catch {
    return fail("invalid_lifetime", "Transaction blockhash is invalid");
  }
}

async function associatedTokenAddress(
  owner: Address,
  mint: Address,
): Promise<Address> {
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [
      addressEncoder.encode(owner),
      addressEncoder.encode(TOKEN_PROGRAM),
      addressEncoder.encode(mint),
    ],
  });
  return ata;
}

function createAtaInstruction(
  payer: Address,
  ata: Address,
  owner: Address,
  mint: Address,
): Instruction {
  return {
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: ata, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    ],
    data: Uint8Array.from(
      getCreateAssociatedTokenIdempotentInstructionDataEncoder().encode({}),
    ),
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
  };
}

function transferCheckedInstruction(
  source: Address,
  mint: Address,
  destination: Address,
  authority: Address,
  reference: Address,
  amount: bigint,
): Instruction {
  const data = Uint8Array.from(
    getTransferCheckedInstructionDataEncoder().encode({
      amount,
      decimals: 6,
    }),
  );

  return {
    accounts: [
      { address: source, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      { address: destination, role: AccountRole.WRITABLE },
      { address: authority, role: AccountRole.READONLY_SIGNER },
      { address: reference, role: AccountRole.READONLY },
    ],
    data,
    programAddress: TOKEN_PROGRAM,
  };
}

export async function buildReferencedUsdtTransaction(
  intent: PayOpsUsdtIntent,
  payerAddress: string,
  lifetime: BlockhashLifetime,
) {
  if (intent.mint !== String(MAINNET_USDT.mint) || intent.decimals !== 6) {
    return fail(
      "unsupported_asset",
      "Only canonical mainnet USDT is supported",
    );
  }
  if (intent.amountBaseUnits <= 0n || intent.amountBaseUnits > U64_MAX) {
    return fail("invalid_attempt", "Payment amount is outside the SPL range");
  }
  if (lifetime.lastValidBlockHeight < 0n) {
    return fail("invalid_lifetime", "Last valid block height is invalid");
  }

  const payer = checkedAddress(payerAddress, "invalid_payer");
  const mint = checkedAddress(intent.mint, "unsupported_asset");
  const recipient = checkedAddress(intent.recipient, "invalid_attempt");
  const reference = checkedAddress(intent.reference, "invalid_attempt");
  const payerAta = await associatedTokenAddress(payer, mint);
  const recipientAta = await associatedTokenAddress(recipient, mint);

  const occupiedAddresses = new Set<Address>([
    payer,
    payerAta,
    recipient,
    recipientAta,
    mint,
    ASSOCIATED_TOKEN_PROGRAM,
    SYSTEM_PROGRAM,
    TOKEN_PROGRAM,
  ]);
  if (occupiedAddresses.has(reference)) {
    return fail(
      "invalid_attempt",
      "Payment reference must be a dedicated read-only account",
    );
  }

  const instructions = [
    createAtaInstruction(payer, recipientAta, recipient, mint),
    transferCheckedInstruction(
      payerAta,
      mint,
      recipientAta,
      payer,
      reference,
      intent.amountBaseUnits,
    ),
  ] as const;

  const message = createTransactionMessage({ version: 0 });
  const withFeePayer = setTransactionMessageFeePayer(payer, message);
  const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
    {
      blockhash: checkedBlockhash(lifetime.blockhash),
      lastValidBlockHeight: lifetime.lastValidBlockHeight,
    },
    withFeePayer,
  );
  return appendTransactionMessageInstructions(instructions, withLifetime);
}
