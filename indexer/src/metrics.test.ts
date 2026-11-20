// Minimal env bootstrap before module imports that load ./config
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.STELLAR_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.CIRCLE_FACTORY_ADDRESS = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
process.env.REPUTATION_ADDRESS = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
process.env.USDC_ADDRESS = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetMetricsForTest,
  recordPollCycle,
  recordPollRpcLatency,
  recordLedgerPositions,
  recordEvent,
  recordEventDecodeFailure,
  recordDbCommitDuration,
  recordPoolSaturation,
  recordHttpRequest,
  getPipelineMetrics,
  formatPrometheusMetrics,
} from "./metrics";

describe("Indexer Pipeline Metrics (#933)", () => {
  beforeEach(() => {
    _resetMetricsForTest();
  });

  it("initializes with clean zero values and bounded structure", () => {
    const metrics = getPipelineMetrics();
    expect(metrics.pollCyclesTotal.success).toBe(0);
    expect(metrics.pollCyclesTotal.failure).toBe(0);
    expect(metrics.ledgerLagLedgers).toBe(0);
    expect(metrics.lastIndexedLedger).toBe(0);
    expect(metrics.chainHeadLedger).toBe(0);
    expect(metrics.lastPollDurationMs).toBe(0);
    expect(metrics.lastPollRpcLatencyMs).toBe(0);
    expect(metrics.lastDbCommitDurationMs).toBe(0);
    expect(metrics.poolSaturationTotal).toBe(0);
    expect(metrics.eventsTotal.circle.processed).toBe(0);
    expect(metrics.decodeFailuresTotal.circle).toBe(0);
  });

  it("records poll cycles with bounded outcomes", () => {
    recordPollCycle("success", 120);
    recordPollCycle("failure", 45);

    const metrics = getPipelineMetrics();
    expect(metrics.pollCyclesTotal.success).toBe(1);
    expect(metrics.pollCyclesTotal.failure).toBe(1);
    expect(metrics.lastPollDurationMs).toBe(45);
  });

  it("records RPC latency and ledger positions accurately", () => {
    recordPollRpcLatency(85);
    recordLedgerPositions(1000, 1015);

    const metrics = getPipelineMetrics();
    expect(metrics.lastPollRpcLatencyMs).toBe(85);
    expect(metrics.lastIndexedLedger).toBe(1000);
    expect(metrics.chainHeadLedger).toBe(1015);
    expect(metrics.ledgerLagLedgers).toBe(15);
  });

  it("records event outcomes across categories with strictly bounded labels", () => {
    recordEvent("circle", "processed");
    recordEvent("circle", "processed");
    recordEvent("circle", "failed");
    recordEvent("factory", "processed");
    recordEvent("reputation", "retried");
    recordEvent("unknown", "skipped");

    const metrics = getPipelineMetrics();
    expect(metrics.eventsTotal.circle.processed).toBe(2);
    expect(metrics.eventsTotal.circle.failed).toBe(1);
    expect(metrics.eventsTotal.factory.processed).toBe(1);
    expect(metrics.eventsTotal.reputation.retried).toBe(1);
    expect(metrics.eventsTotal.unknown.skipped).toBe(1);
  });

  it("records event decode failures per category", () => {
    recordEventDecodeFailure("circle");
    recordEventDecodeFailure("factory");
    recordEventDecodeFailure("unknown");

    const metrics = getPipelineMetrics();
    expect(metrics.decodeFailuresTotal.circle).toBe(1);
    expect(metrics.decodeFailuresTotal.factory).toBe(1);
    expect(metrics.decodeFailuresTotal.reputation).toBe(0);
    expect(metrics.decodeFailuresTotal.unknown).toBe(1);
  });

  it("records database commit duration and pool saturation", () => {
    recordDbCommitDuration(14);
    recordPoolSaturation();
    recordPoolSaturation();

    const metrics = getPipelineMetrics();
    expect(metrics.lastDbCommitDurationMs).toBe(14);
    expect(metrics.poolSaturationTotal).toBe(2);
  });

  it("records HTTP requests with bounded route and status classes", () => {
    recordHttpRequest("list", 200, 15);
    recordHttpRequest("list", 400, 5);
    recordHttpRequest("detail", 500, 50);
    recordHttpRequest("health", 200, 2);
    recordHttpRequest("metrics", 200, 4);

    const metrics = getPipelineMetrics();
    expect(metrics.httpRequestsTotal.list["2xx"]).toBe(1);
    expect(metrics.httpRequestsTotal.list["4xx"]).toBe(1);
    expect(metrics.httpRequestsTotal.detail["5xx"]).toBe(1);
    expect(metrics.httpRequestsTotal.health["2xx"]).toBe(1);
    expect(metrics.httpRequestsTotal.metrics["2xx"]).toBe(1);
    expect(metrics.lastHttpRequestDurationMs.detail).toBe(50);
  });

  it("formats Prometheus metrics according to exposition standards", () => {
    recordPollCycle("success", 100);
    recordLedgerPositions(500, 502);
    recordEvent("circle", "processed");
    recordEventDecodeFailure("reputation");
    recordHttpRequest("metrics", 200, 3);

    const text = formatPrometheusMetrics();

    // Verify Prometheus HELP and TYPE annotations
    expect(text).toContain("# HELP indexer_poll_cycles_total Total number of completed poll cycles by outcome.");
    expect(text).toContain("# TYPE indexer_poll_cycles_total counter");
    expect(text).toContain('indexer_poll_cycles_total{outcome="success"} 1');
    expect(text).toContain('indexer_poll_cycles_total{outcome="failure"} 0');

    expect(text).toContain("# HELP indexer_ledger_lag_ledgers Difference between chain tip and last indexed checkpoint ledger.");
    expect(text).toContain("# TYPE indexer_ledger_lag_ledgers gauge");
    expect(text).toContain("indexer_ledger_lag_ledgers 2");
    expect(text).toContain("indexer_last_indexed_ledger 500");
    expect(text).toContain("indexer_chain_head_ledger 502");

    expect(text).toContain('indexer_events_total{category="circle",outcome="processed"} 1');
    expect(text).toContain('indexer_event_decode_failures_total{category="reputation"} 1');

    expect(text).toContain('indexer_http_requests_total{route="metrics",status_class="2xx"} 1');
    expect(text).toContain("indexer_db_pool_connections");

    // Strictly ensure no high-cardinality tokens leak
    expect(text).not.toContain("GABC");
    expect(text).not.toContain("CD56");
    expect(text).not.toContain("0x");
    expect(text).not.toContain("error:");
  });
});
