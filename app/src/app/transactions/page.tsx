"use client";
import { useEffect, useState, useRef, useCallback } from 'react';
import { NETWORK_PASSPHRASE, ACTIVE_NETWORK, ACTIVE_NETWORK_LABEL, getExplorerLink, shortAddress } from '@/lib/config';
import { lookupTransactionStatus } from '@/lib/stellar';
import {
  readReceipts,
  rememberTransaction,
  RECEIPTS_KEY,
  isTransactionHash,
  type RecentTransaction,
  type TransactionStatus,
} from '@/lib/transactionStatus';

// ─── Status display ───────────────────────────────────────────────────────────

interface StatusDisplay {
  label: string;
  description: string;
  badgeClass: string;
  icon: string;
}

const STATUS_DISPLAY: Record<TransactionStatus, StatusDisplay> = {
  success: {
    label: 'Confirmed',
    description: 'Confirmed on-chain.',
    badgeClass: 'bg-green-100 text-green-700 border-green-200',
    icon: '✓',
  },
  failed: {
    label: 'Failed',
    description: 'The chain reported transaction failure.',
    badgeClass: 'bg-red-100 text-red-700 border-red-200',
    icon: '✗',
  },
  pending: {
    label: 'Pending',
    description:
      'Submission was accepted. Confirmation has not been observed yet — the transaction may still confirm.',
    badgeClass: 'bg-amber-100 text-amber-700 border-amber-200',
    icon: '…',
  },
  not_found: {
    label: 'Not found',
    description:
      'Not found in the RPC\'s retained history. This does not establish failure or cancellation — the transaction may have been included in a ledger before the RPC\'s retention window, or it may not have reached the network.',
    badgeClass: 'bg-slate-100 text-slate-500 border-slate-200',
    icon: '—',
  },
  unavailable: {
    label: 'Unavailable',
    description:
      'Status temporarily unavailable. Retry the check — do not resubmit without first confirming the transaction was not already applied.',
    badgeClass: 'bg-slate-100 text-slate-500 border-slate-200',
    icon: '?',
  },
};

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: TransactionStatus }) {
  const d = STATUS_DISPLAY[status];
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${d.badgeClass}`}
      aria-label={`Status: ${d.label}`}
    >
      <span aria-hidden="true">{d.icon}</span>
      {d.label}
    </span>
  );
}

// ─── Status detail panel ──────────────────────────────────────────────────────

interface StatusPanelProps {
  receipt: RecentTransaction;
  status: TransactionStatus | null;
  checking: boolean;
  exhausted: boolean;
  onRetry: () => void;
}

function StatusPanel({ receipt, status, checking, exhausted, onRetry }: StatusPanelProps) {
  const explorerUrl = getExplorerLink(ACTIVE_NETWORK, 'tx', receipt.hash);
  const [copied, setCopied] = useState<'idle' | 'success' | 'error'>('idle');

  async function handleCopy() {
    const payload = JSON.stringify(
      {
        operation: 'transaction_status',
        network: ACTIVE_NETWORK,
        txHash: receipt.hash,
        status: status ?? 'checking',
      },
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(payload);
      setCopied('success');
      setTimeout(() => setCopied('idle'), 2500);
    } catch {
      setCopied('error');
      setTimeout(() => setCopied('idle'), 3000);
    }
  }

  const d = status ? STATUS_DISPLAY[status] : null;

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
      {/* Hash */}
      <div>
        <p className="text-xs text-slate-400 mb-1">Transaction hash</p>
        <p className="font-mono text-xs text-slate-700 break-all">{receipt.hash}</p>
      </div>

      {/* Status */}
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">
          {status ? (
            <StatusBadge status={status} />
          ) : (
            <span
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border bg-slate-100 text-slate-500 border-slate-200"
              role="status"
              aria-label="Checking status"
            >
              <span
                className="inline-block w-3 h-3 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin"
                aria-hidden="true"
              />
              Checking…
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          {d && (
            <p className="text-sm text-slate-700" role="status" aria-live="polite">
              {d.description}
            </p>
          )}
          {!status && (
            <p className="text-sm text-slate-500" role="status" aria-live="polite">
              Checking transaction status…
            </p>
          )}
          {checking && status && (status === 'pending' || status === 'not_found') && (
            <p className="text-xs text-slate-400 mt-1">Checking again…</p>
          )}
          {exhausted && (
            <p className="text-xs text-amber-700 mt-1">
              Observation limit reached. The transaction may still confirm.
              Use the Retry button or check the block explorer.
            </p>
          )}
        </div>
      </div>

      {/* Important safety note for ambiguous statuses */}
      {status && (status === 'pending' || status === 'not_found' || status === 'unavailable') && (
        <div
          role="note"
          className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800"
        >
          <strong>Do not resubmit</strong> until you have confirmed the original
          transaction was not applied. Resubmitting a transaction that was
          already accepted will apply it a second time.
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onRetry}
          disabled={checking}
          className="text-sm px-3 py-1.5 rounded-lg border border-brand-300 bg-brand-50 text-brand-700 hover:bg-brand-100 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
        >
          {checking ? 'Checking…' : 'Retry status check'}
        </button>

        {explorerUrl && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
          >
            View in explorer ↗
          </a>
        )}

        <button
          type="button"
          onClick={handleCopy}
          className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
          aria-label={
            copied === 'success'
              ? 'Support summary copied'
              : copied === 'error'
              ? 'Copy failed'
              : 'Copy support summary to clipboard'
          }
        >
          {copied === 'success' ? 'Copied!' : copied === 'error' ? 'Copy failed' : 'Copy support summary'}
        </button>
      </div>
    </div>
  );
}

// ─── Receipt list row ─────────────────────────────────────────────────────────

interface ReceiptRowProps {
  receipt: RecentTransaction;
  selected: boolean;
  onSelect: () => void;
  wrongNetwork: boolean;
}

function ReceiptRow({ receipt, selected, onSelect, wrongNetwork }: ReceiptRowProps) {
  return (
    <li>
      <button
        type="button"
        disabled={wrongNetwork}
        onClick={onSelect}
        className={`w-full text-left px-3 py-2.5 rounded-lg border text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${
          selected
            ? 'border-brand-400 bg-brand-50 text-brand-700'
            : wrongNetwork
            ? 'border-slate-100 bg-slate-50 text-slate-400 cursor-not-allowed'
            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-300'
        }`}
        aria-pressed={selected}
        title={wrongNetwork ? 'Switch the app to this receipt\'s network to check its status' : undefined}
      >
        <span className="font-mono text-xs block truncate">{receipt.hash}</span>
        {wrongNetwork && (
          <span className="text-xs text-slate-400 mt-0.5 block">
            Different network — not checkable here
          </span>
        )}
        {receipt.accepted && !wrongNetwork && (
          <span className="text-xs text-slate-400 mt-0.5 block">
            Submission accepted
          </span>
        )}
      </button>
    </li>
  );
}

// ─── Manual hash form ─────────────────────────────────────────────────────────

interface ManualFormProps {
  onSubmit: (hash: string) => void;
}

function ManualForm({ onSubmit }: ManualFormProps) {
  const [hash, setHash] = useState('');
  const valid = isTransactionHash(hash);

  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        if (valid) onSubmit(hash.trim().toLowerCase());
      }}
      className="space-y-2"
    >
      <label
        htmlFor="tx-hash-input"
        className="block text-sm font-medium text-slate-700"
      >
        Check a transaction by hash
      </label>
      <p className="text-xs text-slate-500">
        Enter a 64-character hex transaction hash from the active network ({ACTIVE_NETWORK_LABEL}).
      </p>
      <div className="flex gap-2">
        <input
          id="tx-hash-input"
          type="text"
          value={hash}
          onChange={e => setHash(e.target.value.trim())}
          maxLength={64}
          placeholder="a1b2c3d4… (64 hex characters)"
          className="flex-1 min-w-0 font-mono text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-400"
          aria-describedby="tx-hash-help"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="submit"
          disabled={!valid}
          className="shrink-0 text-sm px-3 py-2 rounded-lg border border-brand-300 bg-brand-50 text-brand-700 hover:bg-brand-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
        >
          Check status
        </button>
      </div>
      <p id="tx-hash-help" className="text-xs text-slate-400">
        Status checks are read-only and never sign or submit transactions.
      </p>
    </form>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TransactionsPage() {
  const [receipts, setReceipts] = useState<RecentTransaction[]>([]);
  const [selected, setSelected] = useState<RecentTransaction | null>(null);
  const [status, setStatus] = useState<TransactionStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  // Increments to restart polling for the same receipt after a manual retry.
  const [retryKey, setRetryKey] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  // Keep receipts list fresh across tabs and storage updates.
  useEffect(() => {
    const load = () => setReceipts(readReceipts());
    load();
    window.addEventListener('circleup:receipts', load);
    window.addEventListener('storage', load);
    return () => {
      window.removeEventListener('circleup:receipts', load);
      window.removeEventListener('storage', load);
    };
  }, []);

  // Poll whenever selected or retryKey changes.
  useEffect(() => {
    if (!selected || selected.network !== NETWORK_PASSPHRASE) return;

    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    setStatus(null);
    setChecking(true);
    setExhausted(false);

    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll(count: number): Promise<void> {
      const next = await lookupTransactionStatus(
        selected!.hash,
        selected!.accepted,
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      setStatus(next);

      // Keep polling while pending/not_found up to 9 more checks (10 total).
      if ((next === 'pending' || next === 'not_found') && count < 9) {
        timer = setTimeout(() => { void poll(count + 1); }, 2000);
      } else {
        setChecking(false);
        setExhausted(count === 9 && (next === 'pending' || next === 'not_found'));
      }
    }

    void poll(0);

    return () => {
      ctrl.abort();
      clearTimeout(timer);
      setChecking(false);
    };
  }, [selected, retryKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Abort on unmount.
  useEffect(() => {
    return () => { ctrlRef.current?.abort(); };
  }, []);

  function selectReceipt(receipt: RecentTransaction) {
    setSelected(receipt);
    setRetryKey(0);
  }

  function handleManualHash(hash: string) {
    const receipt: RecentTransaction = {
      network: NETWORK_PASSPHRASE,
      hash,
      accepted: false,
    };
    setSelected(receipt);
    setRetryKey(0);
  }

  function handleRetry() {
    setRetryKey(k => k + 1);
  }

  function handleClearAll() {
    try {
      localStorage.removeItem(RECEIPTS_KEY);
    } catch {
      // Storage may be unavailable; treat as cleared.
    }
    setReceipts([]);
    setSelected(null);
    setStatus(null);
  }

  const savedReceipts = receipts.filter(r => r.network === NETWORK_PASSPHRASE);
  const otherNetworkReceipts = receipts.filter(r => r.network !== NETWORK_PASSPHRASE);

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Recent transactions</h1>
        <p className="text-sm text-slate-500 mt-1">
          Active network: <span className="font-medium text-slate-700">{ACTIVE_NETWORK_LABEL}</span>.
          Only public transaction hashes are saved locally (up to 20 receipts).
          Status checks are read-only and never sign or submit transactions.
        </p>
      </div>

      {/* Saved receipts for the active network */}
      {savedReceipts.length > 0 && (
        <section aria-labelledby="saved-heading">
          <div className="flex items-center justify-between mb-2">
            <h2 id="saved-heading" className="text-sm font-semibold text-slate-700">
              Saved receipts — {ACTIVE_NETWORK_LABEL}
            </h2>
            <button
              type="button"
              onClick={handleClearAll}
              className="text-xs text-slate-400 hover:text-slate-700 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1"
            >
              Clear all
            </button>
          </div>
          <ul className="space-y-1.5" role="list" aria-label="Saved transaction receipts">
            {savedReceipts.map(r => (
              <ReceiptRow
                key={r.hash}
                receipt={r}
                selected={selected?.hash === r.hash && selected.network === r.network}
                onSelect={() => selectReceipt(r)}
                wrongNetwork={false}
              />
            ))}
          </ul>
        </section>
      )}

      {/* Receipts from other networks */}
      {otherNetworkReceipts.length > 0 && (
        <section aria-labelledby="other-network-heading">
          <h2
            id="other-network-heading"
            className="text-sm font-semibold text-slate-500 mb-2"
          >
            Other networks
          </h2>
          <ul className="space-y-1.5" role="list" aria-label="Receipts from other networks">
            {otherNetworkReceipts.map(r => (
              <ReceiptRow
                key={r.hash}
                receipt={r}
                selected={false}
                onSelect={() => {}}
                wrongNetwork={true}
              />
            ))}
          </ul>
        </section>
      )}

      {/* Status panel */}
      {selected && selected.network === NETWORK_PASSPHRASE && (
        <section aria-labelledby="status-heading">
          <h2 id="status-heading" className="text-sm font-semibold text-slate-700 mb-2">
            Status check
          </h2>
          <StatusPanel
            receipt={selected}
            status={status}
            checking={checking}
            exhausted={exhausted}
            onRetry={handleRetry}
          />
        </section>
      )}

      {/* Manual hash lookup */}
      <section
        aria-labelledby="manual-heading"
        className="bg-white border border-slate-200 rounded-xl p-5"
      >
        <h2 id="manual-heading" className="text-sm font-semibold text-slate-700 mb-3">
          Look up a transaction
        </h2>
        <ManualForm onSubmit={handleManualHash} />
      </section>

      {/* Empty state */}
      {receipts.length === 0 && (
        <p className="text-sm text-slate-500 text-center py-4">
          No receipts saved yet. Receipts appear here after you submit a transaction.
        </p>
      )}
    </div>
  );
}
