/**
 * Wallet connection over the Wallet Standard, without wallet-adapter or
 * web3.js in the bundle: the standard passes transactions as raw bytes, which
 * is what the API returns. Page and extension can load in either order, so
 * discovery listens for `register-wallet` before announcing `app-ready`.
 */

import { toBase64, utf8 } from "./bytes.ts";
import { sameBytes, splitTransaction } from "./vtx.ts";

const SOLANA_MAINNET = "solana:mainnet";

interface StandardAccount {
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly chains: readonly string[];
  readonly features: readonly string[];
  readonly label?: string;
  readonly icon?: string;
}

interface StandardWallet {
  readonly name: string;
  readonly icon?: string;
  readonly chains: readonly string[];
  readonly accounts: readonly StandardAccount[];
  readonly features: Record<string, unknown>;
}

interface ConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly StandardAccount[] }>;
}
interface DisconnectFeature {
  disconnect(): Promise<void>;
}
interface EventsFeature {
  on(event: "change", listener: (properties: { accounts?: readonly StandardAccount[] }) => void): () => void;
}
interface SignTransactionFeature {
  signTransaction(
    ...inputs: { account: StandardAccount; transaction: Uint8Array; chain?: string }[]
  ): Promise<{ signedTransaction: Uint8Array }[]>;
}
interface SignMessageFeature {
  signMessage(
    ...inputs: { account: StandardAccount; message: Uint8Array }[]
  ): Promise<{ signedMessage: Uint8Array; signature: Uint8Array }[]>;
}

/* ------------------------------------------------------------- discovery */

const found = new Map<string, StandardWallet>();
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

function register(...wallets: StandardWallet[]): () => void {
  let added = false;
  for (const wallet of wallets) {
    // Solana-capable only: the same standard carries Ethereum wallets.
    if (!wallet.chains.some((chain) => chain.startsWith("solana:"))) continue;
    if (found.has(wallet.name)) continue;
    found.set(wallet.name, wallet);
    added = true;
  }
  if (added) announce();
  return () => {};
}

let started = false;

/** Begin discovery. Safe to call repeatedly; only the first call does work. */
export function startDiscovery(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  // Listen before announcing, so a wallet that registers synchronously in
  // response is not missed.
  window.addEventListener("wallet-standard:register-wallet", ((event: CustomEvent) => {
    try {
      event.detail({ register });
    } catch {
      // A malformed wallet must not take the page down.
    }
  }) as EventListener);

  window.dispatchEvent(
    new CustomEvent("wallet-standard:app-ready", { detail: { register } }),
  );
}

export interface WalletInfo {
  readonly name: string;
  readonly icon?: string | undefined;
}

export function availableWallets(): WalletInfo[] {
  startDiscovery();
  return [...found.values()].map((w) => ({ name: w.name, icon: w.icon }));
}

export function onWalletsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * True when a wallet extension is present but does not implement the Wallet
 * Standard. The fix is an update rather than an install, so the UI says so.
 */
export function hasLegacyOnlyWallet(): boolean {
  if (typeof window === "undefined" || found.size > 0) return false;
  const w = window as Record<string, any>;
  return Boolean(w["solana"] ?? w["phantom"]?.["solana"] ?? w["solflare"] ?? w["backpack"]);
}

/* ------------------------------------------------------------- connection */

export class WalletError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "WalletError";
    // Assigned rather than declared: `cause` already exists on Error, and a
    // parameter property here would shadow it.
    if (cause !== undefined) this.cause = cause;
  }
}

/** True when the user dismissed the wallet popup rather than anything failing. */
export function isUserRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: number })?.code;
  return code === 4001 || /reject|denied|cancel|declin|closed/i.test(message);
}

export interface Connection {
  readonly walletName: string;
  readonly address: string;
  /** Sign every transaction in one approval. Returns base64, ready to submit. */
  signAll(transactionsBase64: readonly string[]): Promise<string[]>;
  /** Signs arbitrary bytes, to prove wallet ownership to the API. */
  signMessage(message: string): Promise<Uint8Array>;
  disconnect(): Promise<void>;
  /** Fires when the wallet switches account or locks. */
  onChange(listener: (address: string | null) => void): () => void;
}

function feature<T>(wallet: StandardWallet, name: string): T | null {
  return (wallet.features[name] as T | undefined) ?? null;
}

/** Prefer mainnet; fall back to whatever Solana chain the account offers. */
function chainFor(account: StandardAccount): string {
  return account.chains.includes(SOLANA_MAINNET)
    ? SOLANA_MAINNET
    : (account.chains.find((c) => c.startsWith("solana:")) ?? SOLANA_MAINNET);
}

/**
 * Connects to a named wallet. With `silent`, it reconnects only if this origin
 * is already authorised, so a reload keeps the session without a popup.
 */
export async function connect(
  walletName: string,
  options: { silent?: boolean } = {},
): Promise<Connection> {
  startDiscovery();
  const wallet = found.get(walletName);
  if (!wallet) throw new WalletError(`${walletName} is not available`);

  const connectFeature = feature<ConnectFeature>(wallet, "standard:connect");
  if (!connectFeature) throw new WalletError(`${wallet.name} does not support connecting`);

  let accounts: readonly StandardAccount[];
  try {
    ({ accounts } = await connectFeature.connect(options.silent ? { silent: true } : undefined));
  } catch (error) {
    if (isUserRejection(error)) throw new WalletError("Connection cancelled", error);
    throw new WalletError(`${wallet.name} refused to connect`, error);
  }

  const first = accounts[0];
  if (!first) throw new WalletError(`${wallet.name} returned no account`);
  // A separate binding, because the change listener reassigns it and the
  // narrowing from the check above would not survive that.
  let account: StandardAccount = first;

  const signFeature = feature<SignTransactionFeature>(wallet, "solana:signTransaction");
  const messageFeature = feature<SignMessageFeature>(wallet, "solana:signMessage");
  const disconnectFeature = feature<DisconnectFeature>(wallet, "standard:disconnect");
  const eventsFeature = feature<EventsFeature>(wallet, "standard:events");

  if (!signFeature) {
    throw new WalletError(
      `${wallet.name} cannot sign transactions without also sending them, which this app does not use`,
    );
  }

  const changeListeners = new Set<(address: string | null) => void>();
  if (eventsFeature) {
    eventsFeature.on("change", (properties) => {
      if (!properties.accounts) return;
      const next = properties.accounts[0];
      // An empty accounts array means locked or disconnected, not unchanged.
      account = next ?? account;
      for (const listener of changeListeners) listener(next ? next.address : null);
    });
  }

  return {
    walletName: wallet.name,
    /*
     * A getter, not a snapshot: the change listener above reassigns `account`
     * when the user switches accounts, and signing follows it. A captured address
     * would put the old wallet in the canonical message while the new account
     * signs, which fails as an unhelpful 401.
     */
    get address() {
      return account.address;
    },

    async signAll(transactionsBase64) {
      if (transactionsBase64.length === 0) return [];
      const { fromBase64 } = await import("./bytes.ts");
      const inputs = transactionsBase64.map((base64) => ({
        account,
        transaction: fromBase64(base64),
        chain: chainFor(account),
      }));

      let signed: { signedTransaction: Uint8Array }[];
      try {
        // One call, one approval prompt. Signing in a loop would ask the
        // user six times for one basket.
        signed = await signFeature.signTransaction(...inputs);
      } catch (error) {
        if (isUserRejection(error)) throw new WalletError("Signing cancelled", error);
        throw new WalletError(`${wallet.name} could not sign: ${(error as Error).message}`, error);
      }

      if (signed.length !== transactionsBase64.length) {
        throw new WalletError(
          `${wallet.name} returned ${signed.length} signed transactions for ${transactionsBase64.length} sent`,
        );
      }

      /*
       * Verify the wallet returned the transaction it was given. Only the
       * signature section may differ; every byte of the message is compared, so a
       * wallet or extension that swaps in a different transaction is caught before
       * anything is submitted.
       */
      return signed.map((result, i) => {
        const sent = splitTransaction(fromBase64(transactionsBase64[i]!));
        const back = splitTransaction(result.signedTransaction);

        if (!sameBytes(sent.message, back.message)) {
          throw new WalletError(
            `${wallet.name} returned a different transaction than it was asked to sign. ` +
              "Nothing has been submitted. Do not retry until you trust this wallet.",
          );
        }
        if (back.signatureCount === 0 || back.signatures.every((byte) => byte === 0)) {
          throw new WalletError(`${wallet.name} returned transaction ${i + 1} unsigned`);
        }
        return toBase64(result.signedTransaction);
      });
    },

    async signMessage(message) {
      if (!messageFeature) {
        throw new WalletError(`${wallet.name} cannot sign messages, so it cannot publish a basket`);
      }
      try {
        const [result] = await messageFeature.signMessage({ account, message: utf8(message) });
        if (!result) throw new WalletError("wallet returned no signature");
        return result.signature;
      } catch (error) {
        if (error instanceof WalletError) throw error;
        if (isUserRejection(error)) throw new WalletError("Signing cancelled", error);
        throw new WalletError(`${wallet.name} could not sign the message`, error);
      }
    },

    async disconnect() {
      changeListeners.clear();
      // Not every wallet implements it, and a wallet that does not is still
      // disconnected as far as this app is concerned.
      await disconnectFeature?.disconnect().catch(() => {});
    },

    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
  };
}
