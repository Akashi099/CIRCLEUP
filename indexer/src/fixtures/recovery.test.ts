/**
 * Cross-component incident recovery tests.
 *
 * Each test drives a complete scenario arc:
 *
 *   1. FAULT INJECTION   — synthetic fixture places the system in a broken state
 *   2. SERVICE RESPONSE  — local adapter logic (no live DB / RPC / network)
 *                          produces the expected degraded output
 *   3. RECOVERY          — fault is removed; adapters confirm restored behaviour
 *
 * Design principles (mirrors incident.test.ts):
 *   • Deterministic — every value comes from incident-fixtures.ts; no
 *     Date.now(), Math.random(), or external I/O.
 *   • Offline — no real wallets, no live RPC, no Postgres connection.
 *   • Single assertion per invariant — one `test()` per checkpoint so CI
 *     output pinpoints the broken step in the scenario arc.
 *   • No secret keys — all addresses/hashes are synthetic (G/C-prefix).
 *
 * Scenarios covered
 * ─────────────────
 *   A. StaleIndexerData  — cursor freeze → degraded health → recovery after
 *                          cursor advances to current ledger
 *   B. DuplicateEvents   — double-ingest → dedup guard fires → idempotency
 *                          confirmed → normal reads restored
 *
 * Runbook cross-references (docs/RUNBOOK.md):
 *   A → "Circle list is empty but circles exist on-chain"
 *   B → "Circle list is empty but circles exist on-chain" (dedup invariant)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  StaleIndexerData,
  DuplicateEvents,
  SYNTHETIC_ADDRESSES,
  SYNTHETIC_TX_HASHES,
  LEDGER,
} from "./incident-fixtures";

import {
  classifyIndexerHealth,
  type IndexerHealthThresholds,
} from "../../app/src/lib/indexerHealth";

// ─── Local adapters (deterministic, no I/O) ───────────────────────────────────
//
// Each adapter mirrors the real component's core logic using only the types and
// arithmetic from the incident fixtures, so tests run offline and deterministically.

// ── Indexer-state adapter ─────────────────────────────────────────────────────

interface IndexerStateRow {
  last_ledger: number;
  updated_at: string;
}

interface CircleRow {
  address: string;
  status: string;
  current_round: number;
}

/** Simulates reading the indexer's own state row from the DB. */
function readIndexerState(row: IndexerStateRow) {
  return { lastLedger: row.last_ledger, updatedAt: row.updated_at };
}

/** Simulates reading a circle row from the indexer DB. */
function readCircleFromDb(row: CircleRow) {
  return { address: row.address, status: row.status, currentRound: row.current_round };
}

// ── Health classifier adapter ─────────────────────────────────────────────────
//
// Wraps classifyIndexerHealth with a fixed clock so tests are deterministic.
// "now" is pinned to a timestamp derived from the fixture's STALE updated_at
// plus a realistic observation delay (30 minutes — well past any threshold).

const STALE_UPDATED_AT = "2026-08-01T00:00:00.000Z";
const OBSERVATION_DELAY_SEC = 30 * 60; // 30 minutes after the stale timestamp
const FIXTURE_NOW_SEC =
  Date.parse(STALE_UPDATED_AT) / 1000 + OBSERVATION_DELAY_SEC;

const HEALTH_THRESHOLDS: IndexerHealthThresholds = {
  nowSec: FIXTURE_NOW_SEC,
  maxLedgerLag: 100,          // mirrors indexerHealth.ts defaults
  maxCheckpointAgeSec: 300,
  rpcOutageThresholdSec: 1800,
};

// ── Dedup-table adapter ───────────────────────────────────────────────────────

/**
 * In-memory dedup table that mirrors the `ingested_events` PRIMARY KEY
 * constraint: inserting a duplicate event_key is a no-op.
 */
class DedupTable {
  private readonly keys = new Set<string>();

  insert(eventKey: string): { inserted: boolean } {
    if (this.keys.has(eventKey)) return { inserted: false };
    this.keys.add(eventKey);
    return { inserted: true };
  }

  has(eventKey: string): boolean {
    return this.keys.has(eventKey);
  }

  get size(): number {
    return this.keys.size;
  }
}

/**
 * In-memory contributions table with a UNIQUE(circle_address, member_address,
 * round_index) constraint — mirrors Postgres upsert behaviour.
 */
class ContributionsTable {
  private readonly rows = new Map<string, unknown>();

  upsert(row: {
    circle_address: string;
    member_address: string;
    round_index: number;
    amount: string;
  }): { inserted: boolean } {
    const key = `${row.circle_address}:${row.member_address}:${row.round_index}`;
    if (this.rows.has(key)) return { inserted: false };
    this.rows.set(key, row);
    return { inserted: true };
  }

  count(): number {
    return this.rows.size;
  }
}

/**
 * In-memory payouts table with UNIQUE(circle_address, round_index).
 */
class PayoutsTable {
  private readonly rows = new Map<string, unknown>();

  upsert(row: {
    circle_address: string;
    round_index: number;
    recipient: string;
    amount: string;
  }): { inserted: boolean } {
    const key = `${row.circle_address}:${row.round_index}`;
    if (this.rows.has(key)) return { inserted: false };
    this.rows.set(key, row);
    return { inserted: true };
  }

  count(): number {
    return this.rows.size;
  }
}

// ── Circle-state reconciler adapter ──────────────────────────────────────────

interface OnChainState {
  status: string;
  currentRound: number;
  roundsCompleted: number;
  latestLedger: number;
}

interface DbCircleState {
  status: string;
  current_round: number;
  last_ledger: number;
}

/**
 * Determines whether the DB circle row needs to be reconciled with the on-chain
 * state.  Returns a ReconcileAction describing what must change.
 */
function reconcileCircleState(
  db: DbCircleState,
  onChain: OnChainState,
): {
  needsReconcile: boolean;
  statusDrift: boolean;
  roundDrift: boolean;
  newStatus?: string;
  newRound?: number;
} {
  const statusDrift = db.status !== onChain.status;
  const roundDrift = db.current_round !== onChain.currentRound;
  return {
    needsReconcile: statusDrift || roundDrift,
    statusDrift,
    roundDrift,
    ...(statusDrift ? { newStatus: onChain.status } : {}),
    ...(roundDrift ? { newRound: onChain.currentRound } : {}),
  };
}

/**
 * Applies a reconcile action to a mutable DB row.
 * Returns the updated row.
 */
function applyReconcile(
  db: DbCircleState,
  action: ReturnType<typeof reconcileCircleState>,
  newLastLedger: number,
): DbCircleState {
  return {
    status: action.newStatus ?? db.status,
    current_round: action.newRound ?? db.current_round,
    last_ledger: newLastLedger,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO A: StaleIndexerData
//
// Arc:
//   FAULT   → indexer cursor frozen at LEDGER.STALE; circle shows Active/round 0
//   RESPONSE→ health classified as degraded / rpc_outage; app banner shown
//   RECOVERY→ cursor advances to LEDGER.CURRENT; reconcile brings DB in sync;
//             health classified as healthy
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario A: StaleIndexerData — cursor freeze → recovery", () => {
  // ── A-1: FAULT INJECTION ─────────────────────────────────────────────────

  test("A-1 [FAULT] stale indexer state row has last_ledger = LEDGER.STALE", () => {
    const row = StaleIndexerData.seedIndexerState();
    const state = readIndexerState(row);
    assert.equal(state.lastLedger, LEDGER.STALE, "indexer cursor must be at the STALE ledger");
    assert.ok(state.lastLedger < LEDGER.CURRENT, "STALE must be behind the chain tip");
  });

  test("A-2 [FAULT] stale circle DB row shows Active status (should be Completed)", () => {
    const row = StaleIndexerData.seedCircle();
    const circle = readCircleFromDb(row);
    assert.equal(circle.status, "Active", "DB must show stale Active status");
  });

  test("A-3 [FAULT] stale circle DB row shows current_round = 0 (should be 4)", () => {
    const row = StaleIndexerData.seedCircle();
    const circle = readCircleFromDb(row);
    assert.equal(
      circle.currentRound,
      StaleIndexerData.expectedBehaviour.apiCurrentRound,
      "DB must show stale round 0",
    );
  });

  test("A-4 [FAULT] ledger lag equals the documented 60_000-ledger gap", () => {
    const indexerRow = StaleIndexerData.seedIndexerState();
    const onChain = StaleIndexerData.seedOnChainState();
    const lag = onChain.latestLedger - indexerRow.last_ledger;
    assert.equal(lag, StaleIndexerData.expectedBehaviour.lagLedgers);
    assert.equal(lag, LEDGER.CURRENT - LEDGER.STALE);
  });

  // ── A-5: SERVICE RESPONSE — health classification ─────────────────────────

  test("A-5 [RESPONSE] classifyIndexerHealth returns degraded or rpc_outage for stale cursor", () => {
    const indexerRow = StaleIndexerData.seedIndexerState();
    const onChain = StaleIndexerData.seedOnChainState();

    // The stale updated_at is 30 minutes in the past relative to FIXTURE_NOW_SEC,
    // which exceeds rpcOutageThresholdSec (1800 s) — expect rpc_outage.
    const health = classifyIndexerHealth(
      indexerRow.last_ledger,
      onChain.latestLedger,
      indexerRow.updated_at,   // used as checkpointTime
      HEALTH_THRESHOLDS,
    );

    assert.ok(
      health.status === "rpc_outage" || health.status === "degraded",
      `health status must be degraded or rpc_outage during a cursor freeze, got: ${health.status}`,
    );
    assert.notEqual(health.status, "healthy", "stale cursor must never classify as healthy");
    assert.notEqual(health.status, "unknown", "ledger data is present — must not be unknown");
  });

  test("A-6 [RESPONSE] app banner flag is set in expectedBehaviour", () => {
    assert.equal(
      StaleIndexerData.expectedBehaviour.appBannerShown,
      true,
      "app must show a stale-data banner when the cursor is frozen",
    );
  });

  test("A-7 [RESPONSE] health ledgerLag matches the documented lag", () => {
    const indexerRow = StaleIndexerData.seedIndexerState();
    const onChain = StaleIndexerData.seedOnChainState();

    const health = classifyIndexerHealth(
      indexerRow.last_ledger,
      onChain.latestLedger,
      indexerRow.updated_at,
      HEALTH_THRESHOLDS,
    );

    assert.equal(
      health.ledgerLag,
      StaleIndexerData.expectedBehaviour.lagLedgers,
      "ledgerLag must match the documented fixture lag",
    );
  });

  test("A-8 [RESPONSE] health statusDescription mentions staleness (actionable message)", () => {
    const indexerRow = StaleIndexerData.seedIndexerState();
    const onChain = StaleIndexerData.seedOnChainState();
    const health = classifyIndexerHealth(
      indexerRow.last_ledger,
      onChain.latestLedger,
      indexerRow.updated_at,
      HEALTH_THRESHOLDS,
    );
    // Operator must see a description that refers to the problem
    const desc = health.statusDescription.toLowerCase();
    assert.ok(
      desc.includes("stalled") || desc.includes("outage") || desc.includes("behind") ||
      desc.includes("lag") || desc.includes("checkpoint"),
      `statusDescription must mention the problem, got: "${health.statusDescription}"`,
    );
  });

  // ── A-9: RECOVERY — cursor advances, reconcile, health restored ───────────

  test("A-9 [RECOVERY] reconcile detects status drift between DB and on-chain", () => {
    const dbRow = StaleIndexerData.seedCircle();
    const onChain = StaleIndexerData.seedOnChainState();

    const dbState: DbCircleState = {
      status: dbRow.status,
      current_round: dbRow.current_round,
      last_ledger: dbRow.updated_at ? LEDGER.STALE : LEDGER.STALE,
    };

    const action = reconcileCircleState(dbState, onChain);
    assert.equal(action.statusDrift, true, "status drift must be detected");
    assert.equal(action.roundDrift, true, "round drift must be detected");
    assert.equal(action.needsReconcile, true, "reconcile must be needed");
  });

  test("A-10 [RECOVERY] applyReconcile brings DB row in sync with on-chain state", () => {
    const dbRow = StaleIndexerData.seedCircle();
    const onChain = StaleIndexerData.seedOnChainState();

    const dbState: DbCircleState = {
      status: dbRow.status,
      current_round: dbRow.current_round,
      last_ledger: LEDGER.STALE,
    };

    const action = reconcileCircleState(dbState, onChain);
    const updated = applyReconcile(dbState, action, LEDGER.CURRENT);

    assert.equal(updated.status, onChain.status, "status must be updated to on-chain value");
    assert.equal(
      updated.current_round,
      onChain.currentRound,
      "current_round must be updated to on-chain value",
    );
    assert.equal(
      updated.last_ledger,
      LEDGER.CURRENT,
      "last_ledger must advance to the current chain tip",
    );
  });

  test("A-11 [RECOVERY] after cursor advances health classifies as healthy", () => {
    const onChain = StaleIndexerData.seedOnChainState();

    // Simulate the indexer cursor catching up: last_ledger = CURRENT,
    // checkpoint time is within the healthy window (30 seconds ago).
    const freshCheckpointTime = new Date((FIXTURE_NOW_SEC - 30) * 1000).toISOString();

    const health = classifyIndexerHealth(
      LEDGER.CURRENT,            // indexer has caught up
      onChain.latestLedger,      // chain tip (same)
      freshCheckpointTime,
      HEALTH_THRESHOLDS,
    );

    assert.equal(
      health.status,
      "healthy",
      `health must be 'healthy' after cursor catches up, got: ${health.status}`,
    );
  });

  test("A-12 [RECOVERY] after reconcile, no status or round drift remains", () => {
    const dbRow = StaleIndexerData.seedCircle();
    const onChain = StaleIndexerData.seedOnChainState();

    const dbState: DbCircleState = {
      status: dbRow.status,
      current_round: dbRow.current_round,
      last_ledger: LEDGER.STALE,
    };

    const action = reconcileCircleState(dbState, onChain);
    const updated = applyReconcile(dbState, action, LEDGER.CURRENT);

    // Re-run reconcile on the updated row — must show nothing to do
    const recheck = reconcileCircleState(updated, onChain);
    assert.equal(
      recheck.needsReconcile,
      false,
      "re-running reconcile on an already-synced row must show no drift",
    );
  });

  test("A-13 [RECOVERY] reconcile is idempotent when applied twice", () => {
    const dbRow = StaleIndexerData.seedCircle();
    const onChain = StaleIndexerData.seedOnChainState();

    const dbState: DbCircleState = {
      status: dbRow.status,
      current_round: dbRow.current_round,
      last_ledger: LEDGER.STALE,
    };

    const action1 = reconcileCircleState(dbState, onChain);
    const afterFirst = applyReconcile(dbState, action1, LEDGER.CURRENT);

    const action2 = reconcileCircleState(afterFirst, onChain);
    const afterSecond = applyReconcile(afterFirst, action2, LEDGER.CURRENT);

    assert.deepEqual(
      afterFirst,
      afterSecond,
      "applying reconcile a second time must produce the same row (idempotent)",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO B: DuplicateEvents
//
// Arc:
//   FAULT   → same Soroban event delivered twice to the indexer
//   RESPONSE→ dedup table (ingested_events PRIMARY KEY) blocks the second write;
//             contribution and payout tables remain at exactly one row each
//   RECOVERY→ normal next-event ingestion proceeds without interference
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario B: DuplicateEvents — double-ingest → dedup → recovery", () => {
  // ── B-1: FAULT INJECTION ─────────────────────────────────────────────────

  test("B-1 [FAULT] duplicate event has the same event_key as the original", () => {
    const original = DuplicateEvents.seedIngestedEvent();
    const duplicate = DuplicateEvents.seedDuplicateIngestedEvent();
    assert.equal(
      original.event_key,
      duplicate.event_key,
      "duplicate must have identical event_key (PRIMARY KEY collision)",
    );
  });

  test("B-2 [FAULT] duplicate event matches original on tx_hash, event_type, and ledger", () => {
    const original = DuplicateEvents.seedIngestedEvent();
    const duplicate = DuplicateEvents.seedDuplicateIngestedEvent();
    assert.equal(original.tx_hash, duplicate.tx_hash);
    assert.equal(original.event_type, duplicate.event_type);
    assert.equal(original.ledger, duplicate.ledger);
  });

  // ── B-3: SERVICE RESPONSE — dedup guard ──────────────────────────────────

  test("B-3 [RESPONSE] first ingestion of event_key inserts successfully", () => {
    const table = new DedupTable();
    const event = DuplicateEvents.seedIngestedEvent();
    const result = table.insert(event.event_key);
    assert.equal(result.inserted, true, "first insert must succeed");
    assert.equal(table.size, 1);
  });

  test("B-4 [RESPONSE] second ingestion of same event_key is rejected (dedup)", () => {
    const table = new DedupTable();
    const event = DuplicateEvents.seedIngestedEvent();
    const dup = DuplicateEvents.seedDuplicateIngestedEvent();

    table.insert(event.event_key);
    const result = table.insert(dup.event_key);

    assert.equal(result.inserted, false, "duplicate insert must be rejected");
    assert.equal(
      table.size,
      DuplicateEvents.expectedBehaviour.ingestedEventsRows,
      "table must contain exactly one row after double-ingest",
    );
  });

  test("B-5 [RESPONSE] N re-deliveries of the same event produce exactly one row", () => {
    const table = new DedupTable();
    const event = DuplicateEvents.seedIngestedEvent();

    for (let i = 0; i < 10; i++) {
      table.insert(event.event_key);
    }

    assert.equal(
      table.size,
      DuplicateEvents.expectedBehaviour.ingestedEventsRows,
      "dedup table must have exactly one row regardless of delivery count",
    );
  });

  test("B-6 [RESPONSE] contribution table has exactly one row after double-ingest", () => {
    const contribs = new ContributionsTable();
    const contrib = DuplicateEvents.seedContribution();

    contribs.upsert(contrib);
    contribs.upsert({ ...contrib }); // identical row

    assert.equal(
      contribs.count(),
      DuplicateEvents.expectedBehaviour.contributionRowsAfterDoubleIngest,
    );
  });

  test("B-7 [RESPONSE] payout table has exactly one row after double-ingest", () => {
    const payouts = new PayoutsTable();
    const payout = DuplicateEvents.seedPayout();

    payouts.upsert(payout);
    payouts.upsert({ ...payout }); // identical row

    assert.equal(
      payouts.count(),
      DuplicateEvents.expectedBehaviour.payoutRowsAfterDoubleIngest,
    );
  });

  test("B-8 [RESPONSE] dedup does not block events with different event_key", () => {
    const table = new DedupTable();
    const event = DuplicateEvents.seedIngestedEvent();

    // First event (duplicate target)
    table.insert(event.event_key);

    // A genuinely distinct event arriving from the same transaction
    const distinctKey = DuplicateEvents.eventKey(
      SYNTHETIC_TX_HASHES.ROUND1_PAYOUT,
      0,
    );
    const result = table.insert(distinctKey);

    assert.equal(
      result.inserted,
      true,
      "a distinct event_key must not be blocked by the dedup guard",
    );
    assert.equal(table.size, 2);
  });

  test("B-9 [RESPONSE] event_key format is tx_hash:event_index", () => {
    const key = DuplicateEvents.eventKey(SYNTHETIC_TX_HASHES.DUPLICATE_HASH, 0);
    assert.ok(key.includes(":"), "event_key must contain ':' separator");
    assert.ok(
      key.startsWith(SYNTHETIC_TX_HASHES.DUPLICATE_HASH),
      "event_key must begin with the tx_hash",
    );
    assert.ok(key.endsWith(":0"), "event_key must end with ':event_index'");
  });

  // ── B-10: RECOVERY — normal reads after dedup guard fires ─────────────────

  test("B-10 [RECOVERY] after dedup, reading contribution count returns exactly 1", () => {
    const contribs = new ContributionsTable();
    const contrib = DuplicateEvents.seedContribution();

    // Simulate a duplicate delivery (two upserts)
    contribs.upsert(contrib);
    contribs.upsert({ ...contrib });

    // Application reads the count — must be 1 (not 2)
    assert.equal(contribs.count(), 1);
  });

  test("B-11 [RECOVERY] after dedup, reading payout count returns exactly 1", () => {
    const payouts = new PayoutsTable();
    const payout = DuplicateEvents.seedPayout();

    payouts.upsert(payout);
    payouts.upsert({ ...payout });

    assert.equal(payouts.count(), 1);
  });

  test("B-12 [RECOVERY] next round's contribution is accepted after dedup guard cleared", () => {
    const contribs = new ContributionsTable();
    const round0 = DuplicateEvents.seedContribution();

    // Round 0 contributed + duplicate blocked
    contribs.upsert(round0);
    contribs.upsert({ ...round0 });

    // Round 1 contribution from same member — different round_index → new key
    const round1: typeof round0 = { ...round0, round_index: 1 };
    const result = contribs.upsert(round1);

    assert.equal(
      result.inserted,
      true,
      "round 1 contribution must be accepted even after round 0 dedup guard fired",
    );
    assert.equal(contribs.count(), 2, "two distinct contributions (round 0 and round 1)");
  });

  test("B-13 [RECOVERY] different member in same round is accepted after dedup guard", () => {
    const contribs = new ContributionsTable();
    const aliceContrib = DuplicateEvents.seedContribution(); // alice, round 0

    contribs.upsert(aliceContrib);
    contribs.upsert({ ...aliceContrib }); // duplicate — blocked

    // Bob's contribution for the same round — different member_address
    const bobContrib = {
      ...aliceContrib,
      member_address: SYNTHETIC_ADDRESSES.MEMBER_BOB,
      tx_hash: SYNTHETIC_TX_HASHES.BOB_CONTRIBUTE_0,
    };
    const result = contribs.upsert(bobContrib);

    assert.equal(result.inserted, true, "bob's contribution must not be blocked by alice's dedup");
    assert.equal(contribs.count(), 2);
  });

  // ── B-14: CROSS-SCENARIO INVARIANT ──────────────────────────────────────

  test("B-14 [INVARIANT] dedup table is independent of the stale-data scenario state", () => {
    // The dedup guard operates on event delivery, not on ledger lag.
    // A stale cursor does not invalidate the dedup table.
    const dedupTable = new DedupTable();
    const event = DuplicateEvents.seedIngestedEvent();

    // Even when the indexer cursor is stale, the dedup key is the same
    dedupTable.insert(event.event_key);
    const dupResult = dedupTable.insert(event.event_key);

    assert.equal(
      dupResult.inserted,
      false,
      "dedup guard must function regardless of ledger lag state",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CROSS-SCENARIO INVARIANTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Cross-scenario invariants", () => {
  test("all fixture addresses are synthetic (non-S-prefix, non-production)", () => {
    const addresses = [
      SYNTHETIC_ADDRESSES.CIRCLE_A,
      SYNTHETIC_ADDRESSES.CIRCLE_B,
      SYNTHETIC_ADDRESSES.MEMBER_ALICE,
      SYNTHETIC_ADDRESSES.MEMBER_BOB,
      SYNTHETIC_ADDRESSES.MEMBER_CAROL,
      SYNTHETIC_ADDRESSES.MEMBER_DAVE,
      SYNTHETIC_ADDRESSES.FACTORY,
      SYNTHETIC_ADDRESSES.REPUTATION,
      SYNTHETIC_ADDRESSES.USDC,
    ];
    for (const addr of addresses) {
      assert.doesNotMatch(
        addr,
        /^S/,
        `address "${addr}" must not be a secret key (S-prefix)`,
      );
      assert.match(
        addr,
        /^[GC][A-Z2-7]{55}$/,
        `address "${addr}" must be a valid synthetic Stellar address`,
      );
    }
  });

  test("LEDGER constants used across scenarios maintain strict ordering", () => {
    assert.ok(LEDGER.STALE < LEDGER.CURRENT, "STALE must be behind CURRENT");
    assert.ok(
      LEDGER.ROUND_0_END < LEDGER.STALE,
      "dedup event ledger (ROUND_0_END) must be before the stale cursor (STALE)",
    );
  });

  test("fixture tx_hashes are all synthetic (zero-prefix or f-repeat pattern)", () => {
    const hashes = Object.values(SYNTHETIC_TX_HASHES);
    for (const h of hashes) {
      assert.match(h, /^[0-9a-f]{64}$/, "tx_hash must be 64 lowercase hex chars");
      assert.ok(
        h.startsWith("0") || h.startsWith("f"),
        `tx_hash "${h.slice(0, 8)}…" must start with '0' or 'f' (synthetic pattern)`,
      );
    }
  });

  test("health classification never returns 'healthy' for stale fixture data", () => {
    // Run all three stale-data health checks and confirm none are healthy
    const indexerRow = StaleIndexerData.seedIndexerState();
    const onChain = StaleIndexerData.seedOnChainState();

    const h = classifyIndexerHealth(
      indexerRow.last_ledger,
      onChain.latestLedger,
      indexerRow.updated_at,
      HEALTH_THRESHOLDS,
    );

    assert.notEqual(h.status, "healthy");
  });

  test("dedup guard and health classifier operate independently (no shared state)", () => {
    // Performing dedup operations must not affect health classification
    const dedupTable = new DedupTable();
    const event = DuplicateEvents.seedIngestedEvent();
    dedupTable.insert(event.event_key);
    dedupTable.insert(event.event_key); // triggers dedup

    // Health is still classified from ledger data — dedup has no side effect on it
    const indexerRow = StaleIndexerData.seedIndexerState();
    const onChain = StaleIndexerData.seedOnChainState();
    const health = classifyIndexerHealth(
      indexerRow.last_ledger,
      onChain.latestLedger,
      indexerRow.updated_at,
      HEALTH_THRESHOLDS,
    );

    assert.ok(
      health.status === "degraded" || health.status === "rpc_outage",
      "health classification must be independent of dedup state",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO C: WalletRejection
//
// Arc:
//   FAULT   → Freighter wallet produces an error instead of a signed XDR
//             (three sub-cases: not_installed, permission_denied, unknown)
//   RESPONSE→ invokeContract returns success=false with a clean user message;
//             no transaction is submitted; txHash is empty
//   RECOVERY→ after the user resolves the wallet issue, a subsequent invocation
//             with valid signing succeeds and returns a non-empty txHash
//
// Runbook: "Freighter not detected" / "Transaction fails with USDC transfer failed"
// ═══════════════════════════════════════════════════════════════════════════════

import { WalletRejection, RpcTimeout, SchemaDrift } from "./incident-fixtures";

// ── Local adapter: wallet invocation simulator ────────────────────────────────

type WalletErrorReason = "not_installed" | "permission_denied" | "unknown";

interface InvokeResult {
  txHash: string;
  success: boolean;
  error: string;
}

/**
 * Simulates the invokeContract() path for wallet-related errors.
 * Maps raw Freighter error strings to the same clean messages the real
 * stellar.ts module produces, without touching the network.
 */
function simulateWalletInvoke(
  freighterInstalled: boolean,
  rawError: string | null,
): InvokeResult {
  if (!freighterInstalled) {
    return {
      txHash: "",
      success: false,
      error: "Freighter wallet extension is not installed.",
    };
  }

  if (rawError !== null) {
    const lower = rawError.toLowerCase();
    if (
      lower.includes("user rejected") ||
      lower.includes("denied") ||
      lower.includes("cancelled") ||
      lower.includes("canceled") ||
      lower.includes("rejected")
    ) {
      return {
        txHash: "",
        success: false,
        error: "You cancelled the transaction in Freighter. No funds were moved.",
      };
    }
    // Unknown error: preserve capitalised
    return {
      txHash: "",
      success: false,
      error: rawError.charAt(0).toUpperCase() + rawError.slice(1),
    };
  }

  // No error — signing succeeded
  return {
    txHash: "0000000000000000000000000000000000000000000000000000000000000001",
    success: true,
    error: "",
  };
}

describe("Scenario C: WalletRejection — fault → response → recovery", () => {
  // ── C-1: FAULT INJECTION ─────────────────────────────────────────────────

  test("C-1 [FAULT] not_installed: freighterInstalled is false in fixture", () => {
    assert.equal(
      WalletRejection.notInstalled.freighterInstalled,
      false,
      "fixture must signal Freighter is absent",
    );
  });

  test("C-2 [FAULT] permission_denied: rawErrorVariants are non-empty strings", () => {
    assert.ok(
      WalletRejection.permissionDenied.rawErrorVariants.length > 0,
      "fixture must supply at least one raw error variant",
    );
    for (const v of WalletRejection.permissionDenied.rawErrorVariants) {
      assert.ok(typeof v === "string" && v.length > 0, `variant must be a non-empty string: "${v}"`);
    }
  });

  test("C-3 [FAULT] unknown_error: rawError is a non-empty string", () => {
    assert.ok(
      typeof WalletRejection.unknownError.rawError === "string" &&
        WalletRejection.unknownError.rawError.length > 0,
      "unknown error fixture must have a non-empty rawError",
    );
  });

  // ── C-4: SERVICE RESPONSE ─────────────────────────────────────────────────

  test("C-4 [RESPONSE] not_installed: invoke returns success=false with Freighter message", () => {
    const result = simulateWalletInvoke(false, null);
    assert.equal(result.success, false, "must fail when Freighter is not installed");
    assert.equal(result.txHash, "", "txHash must be empty — nothing was submitted");
    assert.match(result.error, /Freighter/i, "error must name Freighter");
    assert.equal(
      result.error,
      WalletRejection.notInstalled.expectedResult.error,
    );
  });

  test("C-5 [RESPONSE] permission_denied: all raw variants map to the same clean message", () => {
    for (const rawMsg of WalletRejection.permissionDenied.rawErrorVariants) {
      const result = simulateWalletInvoke(true, rawMsg);
      assert.equal(result.success, false);
      assert.equal(result.txHash, "");
      assert.equal(
        result.error,
        WalletRejection.permissionDenied.expectedResult.error,
        `variant "${rawMsg}" must map to the standard permission-denied message`,
      );
    }
  });

  test("C-6 [RESPONSE] unknown_error: raw message is preserved (capitalised)", () => {
    const result = simulateWalletInvoke(true, WalletRejection.unknownError.rawError);
    assert.equal(result.success, false);
    assert.equal(result.error, WalletRejection.unknownError.expectedResult.error);
  });

  test("C-7 [RESPONSE] all three sub-cases return an empty txHash (nothing submitted)", () => {
    const notInstalled   = simulateWalletInvoke(false, null);
    const permDenied     = simulateWalletInvoke(true, "User denied");
    const unknownErr     = simulateWalletInvoke(true, WalletRejection.unknownError.rawError);

    assert.equal(notInstalled.txHash, "");
    assert.equal(permDenied.txHash,   "");
    assert.equal(unknownErr.txHash,   "");
  });

  test("C-8 [RESPONSE] error messages do not expose private keys or seed phrases", () => {
    const results = [
      simulateWalletInvoke(false, null),
      simulateWalletInvoke(true, "User rejected"),
      simulateWalletInvoke(true, "Extension context invalidated."),
    ];
    for (const r of results) {
      assert.doesNotMatch(r.error, /^S[A-Z2-7]{55}$/, "error must not contain a secret key");
      assert.doesNotMatch(r.error, /seed|mnemonic|private key/i, "error must not expose key material");
    }
  });

  // ── C-9: RECOVERY ────────────────────────────────────────────────────────

  test("C-9 [RECOVERY] after wallet issue is resolved, next invocation succeeds", () => {
    // Fault: permission denied
    const faultResult = simulateWalletInvoke(true, "User rejected");
    assert.equal(faultResult.success, false);

    // Recovery: user approves — no rawError, Freighter installed
    const recoveryResult = simulateWalletInvoke(true, null);
    assert.equal(recoveryResult.success, true, "must succeed after wallet issue resolved");
    assert.ok(recoveryResult.txHash.length > 0, "must return a non-empty txHash on success");
    assert.equal(recoveryResult.error, "");
  });

  test("C-10 [RECOVERY] recovery success is independent of previous failure reason", () => {
    const reasons: Array<[boolean, string | null]> = [
      [false, null],             // not_installed
      [true, "User denied"],     // permission_denied
      [true, "Extension context invalidated."],  // unknown
    ];

    for (const [installed, rawError] of reasons) {
      // Fault
      const fault = simulateWalletInvoke(installed, rawError);
      assert.equal(fault.success, false);

      // Recovery (Freighter now installed + user approves)
      const recovery = simulateWalletInvoke(true, null);
      assert.equal(recovery.success, true, `recovery must succeed after fault (installed=${installed}, error="${rawError}")`);
    }
  });

  test("C-11 [RECOVERY] invoke context carries synthetic address (no real key)", () => {
    const ctx = WalletRejection.seedInvokeContext();
    assert.doesNotMatch(ctx.walletAddress, /^S/, "invoke context must not contain a secret key");
    assert.match(ctx.walletAddress, /^[GC]/, "invoke context must use G or C address");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO D: RpcTimeout
//
// Arc:
//   FAULT   → Soroban RPC does not respond within the configured timeout
//             (three sub-cases: simulate, send, poll-exhausted)
//   RESPONSE→ invokeContract returns success=false with a network/timeout
//             message; txHash is empty for simulate/send, non-empty for poll
//   RECOVERY→ after the RPC node recovers, a subsequent call succeeds
//
// Runbook: "Transaction fails with USDC transfer failed"
//          "App shows indexer unreachable banner"
// ═══════════════════════════════════════════════════════════════════════════════

// ── Local adapter: RPC invocation simulator ───────────────────────────────────

interface RpcCallResult {
  txHash: string;
  success: boolean;
  error: string;
}

type RpcPhase = "simulate" | "send" | "poll" | "ok";

function simulateRpcInvoke(phase: RpcPhase): RpcCallResult {
  if (phase === "simulate") {
    return {
      txHash: "",
      success: false,
      error: RpcTimeout.simulateTimeout.expectedResult.error,
    };
  }
  if (phase === "send") {
    return {
      txHash: "",
      success: false,
      error: RpcTimeout.sendTimeout.expectedResult.error,
    };
  }
  if (phase === "poll") {
    return {
      txHash: RpcTimeout.pollExhausted.txHash,
      success: false,
      error: RpcTimeout.pollExhausted.expectedResult.error,
    };
  }
  // "ok" — RPC recovered
  return {
    txHash: "0000000000000000000000000000000000000000000000000000000000000002",
    success: true,
    error: "",
  };
}

describe("Scenario D: RpcTimeout — fault → response → recovery", () => {
  // ── D-1: FAULT INJECTION ─────────────────────────────────────────────────

  test("D-1 [FAULT] simulate-phase timeout: mockError is 'Request timeout'", () => {
    assert.equal(RpcTimeout.simulateTimeout.mockError.message, "Request timeout");
    assert.equal(RpcTimeout.simulateTimeout.phase, "simulate");
  });

  test("D-2 [FAULT] send-phase timeout: mockError is 'Failed to fetch'", () => {
    assert.equal(RpcTimeout.sendTimeout.mockError.message, "Failed to fetch");
    assert.equal(RpcTimeout.sendTimeout.phase, "send");
  });

  test("D-3 [FAULT] poll-exhausted: all poll statuses are NOT_FOUND", () => {
    for (const s of RpcTimeout.pollExhausted.pollStatuses) {
      assert.equal(s, "NOT_FOUND");
    }
    assert.equal(
      RpcTimeout.pollExhausted.pollStatuses.length,
      RpcTimeout.TX_POLL_ATTEMPTS,
    );
  });

  test("D-4 [FAULT] health-check timeout: both DB and RPC exceed the budget", () => {
    const { mockComponents, HEALTH_CHECK_TIMEOUT_MS } = RpcTimeout.healthCheckTimeout;
    assert.ok(mockComponents.db.latencyMs > HEALTH_CHECK_TIMEOUT_MS);
    assert.ok(mockComponents.rpc.latencyMs > HEALTH_CHECK_TIMEOUT_MS);
  });

  // ── D-5: SERVICE RESPONSE ─────────────────────────────────────────────────

  test("D-5 [RESPONSE] simulate timeout → success=false, empty txHash, RPC error message", () => {
    const result = simulateRpcInvoke("simulate");
    assert.equal(result.success, false);
    assert.equal(result.txHash, "");
    assert.match(result.error, /network error/i, "simulate timeout must produce RPC network message");
    assert.equal(result.error, RpcTimeout.simulateTimeout.expectedResult.error);
  });

  test("D-6 [RESPONSE] send timeout → success=false, empty txHash, RPC error message", () => {
    const result = simulateRpcInvoke("send");
    assert.equal(result.success, false);
    assert.equal(result.txHash, "");
    assert.equal(result.error, RpcTimeout.sendTimeout.expectedResult.error);
  });

  test("D-7 [RESPONSE] poll-exhausted → success=false, non-empty txHash preserved", () => {
    const result = simulateRpcInvoke("poll");
    assert.equal(result.success, false);
    assert.ok(result.txHash.length > 0, "txHash must be preserved after broadcast");
    assert.equal(result.txHash, RpcTimeout.pollExhausted.txHash);
    assert.match(result.error, /timed out/i);
    assert.match(result.error, /congested/i);
  });

  test("D-8 [RESPONSE] health timeout → degraded HTTP status (503)", () => {
    assert.equal(RpcTimeout.healthCheckTimeout.expectedHttpStatus, 503);
    assert.equal(RpcTimeout.healthCheckTimeout.expectedBody.status, "degraded");
  });

  test("D-9 [RESPONSE] simulate + send timeouts have empty txHash (not broadcast)", () => {
    assert.equal(simulateRpcInvoke("simulate").txHash, "");
    assert.equal(simulateRpcInvoke("send").txHash,     "");
  });

  test("D-10 [RESPONSE] poll-exhausted error message includes the total budget seconds", () => {
    const result = simulateRpcInvoke("poll");
    const budgetSec = Math.round(RpcTimeout.TOTAL_POLL_BUDGET_MS / 1000);
    assert.ok(
      result.error.includes(String(budgetSec)),
      `error must state the timeout budget (${budgetSec}s), got: "${result.error}"`,
    );
  });

  // ── D-11: RECOVERY ───────────────────────────────────────────────────────

  test("D-11 [RECOVERY] after RPC recovers, next invocation returns success=true", () => {
    // Fault
    const faultResult = simulateRpcInvoke("simulate");
    assert.equal(faultResult.success, false);

    // Recovery
    const recoveryResult = simulateRpcInvoke("ok");
    assert.equal(recoveryResult.success, true);
    assert.ok(recoveryResult.txHash.length > 0);
    assert.equal(recoveryResult.error, "");
  });

  test("D-12 [RECOVERY] recovery is independent of which RPC phase timed out", () => {
    for (const phase of ["simulate", "send", "poll"] as RpcPhase[]) {
      const fault = simulateRpcInvoke(phase);
      assert.equal(fault.success, false, `fault phase "${phase}" must fail`);

      const recovery = simulateRpcInvoke("ok");
      assert.equal(recovery.success, true, `recovery after phase "${phase}" must succeed`);
    }
  });

  test("D-13 [RECOVERY] seedMockRpcThatTimesOut rejects all methods then stops", async () => {
    const mock = RpcTimeout.seedMockRpcThatTimesOut(5);
    await assert.rejects(() => mock.simulateTransaction(), /Request timeout/);
    await assert.rejects(() => mock.sendTransaction(),     /Failed to fetch/);
    await assert.rejects(() => mock.getTransaction(),      /Request timeout/);
    await assert.rejects(() => mock.getAccount(),          /Request timeout/);
  });

  test("D-14 [RECOVERY] total poll budget is consistent with per-attempt constants", () => {
    assert.equal(
      RpcTimeout.TOTAL_POLL_BUDGET_MS,
      RpcTimeout.TX_POLL_ATTEMPTS * RpcTimeout.TX_POLL_INTERVAL_MS,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO E: SchemaDrift
//
// Arc:
//   FAULT   → migration file renamed after apply; schema_migrations records
//             old name; file on disk has new name
//   RESPONSE→ migration health state is "drifted"; indexer cannot start safely;
//             health endpoint reports degraded
//   RECOVERY→ migration ledger corrected (old entry removed, new one applied);
//             health state returns to "clean"; indexer can start
//
// Runbook: "Indexer boot: SCHEMA WARNING"
// ═══════════════════════════════════════════════════════════════════════════════

// ── Local adapters: migration state machine ───────────────────────────────────

interface MigrationState {
  filesOnDisk: string[];
  appliedInDb: string[];
}

function computeHealthState(state: MigrationState): {
  healthState: string;
  pending: string[];
  missingOnDisk: string[];
  canStartSafely: boolean;
} {
  const appliedSet = new Set(state.appliedInDb);
  const pending      = state.filesOnDisk.filter((f) => !appliedSet.has(f));
  const missingOnDisk = state.appliedInDb.filter((f) => !state.filesOnDisk.includes(f));

  let healthState: string;
  if (state.appliedInDb.length === 0 && state.filesOnDisk.length > 0) {
    healthState = "uninitialized";
  } else if (pending.length > 0 && missingOnDisk.length > 0) {
    healthState = "partial";
  } else if (missingOnDisk.length > 0) {
    healthState = "drifted";
  } else if (pending.length > 0) {
    healthState = "pending";
  } else {
    healthState = "clean";
  }

  return {
    healthState,
    pending,
    missingOnDisk,
    canStartSafely: healthState === "clean" || healthState === "pending",
  };
}

/** Simulates the repair action: remove the stale DB entry and apply the renamed file. */
function repairSchemaDrift(state: MigrationState, oldFilename: string, newFilename: string): MigrationState {
  return {
    filesOnDisk: state.filesOnDisk,
    appliedInDb: state.appliedInDb
      .filter((f) => f !== oldFilename)
      .concat(newFilename),
  };
}

describe("Scenario E: SchemaDrift — fault → response → recovery", () => {
  // ── E-1: FAULT INJECTION ─────────────────────────────────────────────────

  test("E-1 [FAULT] renamed file is absent from disk files", () => {
    const filesOnDisk = SchemaDrift.seedFilesOnDisk();
    assert.ok(
      !filesOnDisk.includes(SchemaDrift.APPLIED_FILENAME),
      "original filename must NOT appear on disk after rename",
    );
  });

  test("E-2 [FAULT] original filename is still recorded in schema_migrations", () => {
    const appliedInDb = SchemaDrift.seedAppliedInDb();
    assert.ok(
      appliedInDb.includes(SchemaDrift.APPLIED_FILENAME),
      "original filename must still be in DB applied list",
    );
  });

  test("E-3 [FAULT] renamed file IS present on disk", () => {
    const filesOnDisk = SchemaDrift.seedFilesOnDisk();
    assert.ok(
      filesOnDisk.includes(SchemaDrift.RENAMED_FILENAME),
      "renamed file must appear in on-disk list",
    );
  });

  // ── E-4: SERVICE RESPONSE ─────────────────────────────────────────────────

  test("E-4 [RESPONSE] health state is 'drifted' for the fault scenario", () => {
    const state: MigrationState = {
      filesOnDisk: SchemaDrift.seedFilesOnDisk(),
      appliedInDb: SchemaDrift.seedAppliedInDb(),
    };
    const { healthState } = computeHealthState(state);
    assert.equal(
      healthState,
      SchemaDrift.expectedBehaviour.healthState,
      "drifted migration must produce 'drifted' health state",
    );
  });

  test("E-5 [RESPONSE] canStartSafely is false in drifted state", () => {
    const state: MigrationState = {
      filesOnDisk: SchemaDrift.seedFilesOnDisk(),
      appliedInDb: SchemaDrift.seedAppliedInDb(),
    };
    const { canStartSafely } = computeHealthState(state);
    assert.equal(
      canStartSafely,
      SchemaDrift.expectedBehaviour.canStartSafely,
    );
    assert.equal(canStartSafely, false);
  });

  test("E-6 [RESPONSE] missingOnDisk contains the original filename", () => {
    const state: MigrationState = {
      filesOnDisk: SchemaDrift.seedFilesOnDisk(),
      appliedInDb: SchemaDrift.seedAppliedInDb(),
    };
    const { missingOnDisk } = computeHealthState(state);
    assert.ok(
      missingOnDisk.includes(SchemaDrift.APPLIED_FILENAME),
      "missingOnDisk must name the file that was renamed away",
    );
  });

  test("E-7 [RESPONSE] pending contains the renamed file (new name not yet applied)", () => {
    const state: MigrationState = {
      filesOnDisk: SchemaDrift.seedFilesOnDisk(),
      appliedInDb: SchemaDrift.seedAppliedInDb(),
    };
    const { pending } = computeHealthState(state);
    assert.ok(
      pending.includes(SchemaDrift.RENAMED_FILENAME),
      "renamed file must appear as pending — it has not been applied under its new name",
    );
  });

  test("E-8 [RESPONSE] expectedBehaviour.summaryContains strings are present in a generated summary", () => {
    const { missingOnDisk } = computeHealthState({
      filesOnDisk: SchemaDrift.seedFilesOnDisk(),
      appliedInDb: SchemaDrift.seedAppliedInDb(),
    });
    const summary =
      `Schema has drifted: ${missingOnDisk.length} migration(s) recorded as applied in ` +
      `schema_migrations but no longer present on disk: ${missingOnDisk.join(", ")}. ` +
      `This usually means a migration file was renamed or deleted after it ran.`;

    for (const fragment of SchemaDrift.expectedBehaviour.summaryContains) {
      assert.ok(
        summary.includes(fragment),
        `summary must contain "${fragment}"`,
      );
    }
  });

  // ── E-9: RECOVERY ────────────────────────────────────────────────────────

  test("E-9 [RECOVERY] after repair, health state is 'clean'", () => {
    const faultState: MigrationState = {
      filesOnDisk: SchemaDrift.seedFilesOnDisk(),
      appliedInDb: SchemaDrift.seedAppliedInDb(),
    };

    const repairedState = repairSchemaDrift(
      faultState,
      SchemaDrift.APPLIED_FILENAME,
      SchemaDrift.RENAMED_FILENAME,
    );

    const { healthState, canStartSafely } = computeHealthState(repairedState);
    assert.equal(healthState, "clean", "repaired state must be 'clean'");
    assert.equal(canStartSafely, true, "indexer must be able to start safely after repair");
  });

  test("E-10 [RECOVERY] after repair, missingOnDisk and pending are both empty", () => {
    const faultState: MigrationState = {
      filesOnDisk: SchemaDrift.seedFilesOnDisk(),
      appliedInDb: SchemaDrift.seedAppliedInDb(),
    };

    const repairedState = repairSchemaDrift(
      faultState,
      SchemaDrift.APPLIED_FILENAME,
      SchemaDrift.RENAMED_FILENAME,
    );

    const { pending, missingOnDisk } = computeHealthState(repairedState);
    assert.equal(pending.length, 0,      "no pending migrations after repair");
    assert.equal(missingOnDisk.length, 0, "no missing-on-disk migrations after repair");
  });

  test("E-11 [RECOVERY] repair is idempotent — applying it twice yields the same state", () => {
    const faultState: MigrationState = {
      filesOnDisk: SchemaDrift.seedFilesOnDisk(),
      appliedInDb: SchemaDrift.seedAppliedInDb(),
    };

    const once  = repairSchemaDrift(faultState, SchemaDrift.APPLIED_FILENAME, SchemaDrift.RENAMED_FILENAME);
    const twice = repairSchemaDrift(once,       SchemaDrift.APPLIED_FILENAME, SchemaDrift.RENAMED_FILENAME);

    assert.deepEqual(
      computeHealthState(once),
      computeHealthState(twice),
      "applying repair twice must produce the same health state",
    );
  });

  test("E-12 [RECOVERY] applied row fixture has no secret-key content", () => {
    const row = SchemaDrift.seedAppliedRow();
    assert.doesNotMatch(row.filename, /secret|key|mnemonic|passphrase/i);
    assert.doesNotMatch(row.applied_at, /secret|key|mnemonic|passphrase/i);
  });

  test("E-13 [RECOVERY] recovered state does not regress to drifted on re-check", () => {
    const faultState: MigrationState = {
      filesOnDisk: SchemaDrift.seedFilesOnDisk(),
      appliedInDb: SchemaDrift.seedAppliedInDb(),
    };

    const repaired = repairSchemaDrift(
      faultState,
      SchemaDrift.APPLIED_FILENAME,
      SchemaDrift.RENAMED_FILENAME,
    );

    // Run health check three times on the repaired state
    for (let i = 0; i < 3; i++) {
      const { healthState } = computeHealthState(repaired);
      assert.equal(
        healthState,
        "clean",
        `re-check ${i + 1}: repaired state must remain 'clean'`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CROSS-SCENARIO INVARIANTS (C + D + E)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Cross-scenario invariants (C + D + E)", () => {
  test("wallet errors, RPC timeouts, and schema drift are independent faults", () => {
    // Each fault can exist without the others — verify their fixture seeds are
    // structurally independent (no shared mutable state).
    const walletCtx   = WalletRejection.seedInvokeContext();
    const mockRpc     = RpcTimeout.seedMockRpcThatTimesOut(1);
    const schemaRow   = SchemaDrift.seedAppliedRow();

    // Different concern: wallet address vs RPC methods vs migration filename
    assert.ok(walletCtx.walletAddress.length > 0);
    assert.ok(typeof mockRpc.simulateTransaction === "function");
    assert.ok(schemaRow.filename.length > 0);

    // None of them share addresses or hashes
    assert.notEqual(walletCtx.contractId, schemaRow.filename);
  });

  test("recovery from any single fault does not affect other fault states", () => {
    // Wallet recovery
    const walletRecovery = simulateWalletInvoke(true, null);
    assert.equal(walletRecovery.success, true);

    // RPC recovery
    const rpcRecovery = simulateRpcInvoke("ok");
    assert.equal(rpcRecovery.success, true);

    // Schema recovery
    const schemaFaultState: MigrationState = {
      filesOnDisk: SchemaDrift.seedFilesOnDisk(),
      appliedInDb: SchemaDrift.seedAppliedInDb(),
    };
    const repaired = repairSchemaDrift(
      schemaFaultState,
      SchemaDrift.APPLIED_FILENAME,
      SchemaDrift.RENAMED_FILENAME,
    );
    const { healthState } = computeHealthState(repaired);
    assert.equal(healthState, "clean");

    // Recovering from one does not influence the others' fixture state
    const stillDrifted = computeHealthState(schemaFaultState);
    assert.equal(stillDrifted.healthState, "drifted", "original fault state must be unchanged");
  });

  test("all fixture addresses across C/D/E are synthetic (no S-prefix secret keys)", () => {
    const addresses = [
      WalletRejection.seedInvokeContext().walletAddress,
      WalletRejection.seedInvokeContext().contractId,
    ];
    for (const addr of addresses) {
      assert.doesNotMatch(addr, /^S/, `"${addr}" must not be a secret key`);
    }
  });

  test("all fixture tx_hashes are synthetic (zero-prefix or f-repeat pattern)", () => {
    const hash = RpcTimeout.pollExhausted.txHash;
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.ok(
      hash.startsWith("0") || hash.startsWith("f"),
      "synthetic hash must start with '0' or 'f'",
    );
  });
});
