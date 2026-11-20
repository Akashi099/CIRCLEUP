"use client";
import { useState } from 'react';
import { verifyConfiguredDeployment } from '@/lib/stellar';
import { useDeploymentVerified, type DeploymentFact } from '@/lib/deploymentState';

// ─── Status display ───────────────────────────────────────────────────────────

const STATUS_BADGE: Record<DeploymentFact['status'], string> = {
  verified:      'bg-green-100 text-green-700 border-green-200',
  mismatch:      'bg-red-100 text-red-700 border-red-200',
  unverifiable:  'bg-slate-100 text-slate-500 border-slate-200',
};

const STATUS_ICON: Record<DeploymentFact['status'], string> = {
  verified:     '✓',
  mismatch:     '✗',
  unverifiable: '—',
};

const STATUS_LABEL: Record<DeploymentFact['status'], string> = {
  verified:     'Verified',
  mismatch:     'Mismatch',
  unverifiable: 'Unverifiable',
};

/**
 * What each check name means and what its limits are.
 * Shown in a tooltip/title so operators understand what the evidence covers.
 */
const CHECK_DESCRIPTIONS: Record<string, string> = {
  'RPC network':           'Compares the RPC node\'s reported network passphrase with the app\'s configured passphrase.',
  'Factory token link':    'Calls get_usdc_token() on the factory and checks it matches the configured USDC address.',
  'Factory reputation link': 'Calls get_reputation_contract() on the factory and checks it matches the configured reputation address.',
  'Reputation interface':  'Calls get_admin() on the reputation contract and confirms it returns a valid Stellar address.',
  'Token decimals':        'Calls decimals() on the USDC contract and confirms the value equals 7.',
};

// ─── Limits disclaimer ────────────────────────────────────────────────────────

const LIMITS_NOTE =
  'These checks compare the RPC network and factory getter values with ' +
  'the app\'s configuration. They do not prove code provenance, token ' +
  'issuer identity, or release authenticity. A "verified" result means ' +
  'the contracts answered as expected — not that they are the correct ' +
  'contracts by any cryptographic measure. Operators can compare the ' +
  'circle WASM hash with a release manifest using the SDK\'s ' +
  'verifyDeployment option.';

// ─── Single check row ─────────────────────────────────────────────────────────

function CheckRow({ fact }: { fact: DeploymentFact }) {
  const badgeClass = STATUS_BADGE[fact.status];
  const icon = STATUS_ICON[fact.status];
  const label = STATUS_LABEL[fact.status];
  const description = CHECK_DESCRIPTIONS[fact.name] ?? '';

  return (
    <li className="flex items-center justify-between gap-3 py-2 border-b border-slate-100 last:border-0">
      <span
        className="text-sm text-slate-700"
        title={description || undefined}
      >
        {fact.name}
      </span>
      <span
        className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${badgeClass} shrink-0`}
        aria-label={`${fact.name}: ${label}`}
      >
        <span aria-hidden="true">{icon}</span>
        {label}
      </span>
    </li>
  );
}

// ─── Aggregate summary ────────────────────────────────────────────────────────

function Summary({ facts, verified }: { facts: DeploymentFact[]; verified: boolean }) {
  if (facts.length === 0) return null;

  const mismatches = facts.filter(f => f.status === 'mismatch');
  const unverifiable = facts.filter(f => f.status === 'unverifiable');

  if (verified) {
    return (
      <p className="text-sm text-green-700 font-medium" role="status">
        ✓ All checks passed. Writes enabled for five minutes.
      </p>
    );
  }

  if (mismatches.length > 0) {
    return (
      <p className="text-sm text-red-700 font-medium" role="alert" aria-live="assertive">
        ✗ {mismatches.length} check{mismatches.length !== 1 ? 's' : ''} reported a
        mismatch. Correct the configuration before enabling writes.
      </p>
    );
  }

  if (unverifiable.length === facts.length) {
    return (
      <p className="text-sm text-slate-600" role="status">
        Checks could not be completed — the RPC may be unreachable or the
        contracts are not yet deployed. Browsing remains available.
      </p>
    );
  }

  return (
    <p className="text-sm text-amber-700" role="status">
      Some checks are unverifiable (RPC outage or missing contract code).
      Writes remain disabled until all checks pass.
    </p>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Deployment verification panel.
 *
 * Runs read-only RPC calls against the configured factory, reputation, and
 * USDC contracts. Each check reports "verified", "mismatch", or "unverifiable"
 * independently.
 *
 * The panel is advisory — a "verified" result means the contracts answered as
 * configured, not that they are cryptographically authenticated. It never
 * blocks read-only browsing.
 */
export function DeploymentCheck() {
  const [facts, setFacts] = useState<DeploymentFact[]>([]);
  const [busy, setBusy] = useState(false);
  const [runCount, setRunCount] = useState(0);
  const verified = useDeploymentVerified();

  async function handleVerify() {
    setBusy(true);
    try {
      const result = await verifyConfiguredDeployment();
      setFacts(result);
      setRunCount(c => c + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      className="max-w-5xl mx-auto px-4 pt-4 space-y-3"
      aria-label="Deployment verification"
    >
      {/* Header row */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">
            Deployment verification
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {verified
              ? 'Passed — valid for five minutes. Writes are enabled.'
              : facts.length === 0
              ? 'Not yet run. Run checks before enabling writes. Browsing is always available.'
              : 'Verification required before writes. Browsing remains available.'}
          </p>
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={handleVerify}
          aria-busy={busy}
          className={`shrink-0 text-sm px-3 py-1.5 rounded-lg border font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-50 ${
            verified
              ? 'border-green-300 bg-green-50 text-green-700 hover:bg-green-100'
              : 'border-brand-300 bg-brand-50 text-brand-700 hover:bg-brand-100'
          }`}
        >
          {busy ? (
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"
                aria-hidden="true"
              />
              Checking…
            </span>
          ) : (
            verified ? 'Re-verify' : 'Verify deployment'
          )}
        </button>
      </div>

      {/* Results list */}
      {facts.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-2">
          {/* Accessible live region for screen readers */}
          <span
            key={runCount}
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {verified
              ? 'Deployment verification passed. All checks verified.'
              : `Deployment verification complete. ${facts.filter(f => f.status === 'mismatch').length} mismatches, ${facts.filter(f => f.status === 'unverifiable').length} unverifiable.`}
          </span>

          <ul
            aria-label="Verification check results"
            className="divide-y divide-slate-100"
          >
            {facts.map(fact => (
              <CheckRow key={fact.name} fact={fact} />
            ))}
          </ul>

          <div className="pt-2 pb-1">
            <Summary facts={facts} verified={verified} />
          </div>
        </div>
      )}

      {/* Limits disclaimer */}
      <p className="text-xs text-slate-400 leading-relaxed" role="note">
        {LIMITS_NOTE}
      </p>
    </aside>
  );
}
