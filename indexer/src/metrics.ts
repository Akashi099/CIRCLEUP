/**
 * Bounded-cardinality indexer pipeline metrics for operational monitoring (#933).
 *
 * Privacy-preserving design invariants:
 *  1. Bounded cardinality: Every label value belongs to a small, finite enum.
 *     NO member addresses, contract IDs, transaction hashes, or raw error messages
 *     are ever recorded as metric labels.
 *  2. Stable metric names and units: Counter and gauge names follow Prometheus
 *     naming conventions (*_total for counters, *_ms for millisecond timings).
 *  3. Separation of concerns: Metrics are strictly operational time-series measures
 *     and are independent from /health liveness and readiness probes.
 */

import { getPoolStats } from "./db/pool";

export type EventCategory = "circle" | "factory" | "reputation" | "unknown";
export type EventOutcome = "processed" | "skipped" | "failed" | "retried";
export type PollOutcome = "success" | "failure";
export type RouteClass = "list" | "detail" | "history" | "health" | "metrics" | "other";
export type HttpStatusClass = "2xx" | "3xx" | "4xx" | "5xx";
export type PoolConnectionState = "active" | "idle" | "waiting";

// ── In-Memory Metrics State ───────────────────────────────────────────────────

interface MetricsStore {
  // Poll metrics
  pollCycles: Record<PollOutcome, number>;
  lastPollDurationMs: number;
  lastPollRpcLatencyMs: number;
  ledgerLag: number;
  lastIndexedLedger: number;
  chainHeadLedger: number;

  // Event metrics
  events: Record<EventCategory, Record<EventOutcome, number>>;
  decodeFailures: Record<EventCategory, number>;

  // DB metrics
  lastDbCommitDurationMs: number;
  poolSaturationCount: number;

  // HTTP API metrics
  httpRequests: Record<RouteClass, Record<HttpStatusClass, number>>;
  lastHttpRequestDurationMs: Record<RouteClass, number>;
}

const VALID_CATEGORIES: ReadonlySet<EventCategory> = new Set([
  "circle",
  "factory",
  "reputation",
  "unknown",
]);

const VALID_EVENT_OUTCOMES: ReadonlySet<EventOutcome> = new Set([
  "processed",
  "skipped",
  "failed",
  "retried",
]);

const VALID_POLL_OUTCOMES: ReadonlySet<PollOutcome> = new Set(["success", "failure"]);

const VALID_ROUTE_CLASSES: ReadonlySet<RouteClass> = new Set([
  "list",
  "detail",
  "history",
  "health",
  "metrics",
  "other",
]);

const VALID_STATUS_CLASSES: ReadonlySet<HttpStatusClass> = new Set([
  "2xx",
  "3xx",
  "4xx",
  "5xx",
]);

function createInitialStore(): MetricsStore {
  return {
    pollCycles: { success: 0, failure: 0 },
    lastPollDurationMs: 0,
    lastPollRpcLatencyMs: 0,
    ledgerLag: 0,
    lastIndexedLedger: 0,
    chainHeadLedger: 0,
    events: {
      circle: { processed: 0, skipped: 0, failed: 0, retried: 0 },
      factory: { processed: 0, skipped: 0, failed: 0, retried: 0 },
      reputation: { processed: 0, skipped: 0, failed: 0, retried: 0 },
      unknown: { processed: 0, skipped: 0, failed: 0, retried: 0 },
    },
    decodeFailures: {
      circle: 0,
      factory: 0,
      reputation: 0,
      unknown: 0,
    },
    lastDbCommitDurationMs: 0,
    poolSaturationCount: 0,
    httpRequests: {
      list: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 },
      detail: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 },
      history: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 },
      health: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 },
      metrics: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 },
      other: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 },
    },
    lastHttpRequestDurationMs: {
      list: 0,
      detail: 0,
      history: 0,
      health: 0,
      metrics: 0,
      other: 0,
    },
  };
}

let store: MetricsStore = createInitialStore();

// ── Instrumentation Recorders ─────────────────────────────────────────────────

export function recordPollCycle(outcome: PollOutcome, durationMs: number): void {
  const safeOutcome: PollOutcome = VALID_POLL_OUTCOMES.has(outcome) ? outcome : "failure";
  store.pollCycles[safeOutcome]++;
  store.lastPollDurationMs = Math.max(0, durationMs);
}

export function recordPollRpcLatency(latencyMs: number): void {
  store.lastPollRpcLatencyMs = Math.max(0, latencyMs);
}

export function recordLedgerPositions(lastIndexed: number, chainHead: number): void {
  store.lastIndexedLedger = Math.max(0, lastIndexed);
  store.chainHeadLedger = Math.max(0, chainHead);
  store.ledgerLag = Math.max(0, chainHead - lastIndexed);
}

export function recordEvent(category: EventCategory, outcome: EventOutcome): void {
  const safeCategory: EventCategory = VALID_CATEGORIES.has(category) ? category : "unknown";
  const safeOutcome: EventOutcome = VALID_EVENT_OUTCOMES.has(outcome) ? outcome : "failed";
  store.events[safeCategory][safeOutcome]++;
}

export function recordEventDecodeFailure(category: EventCategory): void {
  const safeCategory: EventCategory = VALID_CATEGORIES.has(category) ? category : "unknown";
  store.decodeFailures[safeCategory]++;
}

export function recordDbCommitDuration(durationMs: number): void {
  store.lastDbCommitDurationMs = Math.max(0, durationMs);
}

export function recordPoolSaturation(): void {
  store.poolSaturationCount++;
}

export function recordHttpRequest(
  route: RouteClass,
  statusCode: number,
  durationMs: number,
): void {
  const safeRoute: RouteClass = VALID_ROUTE_CLASSES.has(route) ? route : "other";
  let statusClass: HttpStatusClass = "2xx";
  if (statusCode >= 500) statusClass = "5xx";
  else if (statusCode >= 400) statusClass = "4xx";
  else if (statusCode >= 300) statusClass = "3xx";

  store.httpRequests[safeRoute][statusClass]++;
  store.lastHttpRequestDurationMs[safeRoute] = Math.max(0, durationMs);
}

/** Resets metrics store (used for isolation in automated tests). */
export function _resetMetricsForTest(): void {
  store = createInitialStore();
}

// ── Export Representation (JSON & Prometheus Text) ───────────────────────────

export interface PipelineMetricsSnapshot {
  pollCyclesTotal: Record<PollOutcome, number>;
  lastPollDurationMs: number;
  lastPollRpcLatencyMs: number;
  ledgerLagLedgers: number;
  lastIndexedLedger: number;
  chainHeadLedger: number;
  eventsTotal: Record<EventCategory, Record<EventOutcome, number>>;
  decodeFailuresTotal: Record<EventCategory, number>;
  lastDbCommitDurationMs: number;
  poolConnections: Record<PoolConnectionState, number>;
  poolSaturationTotal: number;
  httpRequestsTotal: Record<RouteClass, Record<HttpStatusClass, number>>;
  lastHttpRequestDurationMs: Record<RouteClass, number>;
}

export function getPipelineMetrics(): PipelineMetricsSnapshot {
  let poolStats = { totalCount: 0, idleCount: 0, waitingCount: 0 };
  try {
    poolStats = getPoolStats();
  } catch {
    // If pool is not ready, stats remain zero
  }

  return {
    pollCyclesTotal: { ...store.pollCycles },
    lastPollDurationMs: store.lastPollDurationMs,
    lastPollRpcLatencyMs: store.lastPollRpcLatencyMs,
    ledgerLagLedgers: store.ledgerLag,
    lastIndexedLedger: store.lastIndexedLedger,
    chainHeadLedger: store.chainHeadLedger,
    eventsTotal: {
      circle: { ...store.events.circle },
      factory: { ...store.events.factory },
      reputation: { ...store.events.reputation },
      unknown: { ...store.events.unknown },
    },
    decodeFailuresTotal: { ...store.decodeFailures },
    lastDbCommitDurationMs: store.lastDbCommitDurationMs,
    poolConnections: {
      active: Math.max(0, poolStats.totalCount - poolStats.idleCount),
      idle: poolStats.idleCount,
      waiting: poolStats.waitingCount,
    },
    poolSaturationTotal: store.poolSaturationCount,
    httpRequestsTotal: {
      list: { ...store.httpRequests.list },
      detail: { ...store.httpRequests.detail },
      history: { ...store.httpRequests.history },
      health: { ...store.httpRequests.health },
      metrics: { ...store.httpRequests.metrics },
      other: { ...store.httpRequests.other },
    },
    lastHttpRequestDurationMs: { ...store.lastHttpRequestDurationMs },
  };
}

/**
 * Formats metrics in the standard Prometheus exposition format.
 *
 * Each metric is documented with HELP and TYPE lines. Label values are strictly
 * bounded and sorted for deterministic outputs.
 */
export function formatPrometheusMetrics(): string {
  const snapshot = getPipelineMetrics();
  const lines: string[] = [];

  // Poll Cycles
  lines.push("# HELP indexer_poll_cycles_total Total number of completed poll cycles by outcome.");
  lines.push("# TYPE indexer_poll_cycles_total counter");
  lines.push(`indexer_poll_cycles_total{outcome="success"} ${snapshot.pollCyclesTotal.success}`);
  lines.push(`indexer_poll_cycles_total{outcome="failure"} ${snapshot.pollCyclesTotal.failure}`);

  // Poll Duration
  lines.push("# HELP indexer_poll_duration_ms Duration of the last poll cycle in milliseconds.");
  lines.push("# TYPE indexer_poll_duration_ms gauge");
  lines.push(`indexer_poll_duration_ms ${snapshot.lastPollDurationMs}`);

  // RPC Latency
  lines.push("# HELP indexer_poll_rpc_latency_ms Latency of the last Soroban RPC getEvents call in milliseconds.");
  lines.push("# TYPE indexer_poll_rpc_latency_ms gauge");
  lines.push(`indexer_poll_rpc_latency_ms ${snapshot.lastPollRpcLatencyMs}`);

  // Ledger Positions & Lag
  lines.push("# HELP indexer_ledger_lag_ledgers Difference between chain tip and last indexed checkpoint ledger.");
  lines.push("# TYPE indexer_ledger_lag_ledgers gauge");
  lines.push(`indexer_ledger_lag_ledgers ${snapshot.ledgerLagLedgers}`);

  lines.push("# HELP indexer_last_indexed_ledger Last confirmed checkpoint ledger index.");
  lines.push("# TYPE indexer_last_indexed_ledger gauge");
  lines.push(`indexer_last_indexed_ledger ${snapshot.lastIndexedLedger}`);

  lines.push("# HELP indexer_chain_head_ledger Latest on-chain ledger reported by Soroban RPC.");
  lines.push("# TYPE indexer_chain_head_ledger gauge");
  lines.push(`indexer_chain_head_ledger ${snapshot.chainHeadLedger}`);

  // Events Processed
  lines.push("# HELP indexer_events_total Ingested events by contract category and processing outcome.");
  lines.push("# TYPE indexer_events_total counter");
  for (const cat of ["circle", "factory", "reputation", "unknown"] as EventCategory[]) {
    for (const out of ["processed", "skipped", "failed", "retried"] as EventOutcome[]) {
      lines.push(`indexer_events_total{category="${cat}",outcome="${out}"} ${snapshot.eventsTotal[cat][out]}`);
    }
  }

  // Event Decode Failures
  lines.push("# HELP indexer_event_decode_failures_total Count of events that failed parsing or XDR decoding.");
  lines.push("# TYPE indexer_event_decode_failures_total counter");
  for (const cat of ["circle", "factory", "reputation", "unknown"] as EventCategory[]) {
    lines.push(`indexer_event_decode_failures_total{category="${cat}"} ${snapshot.decodeFailuresTotal[cat]}`);
  }

  // DB Commit Duration
  lines.push("# HELP indexer_db_commit_duration_ms Duration of the last ledger database transaction commit in milliseconds.");
  lines.push("# TYPE indexer_db_commit_duration_ms gauge");
  lines.push(`indexer_db_commit_duration_ms ${snapshot.lastDbCommitDurationMs}`);

  // DB Pool Connections
  lines.push("# HELP indexer_db_pool_connections Current PostgreSQL pool connections by state.");
  lines.push("# TYPE indexer_db_pool_connections gauge");
  lines.push(`indexer_db_pool_connections{state="active"} ${snapshot.poolConnections.active}`);
  lines.push(`indexer_db_pool_connections{state="idle"} ${snapshot.poolConnections.idle}`);
  lines.push(`indexer_db_pool_connections{state="waiting"} ${snapshot.poolConnections.waiting}`);

  // DB Pool Saturation
  lines.push("# HELP indexer_db_pool_saturation_total Total occurrences where connection acquisition timed out.");
  lines.push("# TYPE indexer_db_pool_saturation_total counter");
  lines.push(`indexer_db_pool_saturation_total ${snapshot.poolSaturationTotal}`);

  // HTTP API Requests
  lines.push("# HELP indexer_http_requests_total Total HTTP requests handled by route class and status class.");
  lines.push("# TYPE indexer_http_requests_total counter");
  for (const route of ["list", "detail", "history", "health", "metrics", "other"] as RouteClass[]) {
    for (const status of ["2xx", "3xx", "4xx", "5xx"] as HttpStatusClass[]) {
      lines.push(`indexer_http_requests_total{route="${route}",status_class="${status}"} ${snapshot.httpRequestsTotal[route][status]}`);
    }
  }

  // HTTP Request Duration
  lines.push("# HELP indexer_http_request_duration_ms Duration of the last request by route class in milliseconds.");
  lines.push("# TYPE indexer_http_request_duration_ms gauge");
  for (const route of ["list", "detail", "history", "health", "metrics", "other"] as RouteClass[]) {
    lines.push(`indexer_http_request_duration_ms{route="${route}"} ${snapshot.lastHttpRequestDurationMs[route]}`);
  }

  return lines.join("\n") + "\n";
}

