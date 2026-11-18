/**
 * Circle activity feed data layer.
 *
 * Fetches the chronological event sequence for a circle from the indexer's
 * GET /circles/:address/activity endpoint.  Every entry carries a real ledger
 * number and event_position from the relational tables, so the app-layer
 * CircleTimeline component can display "Indexed · ledger N" and sort
 * deterministically instead of relying on synthesised events derived from
 * round data.
 *
 * Design constraints:
 *   - No XDR: the endpoint returns projected relational rows only.
 *   - Bounded: results are paginated; the caller passes `page` and receives
 *     a `hasMore` flag to decide whether to load more.
 *   - Unknown event types are tolerated: the normaliser in activityTimeline.ts
 *     maps them to category:"unknown" rather than throwing.
 *   - Freshness: `fetchedAt` is set to Date.now() after the fetch completes
 *     and is passed to the UI for the "Indexed · fetched HH:MM:SS" label.
 */

import { indexerEndpoint, INDEXER_TIMEOUT_MS } from "./config";
import { isSorobanContractId } from "./address";

// ─── Error reasons ────────────────────────────────────────────────────────────

export type ActivityFetchErrorReason =
  | "invalid_address"   // address failed validation before the fetch
  | "not_found"         // indexer returned 404
  | "network"           // fetch threw (offline / DNS / timeout)
  | "server"            // indexer returned a non-2xx, non-404 response
  | "indexer_outage"    // indexer returned 503
  | "parse"             // response body was not parseable
  | "misconfigured";    // NEXT_PUBLIC_INDEXER_URL is missing or invalid

// ─── Wire shape ───────────────────────────────────────────────────────────────

/**
 * Raw event entry as returned by GET /circles/:address/activity.
 * Matches the shape accepted by normaliseRawEvent() in activityTimeline.ts.
 */
export interface RawActivityEventWire {
  type: string;
  actor: string | null;
  round: number;
  amount: string | null;
  penalty: string | null;
  tx_hash: string | null;
  ledger: number;
  event_position: number;
  id: string;
  timestamp: string | null;
}

export interface ActivityPage {
  readonly events: RawActivityEventWire[];
  readonly total: number;
  readonly page: number;
  readonly totalPages: number;
  readonly hasMore: boolean;
  /** ISO-8601 timestamp of when this page was fetched. */
  readonly fetchedAt: string;
}

// ─── Result types ─────────────────────────────────────────────────────────────

export type ActivityFetchResult =
  | { readonly ok: true; readonly data: ActivityPage; readonly fetchedAtMs: number }
  | { readonly ok: false; readonly reason: ActivityFetchErrorReason };

// ─── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Fetch a page of activity events for a circle.
 *
 * The indexer endpoint is:
 *   GET /circles/:address/activity?page=N&limit=M
 *
 * Returns the raw wire events suitable for passing directly to
 * buildTimelinePage() / CircleTimeline as rawEvents.
 */
export async function fetchCircleActivity(
  circleAddress: string,
  options: {
    page?: number;
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ActivityFetchResult> {
  if (!isSorobanContractId(circleAddress)) {
    return { ok: false, reason: "invalid_address" };
  }

  const { page = 1, limit = 50, signal } = options;

  const base = indexerEndpoint(["circles", circleAddress, "activity"]);
  if (base === null) {
    return { ok: false, reason: "misconfigured" };
  }

  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (limit !== 50) params.set("limit", String(limit));

  const url = params.toString() ? `${base}?${params.toString()}` : base;

  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      signal: signal ?? AbortSignal.timeout(INDEXER_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "network" };
  }

  if (!res.ok) {
    if (res.status === 404) return { ok: false, reason: "not_found" };
    if (res.status === 503) return { ok: false, reason: "indexer_outage" };
    return { ok: false, reason: "server" };
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return { ok: false, reason: "parse" };
  }

  return parseActivityResponse(raw);
}

// ─── Response parser ──────────────────────────────────────────────────────────

function parseActivityResponse(raw: unknown): ActivityFetchResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "parse" };
  }

  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.events)) {
    return { ok: false, reason: "parse" };
  }

  const pagination =
    typeof obj.pagination === "object" && obj.pagination !== null
      ? (obj.pagination as Record<string, unknown>)
      : {};

  const total      = typeof pagination.total === "number" ? pagination.total : obj.events.length;
  const pageNum    = typeof pagination.page === "number" ? pagination.page : 1;
  const totalPages = typeof pagination.totalPages === "number"
    ? pagination.totalPages
    : Math.max(1, Math.ceil(total / 50));
  const hasMore = typeof pagination.hasMore === "boolean"
    ? pagination.hasMore
    : pageNum < totalPages;

  const events: RawActivityEventWire[] = [];
  for (const item of obj.events) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;

    events.push({
      type:           typeof e.type           === "string" ? e.type : "",
      actor:          typeof e.actor          === "string" ? e.actor : null,
      round:          typeof e.round          === "number" ? e.round : 0,
      amount:         typeof e.amount         === "string" ? e.amount : null,
      penalty:        typeof e.penalty        === "string" ? e.penalty : null,
      tx_hash:        typeof e.tx_hash        === "string" ? e.tx_hash : null,
      ledger:         typeof e.ledger         === "number" ? e.ledger : 0,
      event_position: typeof e.event_position === "number" ? e.event_position : 0,
      id:             typeof e.id             === "string" ? e.id : String(events.length),
      timestamp:      typeof e.timestamp      === "string" ? e.timestamp : null,
    });
  }

  const fetchedAtMs = Date.now();
  return {
    ok: true,
    data: {
      events,
      total,
      page: pageNum,
      totalPages,
      hasMore,
      fetchedAt: new Date(fetchedAtMs).toISOString(),
    },
    fetchedAtMs,
  };
}
