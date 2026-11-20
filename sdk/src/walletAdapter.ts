// --- sdk/src/walletAdapter.ts ------------------------------------------------
//
// Optional wallet-provider boundary for SDK-assisted signing (issue #904).
//
// The SDK prepares Soroban transactions (simulate → assemble); a wallet
// provider (Freighter today) owns the user's key. This module is the typed
// seam between them: an adapter reports what its provider can do, and
// `signWithWalletAdapter` refuses — before any signing prompt — when a
// capability is missing, the active account changed, or the wallet is on
// another network.
//
// Server-safe by construction: this file has no imports, touches no browser
// globals (`window`, injected extensions), and holds no wallet dependency, so
// importing the SDK in Node or during SSR is unaffected. Concrete adapters
// live with the application that owns the provider (the app's Freighter
// adapter is app/src/lib/walletAdapter.ts).
//
// The adapter only signs. Building, simulating, submitting and polling stay
// with the caller, in that order — the adapter never broadcasts.

/** Something a wallet provider may or may not be able to do. */
export type WalletCapability = "getAddress" | "getNetwork" | "signTransaction" | "watchChanges";

/** What a provider supports right now. */
export interface WalletCapabilityReport {
  /** A provider is present in this environment at all. */
  readonly available: boolean;
  /** Per-capability support. Every key is present; `false` means unsupported. */
  readonly supports: Readonly<Record<WalletCapability, boolean>>;
}

/**
 * Why a wallet operation did not produce a value.
 *
 * | Reason                   | Meaning |
 * |--------------------------|---------|
 * | `not_available`          | No provider is present (e.g. extension not installed, or server-side). |
 * | `unsupported_capability` | The provider exists but cannot perform this operation; `capability` names it. |
 * | `user_rejected`          | The user declined the prompt. Nothing was signed. |
 * | `not_connected`          | The provider is present but has not granted access to an account. |
 * | `account_mismatch`       | The provider's active account is not the account the transaction was prepared for. |
 * | `network_mismatch`       | The provider is on a different network passphrase. |
 * | `provider_error`         | The provider failed or returned an unusable value. |
 */
export type WalletFailureReason =
  | "not_available"
  | "unsupported_capability"
  | "user_rejected"
  | "not_connected"
  | "account_mismatch"
  | "network_mismatch"
  | "provider_error";

/** A failed wallet operation. Always explicit — adapters never throw for these cases. */
export interface WalletFailure {
  readonly ok: false;
  readonly reason: WalletFailureReason;
  /** Human-readable, log-safe description. */
  readonly message: string;
  /** Set for `unsupported_capability`. */
  readonly capability?: WalletCapability;
}

/** Result of every {@link WalletAdapter} operation. */
export type WalletResult<T> = { readonly ok: true; readonly value: T } | WalletFailure;

/** Options for {@link WalletAdapter.signTransaction}. */
export interface WalletSignOptions {
  /** Network passphrase the transaction was built for. */
  readonly networkPassphrase: string;
  /** G-address that must sign — the account the transaction was prepared for. */
  readonly accountToSign: string;
}

/**
 * Minimal provider interface. Implement it once per wallet; every method
 * resolves to a {@link WalletResult} rather than throwing, so unsupported
 * capabilities and user rejection are values the caller must handle.
 */
export interface WalletAdapter {
  /** Stable identifier, e.g. `"freighter"`. */
  readonly id: string;
  /** Synchronous capability probe; must not prompt the user. */
  capabilities(): WalletCapabilityReport;
  /** The provider's active account, without prompting. */
  getAddress(): Promise<WalletResult<string>>;
  /** The provider's active network passphrase. */
  getNetwork(): Promise<WalletResult<string>>;
  /** Sign a prepared transaction XDR and return the signed envelope XDR. */
  signTransaction(xdr: string, options: WalletSignOptions): Promise<WalletResult<string>>;
  /**
   * Subscribe to account / network changes. Returns an unsubscribe function.
   * Optional — an adapter without it reports `watchChanges: false`.
   */
  watchChanges?(onChange: () => void): () => void;
}

/** Build a {@link WalletFailure}. */
export function walletFailure(
  reason: WalletFailureReason,
  message: string,
  capability?: WalletCapability,
): WalletFailure {
  return capability === undefined ? { ok: false, reason, message } : { ok: false, reason, message, capability };
}

/**
 * Return a failure when `report` cannot perform `capability`, else `null`.
 * Call it before an operation so a missing capability fails before any prompt.
 */
export function requireWalletCapability(
  report: WalletCapabilityReport,
  capability: WalletCapability,
): WalletFailure | null {
  if (!report.available) {
    return walletFailure("not_available", "No wallet provider is available in this environment.");
  }
  if (!report.supports[capability]) {
    return walletFailure(
      "unsupported_capability",
      `The connected wallet cannot ${CAPABILITY_LABELS[capability]}.`,
      capability,
    );
  }
  return null;
}

const CAPABILITY_LABELS: Record<WalletCapability, string> = {
  getAddress: "report its active account",
  getNetwork: "report its active network",
  signTransaction: "sign transactions",
  watchChanges: "report account or network changes",
};

/** Options for {@link signWithWalletAdapter}. */
export interface SignWithWalletOptions extends WalletSignOptions {
  /**
   * When the provider cannot report its network: `"skip"` (default) signs
   * anyway — the network passphrase is still bound into the signature, so a
   * mismatched wallet produces a transaction the network rejects — while
   * `"require"` fails with `unsupported_capability` before signing.
   */
  readonly networkCheck?: "skip" | "require";
}

/**
 * Sign `xdr` through `adapter` after checking, in order and before any
 * signing prompt:
 *
 *   1. a provider is available and can sign;
 *   2. its active account is `accountToSign` (when it can report one);
 *   3. its network is `networkPassphrase` (when it can report one, or always
 *      with `networkCheck: "require"`).
 *
 * Every refusal is an explicit {@link WalletFailure}; nothing is thrown for
 * provider-level problems. An adapter that itself throws is reported as
 * `provider_error`.
 */
export async function signWithWalletAdapter(
  adapter: WalletAdapter,
  xdr: string,
  options: SignWithWalletOptions,
): Promise<WalletResult<string>> {
  let report: WalletCapabilityReport;
  try {
    report = adapter.capabilities();
  } catch (err) {
    return walletFailure("provider_error", `Wallet capability check failed: ${errorMessage(err)}`);
  }

  const cannotSign = requireWalletCapability(report, "signTransaction");
  if (cannotSign) return cannotSign;

  if (report.supports.getAddress) {
    const address = await guard(() => adapter.getAddress());
    if (!address.ok) return address;
    if (address.value !== options.accountToSign) {
      return walletFailure(
        "account_mismatch",
        "The wallet's active account is not the account this transaction was prepared for. Review the action again.",
      );
    }
  }

  if (report.supports.getNetwork) {
    const network = await guard(() => adapter.getNetwork());
    if (!network.ok) return network;
    if (network.value !== options.networkPassphrase) {
      return walletFailure(
        "network_mismatch",
        "The wallet is connected to a different network than this transaction was built for.",
      );
    }
  } else if (options.networkCheck === "require") {
    const missing = requireWalletCapability(report, "getNetwork");
    if (missing) return missing;
  }

  const signed = await guard(() =>
    adapter.signTransaction(xdr, {
      networkPassphrase: options.networkPassphrase,
      accountToSign: options.accountToSign,
    }),
  );
  if (signed.ok && (typeof signed.value !== "string" || signed.value === "")) {
    return walletFailure("provider_error", "The wallet did not return a signed transaction.");
  }
  return signed;
}

async function guard<T>(op: () => Promise<WalletResult<T>>): Promise<WalletResult<T>> {
  try {
    return await op();
  } catch (err) {
    return walletFailure("provider_error", `Wallet provider error: ${errorMessage(err)}`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
