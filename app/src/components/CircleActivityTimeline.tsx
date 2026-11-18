"use client";

/**
 * CircleActivityTimeline
 *
 * Fetches the chronological event feed for a circle from the indexer's
 * GET /circles/:address/activity endpoint and renders it using the existing
 * CircleTimeline component.  Unlike the inline timeline in CircleDetailClient
 * (which synthesises events from round data with no ledger information), this
 * component retrieves events that carry real ledger numbers and event_position
 * values, enabling deterministic ordering and "Indexed · ledger N" labels.
 *
 * Usage:
 *   <CircleActivityTimeline circleAddress="CAAAA…" />
 *
 * Design constraints:
 *   - Treats indexed data as a delayed read model; clearly labels all data as
 *     "Indexed data" with a freshness timestamp.
 *   - Differentiates "no events yet" from "indexer unavailable" from "circle
 *     not found" — each state has a distinct message.
 *   - Unknown event types do not crash the page; they render as category
 *     "unknown" via the normaliser in activityTimeline.ts.
 *   - Bounded and paginated: each page loads at most 50 events (configurable
 *     via the `pageSize` prop).
 *   - The initial load is triggered on mount; subsequent pages are loaded on
 *     demand via Next / Previous buttons.
 *   - An AbortController cancels in-flight requests on unmount or address change
 *     so stale data never overwrites a fresh result.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { CircleTimeline } from "./CircleTimeline";
import {
  fetchCircleActivity,
  type ActivityFetchErrorReason,
  type RawActivityEventWire,
} from "@/lib/circleActivity";

// ─── Error messages ────────────────────────────────────────────────────────────

const ERROR_MESSAGES: Record<ActivityFetchErrorReason, string> = {
  invalid_address:  "The circle address is invalid.",
  not_found:        "This circle has not been indexed yet. It may appear after the next indexer cycle.",
  network:          "Could not reach the indexer. Check your connection and try again.",
  server:           "The indexer returned an error. Try again in a moment.",
  indexer_outage:   "The indexer is temporarily unavailable. Activity data may be delayed.",
  parse:            "The indexer returned an unexpected response format.",
  misconfigured:    "The indexer URL is not configured. Contact support.",
};

// ─── Props ────────────────────────────────────────────────────────────────────

export interface CircleActivityTimelineProps {
  /** C-prefixed Soroban contract address of the circle. */
  circleAddress: string;
  /** Maximum events per page. Defaults to 50. */
  pageSize?: number;
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function TimelineSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading activity timeline">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex gap-3 items-start py-3 border-b border-slate-100 last:border-0">
          <span className="mt-1.5 w-2.5 h-2.5 rounded-full bg-slate-200 shrink-0 animate-pulse" aria-hidden="true" />
          <div className="flex-1 space-y-1.5">
            <div className="h-4 w-32 bg-slate-200 rounded animate-pulse" />
            <div className="h-3 w-24 bg-slate-100 rounded animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Error banner ─────────────────────────────────────────────────────────────

function TimelineError({
  reason,
  onRetry,
}: {
  reason: ActivityFetchErrorReason;
  onRetry: () => void;
}) {
  const message = ERROR_MESSAGES[reason] ?? "An unexpected error occurred.";
  return (
    <div
      role="alert"
      className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700 flex items-start gap-2"
    >
      <span aria-hidden="true">⚠</span>
      <div>
        <p>{message}</p>
        <button
          onClick={onRetry}
          className="mt-1.5 text-xs underline font-medium hover:text-red-900"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Wallet-agnostic, fetch-driven activity timeline for a circle.
 *
 * Fetches real event data with ledger numbers from the indexer, enabling
 * the timeline to display deterministic ordering and accurate "ledger N"
 * labels — unlike the synthesised event approach in CircleDetailClient which
 * derives events from round data and always has null ledger values.
 */
export function CircleActivityTimeline({
  circleAddress,
  pageSize = 50,
}: CircleActivityTimelineProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ActivityFetchErrorReason | null>(null);
  const [events, setEvents] = useState<RawActivityEventWire[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const abortRef = useRef<AbortController | null>(null);

  const loadPage = useCallback(
    async (page: number) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setIsLoading(true);
      setError(null);

      const result = await fetchCircleActivity(circleAddress, {
        page,
        limit: pageSize,
        signal: ctrl.signal,
      });

      if (ctrl.signal.aborted) return;

      setIsLoading(false);

      if (result.ok) {
        setEvents(result.data.events);
        setFetchedAt(result.data.fetchedAt);
        setCurrentPage(result.data.page);
        setTotalPages(result.data.totalPages);
      } else {
        setError(result.reason);
      }
    },
    [circleAddress, pageSize],
  );

  // Load page 1 on mount and whenever address changes
  useEffect(() => {
    setEvents([]);
    setFetchedAt(null);
    setCurrentPage(1);
    setTotalPages(1);
    loadPage(1);
    return () => { abortRef.current?.abort(); };
  }, [loadPage]);

  // ── Render ──────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <section aria-label="Circle activity timeline">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-slate-800">Activity Timeline</h2>
          <span className="text-xs text-slate-400">Indexed data</span>
        </div>
        <TimelineSkeleton />
      </section>
    );
  }

  if (error) {
    return (
      <section aria-label="Circle activity timeline">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-slate-800">Activity Timeline</h2>
        </div>
        <TimelineError reason={error} onRetry={() => loadPage(currentPage)} />
      </section>
    );
  }

  return (
    <div>
      {/* CircleTimeline handles internal pagination over the fetched events */}
      <CircleTimeline rawEvents={events} fetchedAt={fetchedAt} />

      {/* Inter-page navigation (loads a different page from the server) */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-slate-500 mt-2 pt-2 border-t border-slate-100">
          <span>
            Page {currentPage} of {totalPages}
          </span>
          <div className="flex gap-2">
            {currentPage > 1 && (
              <button
                onClick={() => loadPage(currentPage - 1)}
                disabled={isLoading}
                className="px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-50 transition-colors"
              >
                Older
              </button>
            )}
            {currentPage < totalPages && (
              <button
                onClick={() => loadPage(currentPage + 1)}
                disabled={isLoading}
                className="px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-50 transition-colors"
              >
                Newer
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
