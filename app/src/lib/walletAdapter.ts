/**
 * Wallet provider adapter boundary (issue #904).
 *
 * Every Freighter-specific call the transaction path needs — address lookup,
 * network discovery, signing and capability reporting — sits behind the
 * {@link WalletAdapter} interface, so `stellar.ts` prepares, simulates,
 * submits and polls without knowing which extension signs.
 *
 * The interface mirrors `WalletAdapter` in `@circleup/sdk`
 * (sdk/src/walletAdapter.ts). The app does not take a runtime dependency on
 * the SDK package (see lib/gating.ts), so the shape is re-declared here; keep
 * the two in sync. Because the shapes match structurally, this adapter can be
 * passed straight to the SDK's `signWithWalletAdapter`.
 *
 * Inventory of Freighter calls and where they live:
 *
 * | Call                          | Owner                     | Why |
 * |-------------------------------|---------------------------|-----|
 * | requestAccess (connect)       | app — stellar.ts          | UI-initiated permission prompt; not part of signing. |
 * | isConnected / getPublicKey    | adapter.getAddress        | Account lookup before and after signing. |
 * | getNetworkDetails / getNetwork| adapter.getNetwork        | Network discovery (walletCapabilities.getProviderNetwork). |
 * | signTransaction               | adapter.signTransaction   | The only key operation. |
 * | accountChanged/networkChanged | adapter.watchChanges      | Identity invalidation (walletIdentity.ts). |
 * | capability probing            | adapter.capabilities      | walletCapabilities.detectWalletCapabilities. |
 *
 * No wallet dependency is added: the Freighter adapter wraps the existing
 * `@stellar/freighter-api` calls unchanged, and every method is SSR-safe.
 */
import {
  isConnected,
  getPublicKey,
  signTransaction as freighterSignTransaction,
} from "@stellar/freighter-api";
import { detectWalletCapabilities, getProviderNetwork } from "./walletCapabilities";
import { observeWalletChanges } from "./walletIdentity";

// ─── Interface (mirrors @circleup/sdk WalletAdapter) ─────────────────────────

export type WalletCapability = "getAddress" | "getNetwork" | "signTransaction" | "watchChanges";

export interface WalletCapabilityReport {
  readonly available: boolean;
  readonly supports: Readonly<Record<WalletCapability, boolean>>;
}

export type WalletFailureReason =
  | "not_available"
  | "unsupported_capability"
  | "user_rejected"
  | "not_connected"
  | "account_mismatch"
  | "network_mismatch"
  | "provider_error";

export interface WalletFailure {
  readonly ok: false;
  readonly reason: WalletFailureReason;
  readonly message: string;
  readonly capability?: WalletCapability;
}

export type WalletResult<T> = { readonly ok: true; readonly value: T } | WalletFailure;

export interface WalletSignOptions {
  readonly networkPassphrase: string;
  readonly accountToSign: string;
}

export interface WalletAdapter {
  readonly id: string;
  capabilities(): WalletCapabilityReport;
  getAddress(): Promise<WalletResult<string>>;
  getNetwork(): Promise<WalletResult<string>>;
  signTransaction(xdr: string, options: WalletSignOptions): Promise<WalletResult<string>>;
  watchChanges?(onChange: () => void): () => void;
}

// ─── Freighter adapter ───────────────────────────────────────────────────────

/** Matches Freighter's user-rejection messages (same rule the app always used). */
export function isUserRejection(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("denied") ||
    lower.includes("rejected") ||
    lower.includes("cancelled") ||
    lower.includes("canceled")
  );
}

/** Message used when Freighter resolves without a signed envelope. */
export const NO_SIGNATURE_MESSAGE = "Freighter did not return a signed transaction.";

/**
 * The current Freighter integration as a {@link WalletAdapter}.
 *
 * Behaviour is identical to the pre-adapter code path: signing calls
 * `@stellar/freighter-api`'s `signTransaction(xdr, { networkPassphrase,
 * accountToSign })` once, and capability reporting uses
 * `detectWalletCapabilities` on the injected provider.
 */
export const freighterAdapter: WalletAdapter = {
  id: "freighter",

  capabilities(): WalletCapabilityReport {
    const caps = detectWalletCapabilities();
    return {
      available: caps.installed,
      supports: {
        getAddress: caps.installed && caps.canConnect,
        getNetwork: caps.installed && caps.canGetNetwork,
        signTransaction: caps.installed && caps.canSignTransaction,
        watchChanges: caps.installed && caps.canWatchChanges,
      },
    };
  },

  async getAddress(): Promise<WalletResult<string>> {
    try {
      if (!(await isConnected())) {
        return { ok: false, reason: "not_connected", message: "Connect your wallet to continue." };
      }
      const pk = await getPublicKey();
      return pk
        ? { ok: true, value: pk }
        : { ok: false, reason: "not_connected", message: "Connect your wallet to continue." };
    } catch (err) {
      return { ok: false, reason: "provider_error", message: messageOf(err) || "Wallet lookup failed." };
    }
  },

  async getNetwork(): Promise<WalletResult<string>> {
    const passphrase = await getProviderNetwork();
    return passphrase
      ? { ok: true, value: passphrase }
      : {
          ok: false,
          reason: "unsupported_capability",
          capability: "getNetwork",
          message: "Your wallet cannot report the active network.",
        };
  },

  async signTransaction(xdr, options): Promise<WalletResult<string>> {
    let signed: string;
    try {
      signed = await freighterSignTransaction(xdr, {
        networkPassphrase: options.networkPassphrase,
        accountToSign: options.accountToSign,
      });
    } catch (err) {
      const message = messageOf(err);
      return isUserRejection(message)
        ? { ok: false, reason: "user_rejected", message }
        : { ok: false, reason: "provider_error", message };
    }
    if (!signed) return { ok: false, reason: "provider_error", message: NO_SIGNATURE_MESSAGE };
    return { ok: true, value: signed };
  },

  watchChanges(onChange: () => void): () => void {
    return observeWalletChanges(onChange);
  },
};

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return "";
}
