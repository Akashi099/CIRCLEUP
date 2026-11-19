/**
 * pageNetwork.ts — Page-level network resolution for shareable URLs (Issue #861).
 *
 * CircleUp uses a deployment-origin model: each deployment is locked to one
 * network via build-time env (NEXT_PUBLIC_NETWORK_PASSPHRASE → ACTIVE_NETWORK).
 * A circle or member address is valid on every network, so a bare URL carries
 * no inherent network signal — the deployment origin IS the network selector.
 *
 * Some entry points may accept an explicit `?network=` query parameter to allow
 * cross-network navigation from a single host. When that parameter is present
 * it MUST be validated against a strict allowlist and MUST agree with the
 * deployment's configured network before any data access — an address alone
 * never silently selects mainnet or testnet.
 *
 * This module wraps {@link resolveNetworkForUrl} (from networkGuard.ts) in a
 * non-throwing result so Next.js page components can branch cleanly: render an
 * explicit network error page on a bad/mismatched value, or proceed to data
 * access on a valid (or absent) value. Keeping this logic out of the page
 * component makes it unit-testable in isolation (see pageNetwork.test.ts).
 *
 * Acceptance: a shared circle URL resolves only against a clearly identified
 * supported network, or presents an explicit network choice before loading.
 */

import { resolveNetworkForUrl, NetworkValidationError } from "./networkGuard";
import { ACTIVE_NETWORK } from "./config";

/** Reason codes mirror {@link NetworkValidationError["reason"]}. */
export type PageNetworkReason = "unsupported_value" | "deployment_mismatch" | "empty";

/**
 * Result of resolving the `?network=` query parameter for a page render.
 *
 * - `{ ok: true, network }` — safe to proceed; `network` is the validated
 *   network for this request (the deployment default when the param is absent).
 * - `{ ok: false, reason, rawValue }` — render an explicit network error
 *   page instead of loading data. `rawValue` is the untrusted value the caller
 *   supplied (absent for a blank param).
 */
export type PageNetworkResult =
  | { ok: true; network: string }
  | { ok: false; reason: PageNetworkReason; rawValue: string | undefined };

/**
 * Validate an optional `?network=` query value against the deployment's
 * configured network, returning a non-throwing result.
 *
 * Behaviour:
 *   - Absent (`null`/`undefined`) → `{ ok: true, network: <deployment default> }`.
 *     The deployment origin is the network selector, so a bare URL resolves
 *     against the deployment's network. An address alone never selects a
 *     different network.
 *   - Present and recognised, matching the deployment → `{ ok: true, ... }`.
 *   - Present but not a recognised network → `{ ok: false, reason: "unsupported_value" }`.
 *   - Present but blank after trimming → `{ ok: false, reason: "empty" }`.
 *   - Present, recognised, but disagreeing with the deployment →
 *     `{ ok: false, reason: "deployment_mismatch" }`.
 *
 * `deploymentNetwork` defaults to `ACTIVE_NETWORK` so production callers pass a
 * single argument; tests pass an explicit value to exercise different
 * deployments without depending on the build-time env.
 */
export function resolvePageNetwork(
  rawParam: string | null | undefined,
  deploymentNetwork: string = ACTIVE_NETWORK,
): PageNetworkResult {
  try {
    const network = resolveNetworkForUrl(rawParam, deploymentNetwork);
    return { ok: true, network };
  } catch (err) {
    if (err instanceof NetworkValidationError) {
      return { ok: false, reason: err.reason, rawValue: err.rawValue };
    }
    // Unexpected (non-validation) error — re-throw so real bugs surface.
    throw err;
  }
}
