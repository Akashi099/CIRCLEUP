import Link from "next/link";
import { ACTIVE_NETWORK_LABEL } from "@/lib/config";
import { NETWORK_URL_STRATEGY } from "@/lib/networkGuard";
import type { PageNetworkReason } from "@/lib/pageNetwork";

/**
 * NetworkErrorBody — explicit network-identity error for shareable URLs (Issue #861).
 *
 * Rendered by the circle and reputation pages when an explicit `?network=`
 * query parameter is present but either unsupported/blank or disagrees with
 * the deployment's configured network. An address alone never selects a
 * network, so a bare URL never reaches this component — it only appears when a
 * caller supplied an explicit, invalid, or mismatched network value.
 *
 * This is a deterministic (not transient) error, so no retry button is offered:
 * the user must open the correct deployment origin. "Back to circles" gives a
 * way out of the dead-end URL. The deployment's network is always named so the
 * page never silently loads data from the wrong network.
 *
 * Server component — no client interactivity required.
 */

const NETWORK_BACK_LABEL = "Back to circles";

/**
 * Build the human-readable explanation for each failure reason.
 *
 * `requestedRaw` is the untrusted caller-supplied value (undefined for a blank
 * param). It is rendered as plain text by React so it cannot inject markup.
 */
function describeMismatch(
  reason: PageNetworkReason,
  requestedRaw: string | undefined,
): string {
  switch (reason) {
    case "deployment_mismatch":
      return (
        `This link requests the "${requestedRaw ?? ""}" network, but this ` +
        `deployment is configured for ${ACTIVE_NETWORK_LABEL}. A circle address ` +
        `is valid on every network, so opening it here would load data from the ` +
        `wrong indexer and explorer. Open the correct ${requestedRaw ?? ""} ` +
        `deployment to view it there.`
      );
    case "unsupported_value":
      return (
        `"${requestedRaw ?? ""}" is not a supported network. CircleUp recognises ` +
        `only "testnet" and "mainnet". An address alone can never select a network ` +
        `implicitly — either omit the network parameter to use this deployment's ` +
        `network (${ACTIVE_NETWORK_LABEL}) or open the deployment for the network ` +
        `you intended.`
      );
    case "empty":
      return (
        `The network parameter is present but blank. Omit it to use this ` +
        `deployment's network (${ACTIVE_NETWORK_LABEL}), or specify one of the ` +
        `supported networks: testnet, mainnet.`
      );
    default:
      return (
        `This link names an unsupported network. This deployment is ` +
        `${ACTIVE_NETWORK_LABEL}.`
      );
  }
}

/** Heading for each failure reason. */
function headingFor(reason: PageNetworkReason): string {
  switch (reason) {
    case "deployment_mismatch":
      return "Wrong network for this deployment";
    case "unsupported_value":
      return "Unsupported network";
    case "empty":
      return "Invalid network parameter";
    default:
      return "Network mismatch";
  }
}

export default function NetworkErrorBody({
  reason,
  requestedRaw,
}: {
  reason: PageNetworkReason;
  requestedRaw: string | undefined;
}) {
  return (
    <div
      role="alert"
      className="bg-amber-50 border border-amber-300 rounded-xl px-5 py-6 flex items-start gap-3"
    >
      <span className="text-2xl mt-0.5" aria-hidden="true">
        ⚠️
      </span>
      <div>
        <p className="font-semibold text-amber-800">{headingFor(reason)}</p>
        <p className="text-amber-700 text-sm mt-1">{describeMismatch(reason, requestedRaw)}</p>
        <p className="mt-3 text-xs text-amber-700">
          This deployment is <strong>{ACTIVE_NETWORK_LABEL}</strong>. An address
          alone never silently selects mainnet or testnet.
        </p>
        <ul className="mt-3 list-disc list-inside text-xs text-amber-700 space-y-0.5">
          {NETWORK_URL_STRATEGY.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs">
          <Link href="/" className="underline text-amber-800 hover:text-amber-900">
            {NETWORK_BACK_LABEL}
          </Link>
        </p>
      </div>
    </div>
  );
}
