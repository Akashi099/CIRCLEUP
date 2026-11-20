# Indexer Pipeline Metrics & Operational Alerts (#933)

This document specifies the bounded-cardinality, privacy-preserving operational metrics exported by the CircleUp indexer and provides recommended Prometheus alerting rules.

---

## 1. Design & Privacy Guarantees

In accordance with Issue #933:
- **Zero high-cardinality labels**: Metric series **never** include user wallet addresses, transaction hashes, Soroban contract IDs, or unformatted exception text.
- **Bounded cardinality**: Every label key takes values from small, predetermined, finite enumerations. The total number of distinct time series across the entire indexer is bounded to $\mathcal{O}(1)$ regardless of transaction volume, user counts, or cluster runtime.
- **Prometheus standard exposition**: Metrics follow standard naming conventions (`_total` for monotonic counters, `_ms` for millisecond timestamps/durations).
- **Separation of concerns**: Operational metrics are exposed on `GET /metrics` and remain independent from orchestrator liveness (`/health/live`) and readiness (`/health/ready`) probes.

---

## 2. Metric Specifications

### A. Polling & Ingestion Progress

| Metric Name | Type | Labels | Description |
|---|---|---|---|
| `indexer_poll_cycles_total` | Counter | `outcome` (`success`, `failure`) | Total completed poll cycles. |
| `indexer_poll_duration_ms` | Gauge | None | Duration of the most recent poll cycle in milliseconds. |
| `indexer_poll_rpc_latency_ms` | Gauge | None | Latency of the most recent Soroban RPC call in milliseconds. |
| `indexer_ledger_lag_ledgers` | Gauge | None | Difference between network chain tip and durable checkpoint ledger (`chain_head - last_indexed`). |
| `indexer_last_indexed_ledger` | Gauge | None | Last durable ledger index committed in Postgres. |
| `indexer_chain_head_ledger` | Gauge | None | Latest ledger reported by Stellar RPC. |

### B. Event Processing & Decode Failures

| Metric Name | Type | Labels | Description |
|---|---|---|---|
| `indexer_events_total` | Counter | `category` (`circle`, `factory`, `reputation`, `unknown`), `outcome` (`processed`, `skipped`, `failed`, `retried`) | Aggregate event outcomes. |
| `indexer_event_decode_failures_total` | Counter | `category` (`circle`, `factory`, `reputation`, `unknown`) | Malformed or unsupported XDR event payload count. |

### C. Database & Storage Layer

| Metric Name | Type | Labels | Description |
|---|---|---|---|
| `indexer_db_commit_duration_ms` | Gauge | None | Duration of the most recent ledger checkpoint transaction commit in milliseconds. |
| `indexer_db_pool_connections` | Gauge | `state` (`active`, `idle`, `waiting`) | Current connection pool status. |
| `indexer_db_pool_saturation_total` | Counter | None | Total occurrences where a client waited or timed out waiting for a free DB connection. |

### D. HTTP REST API

| Metric Name | Type | Labels | Description |
|---|---|---|---|
| `indexer_http_requests_total` | Counter | `route` (`list`, `detail`, `history`, `health`, `metrics`, `other`), `status_class` (`2xx`, `3xx`, `4xx`, `5xx`) | Incoming request volume. |
| `indexer_http_request_duration_ms` | Gauge | `route` (`list`, `detail`, `history`, `health`, `metrics`, `other`) | Latency of the most recent request per route class in milliseconds. |

---

## 3. Scrape Endpoint Usage

### Prometheus Format (Default)
```http
GET /metrics HTTP/1.1
Host: indexer.circleup.internal
Accept: text/plain
```
Output:
```prometheus
# HELP indexer_poll_cycles_total Total number of completed poll cycles by outcome.
# TYPE indexer_poll_cycles_total counter
indexer_poll_cycles_total{outcome="success"} 1240
indexer_poll_cycles_total{outcome="failure"} 2

# HELP indexer_ledger_lag_ledgers Difference between chain tip and last indexed checkpoint ledger.
# TYPE indexer_ledger_lag_ledgers gauge
indexer_ledger_lag_ledgers 1
...
```

### Structured JSON Format
```http
GET /metrics?format=json HTTP/1.1
Host: indexer.circleup.internal
Accept: application/json
```
Output returns a JSON snapshot of `PipelineMetricsSnapshot`.

---

## 4. Operational Alert Examples (Prometheus / Alertmanager)

```yaml
groups:
  - name: circleup_indexer_alerts
    rules:
      # 1. High Ledger Lag (indexer falling behind Stellar chain tip)
      - alert: IndexerLedgerLagHigh
        expr: indexer_ledger_lag_ledgers > 120
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Indexer ledger lag > 120 ledgers (~10 minutes behind chain tip)"
          description: "Indexer is currently {{ $value }} ledgers behind chain tip."

      # 2. Critical Poll Failures (repeated RPC or database errors)
      - alert: IndexerPollCyclesFailing
        expr: rate(indexer_poll_cycles_total{outcome="failure"}[5m]) > 0.5
        for: 3m
        labels:
          severity: critical
        annotations:
          summary: "Indexer poll cycles are failing frequently"
          description: "Over 50% of poll cycles in the last 5 minutes failed."

      # 3. Event Decode Failures (contract ABI drift or unhandled event schema)
      - alert: IndexerEventDecodeFailuresDetected
        expr: increase(indexer_event_decode_failures_total[10m]) > 5
        labels:
          severity: warning
        annotations:
          summary: "New unparseable/incompatible contract events detected"
          description: "{{ $value }} decode failures observed in category {{ $labels.category }}."

      # 4. Database Connection Pool Saturation
      - alert: IndexerDbPoolSaturated
        expr: indexer_db_pool_connections{state="waiting"} > 5
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "PostgreSQL connection pool has waiting clients"
          description: "Database connection pool is saturated, queries are queuing."

      # 5. High DB Commit Latency
      - alert: IndexerDbCommitSlow
        expr: indexer_db_commit_duration_ms > 2000
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "Ledger checkpoint transaction commit duration > 2s"
          description: "Postgres disk I/O or locking latency is delaying ledger cursor commit."
```

