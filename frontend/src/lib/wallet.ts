// Real ICRC-1 token balances (plus real send/approve) for the signed-in
// principal - "a Tokens balance screen like MetaMask UI" (the user's own
// framing). Two tokens are always shown - the ICP Ledger (native ICP) and
// the Cycles Ledger (the real ICRC-1-compatible token that funds canister
// creation on mainnet - see `lib/deploy.ts`'s own doc comment on the
// cycles-funding gap this connects to) - plus whatever real ledger
// canisters the caller has added to their own browser-local watchlist. The
// list is scoped by network and principal so identities and environments do
// not leak into one another. No fiat conversion anywhere - there's
// no price oracle in this codebase, so this only ever shows raw on-chain
// balances.

import { Actor } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import {
  CmcCanister,
  InvalidaTransactionError,
  RefundedError,
  TransactionTooOldError,
} from "@icp-sdk/canisters/cmc";
import { IcpLedgerCanister, SubAccount } from "@icp-sdk/canisters/ledger/icp";
import { getAgent } from "./agent";
import { idlFactory as icrc1IdlFactory, type Icrc1Service, type TransferError, type ApproveError } from "./candid/icrc1";
import {
  idlFactory as cyclesLedgerIdlFactory,
  type CyclesLedgerService,
} from "./candid/cyclesLedger";
import {
  idlFactory as icrc1IndexIdlFactory,
  type Icrc1IndexService,
} from "./candid/icrc1Index";

/** The IC's canonical ledger ids. The managed local network exposes these
 * system canisters at the same ids, so callers query them on both networks.
 * `CYCLES_LEDGER_CANISTER_ID` is exported so the Wallet page's merged-in
 * billing section can pick the Cycles Ledger's own entry out of
 * `getTokenBalances`'s result instead of fetching it a second time. */
export const ICP_LEDGER_CANISTER_ID = "ryjl3-tyaaa-aaaaa-aaaba-cai";
export const CYCLES_LEDGER_CANISTER_ID = "um5iw-rqaaa-aaaaq-qaaba-cai";
export const CMC_CANISTER_ID = "rkp4c-7iaaa-aaaaa-aaaca-cai";

// The CMC requires this exact 8-byte ICRC-1 memo on ICP payments processed
// by `notify_mint_cycles`: ASCII "MINT" followed by four zero bytes.
const MINT_CYCLES_MEMO = new Uint8Array([0x4d, 0x49, 0x4e, 0x54, 0, 0, 0, 0]);
const PENDING_MINT_PREFIX = "canister-hub:pending-cycles-mint";
const TRACKED_TOKENS_PREFIX = "canister-hub:tracked-tokens:v1";
const MAX_BROWSER_TRACKED_TOKENS = 100;
const pendingMints = new Map<string, PendingMint>();

function trackedTokensKey(network: string, owner: Principal): string {
  return `${TRACKED_TOKENS_PREFIX}:${network}:${owner.toText()}`;
}

function readTrackedTokens(network: string, owner: Principal): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(trackedTokensKey(network, owner));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const unique = new Set<string>();
    for (const value of parsed) {
      if (typeof value !== "string") continue;
      try {
        const id = Principal.fromText(value).toText();
        if (id !== ICP_LEDGER_CANISTER_ID && id !== CYCLES_LEDGER_CANISTER_ID) unique.add(id);
      } catch {
        // Ignore malformed browser state instead of breaking the wallet.
      }
      if (unique.size >= MAX_BROWSER_TRACKED_TOKENS) break;
    }
    return [...unique];
  } catch {
    return [];
  }
}

function writeTrackedTokens(network: string, owner: Principal, ids: string[]): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage) throw new Error("localStorage is unavailable");
    storage.setItem(trackedTokensKey(network, owner), JSON.stringify(ids));
  } catch {
    throw new Error("Browser storage is unavailable; the token watchlist could not be saved");
  }
}

export interface MintCyclesResult {
  /** ICP ledger block containing the payment to the CMC. */
  icpBlockIndex: bigint;
  /** Cycles ledger block containing the minted cycles deposit. */
  cyclesBlockIndex: bigint;
  minted: bigint;
  balance: bigint;
  resumed: boolean;
}

interface PendingMint {
  blockIndex: string;
  amountE8s: string;
}

function pendingMintKey(network: string, principal: Principal): string {
  return `${PENDING_MINT_PREFIX}:${network}:${principal.toText()}`;
}

function readPendingMint(key: string): PendingMint | null {
  const inMemory = pendingMints.get(key);
  if (inMemory) return inMemory;
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingMint>;
    if (typeof parsed.blockIndex !== "string" || typeof parsed.amountE8s !== "string") return null;
    BigInt(parsed.blockIndex);
    BigInt(parsed.amountE8s);
    const pending = { blockIndex: parsed.blockIndex, amountE8s: parsed.amountE8s };
    pendingMints.set(key, pending);
    return pending;
  } catch {
    return null;
  }
}

function writePendingMint(key: string, pending: PendingMint): void {
  pendingMints.set(key, pending);
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(pending));
  } catch {
    // Storage can be unavailable in privacy modes. The in-flight call can
    // still complete; only cross-refresh recovery is unavailable.
  }
}

function clearPendingMint(key: string): void {
  pendingMints.delete(key);
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // See writePendingMint.
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error instanceof Error) return error.constructor.name;
  return String(error);
}

/** Returns the CMC's live ICP/XDR rate in 1/10,000 XDR per ICP. Since one
 * XDR mints one trillion cycles, multiplying an e8s amount by this value
 * yields the corresponding estimated raw cycle amount directly. */
export async function getCyclesMintingRate(network: string): Promise<bigint> {
  const agent = await getAgent(network);
  const cmc = CmcCanister.create({ agent, canisterId: Principal.fromText(CMC_CANISTER_ID) });
  return cmc.getIcpToCyclesConversionRate({ certified: true });
}

/** Burns ICP through the CMC and deposits the resulting cycles into the
 * signed-in caller's default Cycles Ledger account.
 *
 * This is the CMC's required two-step protocol:
 * 1. transfer ICP to the CMC account whose subaccount encodes the caller,
 *    with the exact `MINT\0\0\0\0` memo;
 * 2. pass the returned ICP block index to `notify_mint_cycles`.
 *
 * Once step 1 succeeds its block index is retained in local storage until
 * step 2 succeeds. A retry resumes notification instead of transferring
 * and burning the ICP a second time. */
export async function mintCyclesFromIcp(network: string, amountE8s: bigint): Promise<MintCyclesResult> {
  if (amountE8s <= 0n) throw new Error("ICP amount must be greater than zero");

  const agent = await getAgent(network);
  const caller = await agent.getPrincipal();
  if (caller.isAnonymous()) throw new Error("Sign in before minting cycles");

  const storageKey = pendingMintKey(network, caller);
  const pending = readPendingMint(storageKey);
  const resumed = pending !== null;
  let blockIndex: bigint;

  if (pending) {
    blockIndex = BigInt(pending.blockIndex);
  } else {
    const recipientSubaccount = SubAccount.fromPrincipal(caller).toUint8Array();
    const ledger = IcpLedgerCanister.create({ agent, canisterId: Principal.fromText(ICP_LEDGER_CANISTER_ID) });
    try {
      const fee = await ledger.transactionFee({ certified: false });
      blockIndex = await ledger.icrc1Transfer({
        to: {
          owner: Principal.fromText(CMC_CANISTER_ID),
          subaccount: [recipientSubaccount],
        },
        amount: amountE8s,
        fee,
        icrc1Memo: MINT_CYCLES_MEMO,
        // Nanoseconds, used by the ledger for duplicate protection.
        createdAt: BigInt(Date.now()) * 1_000_000n,
      });
    } catch (error) {
      throw new Error(`ICP transfer to the CMC failed: ${errorMessage(error)}`);
    }
    writePendingMint(storageKey, { blockIndex: blockIndex.toString(), amountE8s: amountE8s.toString() });
  }

  const cmc = CmcCanister.create({ agent, canisterId: Principal.fromText(CMC_CANISTER_ID) });
  try {
    const result = await cmc.notifyMintCycles({
      block_index: blockIndex,
      // The CMC deposits into the calling principal's default cycles-ledger
      // account when these optional fields are absent.
      deposit_memo: [],
      to_subaccount: [],
    });
    clearPendingMint(storageKey);
    return {
      icpBlockIndex: blockIndex,
      cyclesBlockIndex: result.block_index,
      minted: result.minted,
      balance: result.balance,
      resumed,
    };
  } catch (error) {
    if (error instanceof RefundedError) {
      // The CMC has returned the payment (minus any applicable fees), so a
      // later confirmation may safely begin a new transfer.
      clearPendingMint(storageKey);
      throw new Error(`The CMC refunded ICP transfer block ${blockIndex}: ${errorMessage(error)}`);
    }
    if (error instanceof InvalidaTransactionError || error instanceof TransactionTooOldError) {
      // Keep the block recorded: silently starting another transfer after a
      // non-retriable notification error could charge the user twice.
      throw new Error(
        `ICP transfer block ${blockIndex} cannot be processed automatically: ${errorMessage(error)}. ` +
          "The payment record has been preserved and no second ICP transfer will be made."
      );
    }
    throw new Error(
      `ICP transfer block ${blockIndex} was recorded, but cycles minting was not confirmed: ${errorMessage(error)}. ` +
        "If the payment was not refunded, click Confirm Top-Up again to retry notification without another ICP transfer."
    );
  }
}

export interface CyclesMintTransaction {
  /** Cycles Ledger block containing the mint. */
  blockIndex: bigint;
  /** Raw cycles credited (10^-12 of the displayed "cycles" unit). */
  minted: bigint;
  /** Ledger timestamp of the mint, in nanoseconds since the epoch. */
  timestampNanos: bigint;
}

// One page of account transactions from the index, and how far back the
// walk has reached. Bounds keep a busy account's history walk finite.
const INDEX_PAGE_SIZE = 50n;
const MAX_INDEX_PAGES = 10;
const MAX_COLLECTED_MINTS = 50;

/** The real Top-Up History source: cycles *mints* credited to the
 * principal's default Cycles Ledger account, read from the ledger's own
 * ICRC-1 index canister (discovered per-network through the ledger's
 * `icrc106_get_index_principal`, so nothing mainnet-only is hardcoded).
 * A mint appears both for CMC `notify_mint_cycles` top-ups (this page's
 * own dialog) and for direct cycles `deposit` calls - both are credits
 * into the balance, which is what "top up" means here. Transfers and
 * approvals are walked past but not collected, and burn-type withdrawals
 * (per-canister top-ups from `topUpCanister`) intentionally do not appear
 * - they move cycles out of this balance. Returns newest first. */
export async function getCyclesMintTransactions(network: string, owner: Principal): Promise<CyclesMintTransaction[]> {
  const agent = await getAgent(network);
  const ledger = Actor.createActor<CyclesLedgerService>(cyclesLedgerIdlFactory, {
    agent,
    canisterId: Principal.fromText(CYCLES_LEDGER_CANISTER_ID),
  });
  const indexPrincipal = await ledger.icrc106_get_index_principal();
  if ("Err" in indexPrincipal) {
    const error = indexPrincipal.Err;
    throw new Error(
      "IndexPrincipalNotSet" in error
        ? "the Cycles Ledger has no index canister configured"
        : `Cycles Ledger index lookup failed: ${error.GenericError.description}`
    );
  }
  const index = Actor.createActor<Icrc1IndexService>(icrc1IndexIdlFactory, {
    agent,
    canisterId: indexPrincipal.Ok,
  });
  const account = { owner, subaccount: [] as [] | [Uint8Array] };
  const seen = new Set<string>();
  const mints: CyclesMintTransaction[] = [];
  let start: [] | [bigint] = [];
  for (let page = 0; page < MAX_INDEX_PAGES; page++) {
    const result = await index.get_account_transactions({ account, start, max_results: INDEX_PAGE_SIZE });
    if ("Err" in result) {
      throw new Error(`Cycles Ledger index query failed: ${result.Err.message}`);
    }
    const response = result.Ok;
    let pageHadNew = false;
    for (const tx of response.transactions) {
      const key = tx.id.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      pageHadNew = true;
      const [mint] = tx.transaction.mint;
      if (!mint) continue;
      mints.push({
        blockIndex: tx.id,
        minted: mint.amount,
        timestampNanos: tx.transaction.timestamp,
      });
    }
    if (mints.length >= MAX_COLLECTED_MINTS) break;
    if (response.transactions.length < Number(INDEX_PAGE_SIZE)) break;
    const [oldest] = response.oldest_tx_id;
    if (oldest === undefined) break;
    // `start` is documented exclusive; the duplicate-page guard just keeps
    // the walk finite should an index ever return the boundary block too.
    if (!pageHadNew && page > 0) break;
    start = [oldest];
  }
  return mints;
}

export interface TokenBalance {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  /** Raw on-chain integer balance (smallest unit) - `null` if unavailable,
   * see `error` for why. */
  balance: bigint | null;
  error?: string;
  /** `false` for the two built-in tokens (ICP, Cycles) - always shown,
   * never removable. `true` for anything the caller added themselves via
   * `addToken`. */
  custom: boolean;
}

function icrc1Actor(canisterId: string, agent: Awaited<ReturnType<typeof getAgent>>): Icrc1Service {
  return Actor.createActor<Icrc1Service>(icrc1IdlFactory, { agent, canisterId: Principal.fromText(canisterId) });
}

async function readBalance(canisterId: string, owner: Principal, network: string): Promise<{ symbol: string; decimals: number; balance: bigint }> {
  const agent = await getAgent(network);
  const actor = icrc1Actor(canisterId, agent);
  const [balance, symbol, decimals] = await Promise.all([
    actor.icrc1_balance_of({ owner, subaccount: [] }),
    actor.icrc1_symbol(),
    actor.icrc1_decimals(),
  ]);
  return { balance, symbol, decimals: Number(decimals) };
}

/** Every real token balance for `owner` - the two built-in tokens plus the
 * caller's browser-local watchlist,
 * best-effort per token (one failure doesn't break the rest - same
 * convention as `lib/canisterStats.ts`). Built-in and custom ledgers are
 * queried through the agent for the selected network; individual failures
 * remain isolated to their token row. */
export async function getTokenBalances(owner: Principal, network: string): Promise<TokenBalance[]> {
  const builtIns = [
    { id: ICP_LEDGER_CANISTER_ID, name: "Internet Computer", fallbackSymbol: "ICP", fallbackDecimals: 8 },
    { id: CYCLES_LEDGER_CANISTER_ID, name: "Trillion Cycles", fallbackSymbol: "TCYCLES", fallbackDecimals: 12 },
  ];

  const builtInBalances = Promise.all(
    builtIns.map(async (t): Promise<TokenBalance> => {
      try {
        const { balance, symbol, decimals } = await readBalance(t.id, owner, network);
        return { id: t.id, name: t.name, symbol, decimals, balance, custom: false };
      } catch (e) {
        return { id: t.id, name: t.name, symbol: t.fallbackSymbol, decimals: t.fallbackDecimals, balance: null, error: e instanceof Error ? e.message : String(e), custom: false };
      }
    })
  );

  const customBalances = Promise.all(
    readTrackedTokens(network, owner).map(async (id): Promise<TokenBalance> => {
      try {
        const { balance, symbol, decimals } = await readBalance(id, owner, network);
        return { id, name: symbol, symbol, decimals, balance, custom: true };
      } catch (e) {
        return { id, name: id, symbol: "?", decimals: 0, balance: null, error: e instanceof Error ? e.message : String(e), custom: true };
      }
    })
  );

  const [builtIn, custom] = await Promise.all([builtInBalances, customBalances]);
  return [...builtIn, ...custom];
}

/** Confirms `canisterId` actually answers like a real ICRC-1 ledger before
 * adding it to the signed-in principal's network-scoped browser watchlist. */
export async function addToken(canisterId: string, network: string): Promise<{ symbol: string; name: string }> {
  const agent = await getAgent(network);
  const owner = await agent.getPrincipal();
  if (owner.isAnonymous()) throw new Error("Sign in before adding a token");
  const id = Principal.fromText(canisterId).toText();
  if (id === ICP_LEDGER_CANISTER_ID || id === CYCLES_LEDGER_CANISTER_ID) {
    throw new Error("This token is already included in the wallet");
  }
  const actor = icrc1Actor(id, agent);
  const [symbol, name] = await Promise.all([actor.icrc1_symbol(), actor.icrc1_name()]);
  const ids = readTrackedTokens(network, owner);
  if (!ids.includes(id)) {
    if (ids.length >= MAX_BROWSER_TRACKED_TOKENS) {
      throw new Error(`The browser watchlist can contain at most ${MAX_BROWSER_TRACKED_TOKENS} custom tokens`);
    }
    writeTrackedTokens(network, owner, [...ids, id]);
  }
  return { symbol, name };
}

export async function removeToken(canisterId: string, network: string): Promise<void> {
  const agent = await getAgent(network);
  const owner = await agent.getPrincipal();
  if (owner.isAnonymous()) throw new Error("Sign in before removing a token");
  const id = Principal.fromText(canisterId).toText();
  const ids = readTrackedTokens(network, owner);
  writeTrackedTokens(network, owner, ids.filter((trackedId) => trackedId !== id));
}

function describeTransferError(err: TransferError): string {
  const [key, value] = Object.entries(err)[0] as [string, unknown];
  if (key === "GenericError") return (value as { message: string }).message;
  if (key === "InsufficientFunds") return `insufficient funds (balance: ${(value as { balance: bigint }).balance})`;
  if (key === "BadFee") return `wrong fee (expected ${(value as { expected_fee: bigint }).expected_fee})`;
  return key;
}

function describeApproveError(err: ApproveError): string {
  const [key, value] = Object.entries(err)[0] as [string, unknown];
  if (key === "GenericError") return (value as { message: string }).message;
  if (key === "InsufficientFunds") return `insufficient funds (balance: ${(value as { balance: bigint }).balance})`;
  if (key === "BadFee") return `wrong fee (expected ${(value as { expected_fee: bigint }).expected_fee})`;
  if (key === "AllowanceChanged") return `allowance changed since you loaded this page (now ${(value as { current_allowance: bigint }).current_allowance})`;
  return key;
}

/** Real `icrc1_transfer`, principal-only (no subaccount support in this
 * UI) - `fee: []` always, so the ledger applies its own current fee rather
 * than this frontend risking a stale cached one. Returns the real block
 * index on success. */
export async function transferToken(canisterId: string, network: string, toPrincipal: string, amount: bigint): Promise<bigint> {
  const agent = await getAgent(network);
  const actor = icrc1Actor(canisterId, agent);
  const result = await actor.icrc1_transfer({
    from_subaccount: [],
    to: { owner: Principal.fromText(toPrincipal), subaccount: [] },
    amount,
    fee: [],
    memo: [],
    created_at_time: [],
  });
  if ("Err" in result) throw new Error(describeTransferError(result.Err));
  return result.Ok;
}

/** Real `icrc2_approve` - grants `spender` an allowance to move up to
 * `amount` of this token on the caller's behalf later (e.g. an orchestrator
 * flow that needs to pull cycles/ICP for something). Not every ICRC-1
 * token implements ICRC-2 - a real rejection from a token that doesn't
 * surfaces as a real error here, not something this function hides. */
export async function approveToken(canisterId: string, network: string, spenderPrincipal: string, amount: bigint): Promise<bigint> {
  const agent = await getAgent(network);
  const actor = icrc1Actor(canisterId, agent);
  const result = await actor.icrc2_approve({
    from_subaccount: [],
    spender: { owner: Principal.fromText(spenderPrincipal), subaccount: [] },
    amount,
    expected_allowance: [],
    expires_at: [],
    fee: [],
    memo: [],
    // Enables ledger duplicate detection if the same approval request has to
    // be retried after an ambiguous network response.
    created_at_time: [BigInt(Date.now()) * 1_000_000n],
  });
  if ("Err" in result) throw new Error(describeApproveError(result.Err));
  return result.Ok;
}

/** The real current transfer fee, for display before sending - best-effort
 * (`icrc1_fee` isn't part of the core ICRC-1 standard, just a real method
 * both built-in ledgers happen to implement - see `Icrc1Service`'s own doc
 * comment), `null` if the token doesn't support it. */
export async function getTokenFee(canisterId: string, network: string): Promise<bigint | null> {
  try {
    const agent = await getAgent(network);
    return await icrc1Actor(canisterId, agent).icrc1_fee();
  } catch {
    return null;
  }
}

/** Formats a raw integer balance using the token's own real decimals - full
 * precision, trailing zeros trimmed (so "1.50000000" reads as "1.5"), the
 * same spirit as a wallet UI showing a clean human amount rather than the
 * raw smallest-unit integer. */
export function formatTokenAmount(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toLocaleString();
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = raw % base;
  if (frac === 0n) return whole.toLocaleString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toLocaleString()}.${fracStr}`;
}

/** Inverse of `formatTokenAmount` - parses a human-typed amount (e.g.
 * "1.5") into the token's raw smallest-unit integer. Throws on anything
 * that isn't a plain non-negative decimal number, or that has more
 * fractional digits than the token actually supports (silently truncating
 * instead would send a different amount than what was typed). */
export function parseTokenAmount(input: string, decimals: number): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`"${input}" isn't a valid amount`);
  const [wholeStr, fracStr = ""] = trimmed.split(".");
  if (fracStr.length > decimals) throw new Error(`this token only supports ${decimals} decimal place${decimals === 1 ? "" : "s"}`);
  const base = 10n ** BigInt(decimals);
  return BigInt(wholeStr) * base + BigInt(fracStr.padEnd(decimals, "0") || "0");
}
