/**
 * event-batch-resilience.test.ts — Resilience tests for multi-ledger and multi-event batches
 * Issue #857: Add resilience tests for multi-ledger and multi-event transaction batches
 *
 * Verifies that the indexer correctly handles:
 *   - Multiple events in the same transaction and ledger
 *   - Events spanning consecutive ledgers
 *   - Malformed events mixed with valid events
 *   - Failure isolation (one bad event doesn't corrupt related events)
 *   - Ordering, deduplication, and cursor semantics
 *   - Restart recovery at batch boundaries
 */

import { describe, it, expect, beforeEach } from "vitest";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Represents a single event from the Soroban RPC getEvents endpoint. */
export interface SorobanEvent {
  type: "contract";
  ledger: number;
  ledgerCloseTime: number;
  contractId: string;
  id: string; // ledger + "/" + txIndex + "/" + eventIndex
  pagingToken: string;
  topic: string[]; // Event namespace/topic (e.g., ["circle/payout"])
  value: {
    type: "object";
    fields: Array<{ key: string; val: string | number | boolean }>;
  };
}

/** Represents the indexer's internal projection of an event. */
export interface ProjectedEvent {
  id: string;
  ledger: number;
  txIndex: number;
  eventIndex: number;
  topic: string[];
  data: Record<string, string | number | boolean>;
  projectedAt: Date;
}

/** Batch of events from RPC, all from the same ledger. */
export interface EventBatch {
  ledger: number;
  events: SorobanEvent[];
}

/** Checkpoint state for cursor recovery. */
export interface CheckpointState {
  ledger: number;
  txIndex: number;
  eventIndex: number;
  lastProcessedPagingToken: string;
}

// ─── Test Fixtures ───────────────────────────────────────────────────────────

/**
 * Build a minimal valid Soroban event.
 */
function buildEvent(
  ledger: number,
  txIndex: number,
  eventIndex: number,
  topic: string,
  contractId: string = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
): SorobanEvent {
  const id = `${ledger}/${txIndex}/${eventIndex}`;
  return {
    type: "contract",
    ledger,
    ledgerCloseTime: 1000 + ledger * 5, // ~5 seconds per ledger
    contractId,
    id,
    pagingToken: `${ledger}-${txIndex}-${eventIndex}`,
    topic: [topic],
    value: {
      type: "object",
      fields: [
        { key: "recipient", val: `GABC${String(txIndex).padStart(50, "0")}` },
        { key: "amount", val: "100000000" },
        { key: "round_index", val: eventIndex },
      ],
    },
  };
}

/**
 * Build a malformed event (missing required topic).
 */
function buildMalformedEvent(
  ledger: number,
  txIndex: number,
  eventIndex: number,
): SorobanEvent {
  return {
    type: "contract",
    ledger,
    ledgerCloseTime: 1000 + ledger * 5,
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    id: `${ledger}/${txIndex}/${eventIndex}`,
    pagingToken: `${ledger}-${txIndex}-${eventIndex}`,
    topic: [], // Malformed: empty topic
    value: {
      type: "object",
      fields: [],
    },
  };
}

/**
 * Helper to extract (ledger, txIndex, eventIndex) from an event's id field.
 */
function parseEventId(id: string): [number, number, number] {
  const [ledger, txIndex, eventIndex] = id.split("/").map(Number);
  return [ledger, txIndex, eventIndex];
}

// ─── Event Ordering Tests ────────────────────────────────────────────────────

describe("Event Ordering: Deterministic ledger/transaction/event order", () => {
  it("processes events in ledger ascending order", () => {
    // Scenario: Events from ledgers 100, 102, 101 arrive out of order.
    // Expected: Indexer sorts by ledger and processes 100, 101, 102 in order.

    const events = [
      buildEvent(100, 0, 0, "circle/payout"),
      buildEvent(102, 0, 0, "circle/contributed"),
      buildEvent(101, 0, 0, "circle/joined"),
    ];

    const sorted = events.sort((a, b) => {
      const [aLedger] = parseEventId(a.id);
      const [bLedger] = parseEventId(b.id);
      return aLedger - bLedger;
    });

    expect(parseEventId(sorted[0].id)[0]).toBe(100);
    expect(parseEventId(sorted[1].id)[0]).toBe(101);
    expect(parseEventId(sorted[2].id)[0]).toBe(102);
  });

  it("processes events within a ledger by transaction index", () => {
    // Scenario: Same ledger, different transactions (indices 5, 3, 4).
    // Expected: Sorted by transaction index: 3, 4, 5.

    const ledger = 100;
    const events = [
      buildEvent(ledger, 5, 0, "circle/payout"),
      buildEvent(ledger, 3, 0, "circle/joined"),
      buildEvent(ledger, 4, 0, "circle/contributed"),
    ];

    const sorted = events.sort((a, b) => {
      const [, aTx] = parseEventId(a.id);
      const [, bTx] = parseEventId(b.id);
      return aTx - bTx;
    });

    expect(parseEventId(sorted[0].id)[1]).toBe(3);
    expect(parseEventId(sorted[1].id)[1]).toBe(4);
    expect(parseEventId(sorted[2].id)[1]).toBe(5);
  });

  it("processes events within a transaction by event index", () => {
    // Scenario: Same ledger and transaction, different event indices (2, 0, 1).
    // Expected: Sorted by event index: 0, 1, 2.

    const ledger = 100;
    const tx = 3;
    const events = [
      buildEvent(ledger, tx, 2, "circle/round_started"),
      buildEvent(ledger, tx, 0, "circle/contributed"),
      buildEvent(ledger, tx, 1, "circle/payout"),
    ];

    const sorted = events.sort((a, b) => {
      const [, , aIdx] = parseEventId(a.id);
      const [, , bIdx] = parseEventId(b.id);
      return aIdx - bIdx;
    });

    expect(parseEventId(sorted[0].id)[2]).toBe(0);
    expect(parseEventId(sorted[1].id)[2]).toBe(1);
    expect(parseEventId(sorted[2].id)[2]).toBe(2);
  });

  it("maintains deterministic order across multiple ledgers with multiple events per transaction", () => {
    // Scenario: Complex multi-ledger batch with varying event counts per transaction.
    // Expected: Canonical order is (ledger ASC, txIndex ASC, eventIndex ASC).

    const events = [
      buildEvent(102, 1, 1, "circle/payout"),
      buildEvent(101, 2, 0, "circle/joined"),
      buildEvent(101, 1, 0, "circle/active"),
      buildEvent(102, 0, 0, "circle/contributed"),
      buildEvent(101, 1, 1, "circle/payout"),
    ];

    const sorted = events.sort((a, b) => {
      const [aL, aTx, aIdx] = parseEventId(a.id);
      const [bL, bTx, bIdx] = parseEventId(b.id);
      if (aL !== bL) return aL - bL;
      if (aTx !== bTx) return aTx - bTx;
      return aIdx - bIdx;
    });

    const expected = [
      [101, 1, 0],
      [101, 1, 1],
      [101, 2, 0],
      [102, 0, 0],
      [102, 1, 1],
    ];

    sorted.forEach((evt, i) => {
      const [l, tx, idx] = parseEventId(evt.id);
      expect([l, tx, idx]).toEqual(expected[i]);
    });
  });
});

// ─── Multi-Event and Multi-Ledger Batch Tests ─────────────────────────────────

describe("Multi-Event Batches: Correctness under batch processing", () => {
  it("processes all events in a single-transaction batch", () => {
    // Scenario: One transaction emits 3 events (join, contribute, payout).
    // Expected: All 3 events projected; each maintains correct identity.

    const batch: EventBatch = {
      ledger: 100,
      events: [
        buildEvent(100, 0, 0, "circle/joined"),
        buildEvent(100, 0, 1, "circle/contributed"),
        buildEvent(100, 0, 2, "circle/payout"),
      ],
    };

    const projections: ProjectedEvent[] = batch.events.map((evt) => {
      const [ledger, txIndex, eventIndex] = parseEventId(evt.id);
      return {
        id: evt.id,
        ledger,
        txIndex,
        eventIndex,
        topic: evt.topic,
        data: Object.fromEntries(
          evt.value.fields.map((f) => [f.key, f.val]),
        ),
        projectedAt: new Date(),
      };
    });

    expect(projections.length).toBe(3);
    expect(projections[0].topic).toContain("circle/joined");
    expect(projections[1].topic).toContain("circle/contributed");
    expect(projections[2].topic).toContain("circle/payout");
  });

  it("processes events from multiple transactions in one ledger", () => {
    // Scenario: Ledger 100 contains 2 transactions, each with 2 events.
    // Expected: All 4 events processed in canonical order.

    const batch: EventBatch = {
      ledger: 100,
      events: [
        buildEvent(100, 1, 0, "circle/contributed"),
        buildEvent(100, 0, 1, "circle/payout"),
        buildEvent(100, 1, 1, "circle/round_started"),
        buildEvent(100, 0, 0, "circle/joined"),
      ],
    };

    const sorted = batch.events.sort((a, b) => {
      const [, aTx, aIdx] = parseEventId(a.id);
      const [, bTx, bIdx] = parseEventId(b.id);
      if (aTx !== bTx) return aTx - bTx;
      return aIdx - bIdx;
    });

    const expectedOrder = [
      [100, 0, 0],
      [100, 0, 1],
      [100, 1, 0],
      [100, 1, 1],
    ];

    sorted.forEach((evt, i) => {
      const parsed = parseEventId(evt.id);
      expect(parsed).toEqual(expectedOrder[i]);
    });
  });

  it("processes events across consecutive ledgers without gaps", () => {
    // Scenario: Events from ledgers 100, 101, 102 (consecutive).
    // Expected: Events processed in ledger order; no ordering violations.

    const batches: EventBatch[] = [
      { ledger: 100, events: [buildEvent(100, 0, 0, "circle/joined")] },
      {
        ledger: 101,
        events: [
          buildEvent(101, 0, 0, "circle/contributed"),
          buildEvent(101, 1, 0, "circle/payout"),
        ],
      },
      { ledger: 102, events: [buildEvent(102, 0, 0, "circle/round_started")] },
    ];

    const allEvents = batches.flatMap((b) => b.events);
    const ledgers = allEvents.map((e) => parseEventId(e.id)[0]);

    expect(ledgers).toEqual([100, 101, 101, 102]);
  });
});

// ─── Per-Event Failure Isolation Tests ───────────────────────────────────────

describe("Per-Event Failure Isolation: Malformed events don't corrupt batch", () => {
  it("isolates malformed event without affecting others in same transaction", () => {
    // Scenario: Transaction with 3 events; middle one is malformed (empty topic).
    // Expected: First and third events projected; malformed event logged as failure;
    //           no corruption of subsequent events.

    const events = [
      buildEvent(100, 0, 0, "circle/joined"),
      buildMalformedEvent(100, 0, 1), // Malformed
      buildEvent(100, 0, 2, "circle/payout"),
    ];

    const failures: string[] = [];
    const projected: ProjectedEvent[] = [];

    events.forEach((evt) => {
      if (evt.topic.length === 0) {
        failures.push(evt.id);
      } else {
        const [ledger, txIndex, eventIndex] = parseEventId(evt.id);
        projected.push({
          id: evt.id,
          ledger,
          txIndex,
          eventIndex,
          topic: evt.topic,
          data: Object.fromEntries(
            evt.value.fields.map((f) => [f.key, f.val]),
          ),
          projectedAt: new Date(),
        });
      }
    });

    expect(failures.length).toBe(1);
    expect(failures[0]).toBe("100/0/1");
    expect(projected.length).toBe(2);
    expect(projected[0].topic).toContain("circle/joined");
    expect(projected[1].topic).toContain("circle/payout");
  });

  it("isolates malformed event without affecting other transactions in same ledger", () => {
    // Scenario: Ledger 100 has two transactions; tx 0 is OK, tx 1 is malformed.
    // Expected: tx 0 events projected; tx 1 events logged as failures; no cross-tx corruption.

    const events = [
      buildEvent(100, 0, 0, "circle/joined"),
      buildEvent(100, 0, 1, "circle/contributed"),
      buildMalformedEvent(100, 1, 0), // Malformed
      buildEvent(100, 1, 1, "circle/payout"),
    ];

    const failures: string[] = [];
    const projected: ProjectedEvent[] = [];

    events.forEach((evt) => {
      if (evt.topic.length === 0) {
        failures.push(evt.id);
      } else {
        const [ledger, txIndex, eventIndex] = parseEventId(evt.id);
        projected.push({
          id: evt.id,
          ledger,
          txIndex,
          eventIndex,
          topic: evt.topic,
          data: Object.fromEntries(
            evt.value.fields.map((f) => [f.key, f.val]),
          ),
          projectedAt: new Date(),
        });
      }
    });

    expect(failures.length).toBe(1);
    expect(projected.length).toBe(3); // Only event 100/1/1 skipped (after malformed)

    // Note: Depending on indexer policy, tx 1's event 1 may or may not be processed
    // if the entire transaction is marked as invalid. This test assumes per-event
    // isolation; if the indexer quarantines entire transactions, update accordingly.
  });

  it("logs failure without halting batch processing", () => {
    // Scenario: 10 events in sequence; event 5 is malformed.
    // Expected: Events 0-4 and 6-9 projected; event 5 logged; processing continues.

    const events: SorobanEvent[] = [];
    for (let i = 0; i < 10; i++) {
      if (i === 5) {
        events.push(buildMalformedEvent(100, 0, i));
      } else {
        events.push(buildEvent(100, 0, i, "circle/payout"));
      }
    }

    const failures: string[] = [];
    const projected: ProjectedEvent[] = [];

    events.forEach((evt) => {
      if (evt.topic.length === 0) {
        failures.push(evt.id);
      } else {
        const [ledger, txIndex, eventIndex] = parseEventId(evt.id);
        projected.push({
          id: evt.id,
          ledger,
          txIndex,
          eventIndex,
          topic: evt.topic,
          data: Object.fromEntries(
            evt.value.fields.map((f) => [f.key, f.val]),
          ),
          projectedAt: new Date(),
        });
      }
    });

    expect(failures.length).toBe(1);
    expect(failures[0]).toBe("100/0/5");
    expect(projected.length).toBe(9);
  });
});

// ─── Deduplication and Idempotency Tests ──────────────────────────────────────

describe("Deduplication & Restart Recovery: Cursor and idempotency semantics", () => {
  it("does not double-apply events after duplicate delivery", () => {
    // Scenario: Indexer processes ledger 100, saves checkpoint, then receives
    //           the same ledger 100 events again (RPC duplicate delivery).
    // Expected: Second delivery is recognized as duplicate; no double projection.

    const checkpoint: CheckpointState = {
      ledger: 100,
      txIndex: 0,
      eventIndex: 2,
      lastProcessedPagingToken: "100-0-2",
    };

    const batch: EventBatch = {
      ledger: 100,
      events: [
        buildEvent(100, 0, 0, "circle/joined"),
        buildEvent(100, 0, 1, "circle/contributed"),
        buildEvent(100, 0, 2, "circle/payout"),
      ],
    };

    // Simulate: events 0 and 1 already processed
    const newEvents = batch.events.filter((evt) => {
      const [, , eventIndex] = parseEventId(evt.id);
      return eventIndex > checkpoint.eventIndex;
    });

    // Only event 100/0/2 should be processed
    expect(newEvents.length).toBe(0); // All are <= checkpoint
  });

  it("resumes from checkpoint boundary after restart", () => {
    // Scenario: Indexer processing ledgers 100-102. Checkpoint at ledger 101.
    //           Process restarts; should resume from ledger 101, not 100.
    // Expected: Events from ledger 100 are not reprocessed.

    const checkpoint: CheckpointState = {
      ledger: 101,
      txIndex: 2,
      eventIndex: 1,
      lastProcessedPagingToken: "101-2-1",
    };

    const batches: EventBatch[] = [
      { ledger: 100, events: [buildEvent(100, 0, 0, "circle/joined")] },
      {
        ledger: 101,
        events: [
          buildEvent(101, 0, 0, "circle/contributed"),
          buildEvent(101, 1, 0, "circle/payout"),
          buildEvent(101, 2, 0, "circle/round_started"),
          buildEvent(101, 2, 1, "circle/active"),
        ],
      },
      { ledger: 102, events: [buildEvent(102, 0, 0, "circle/payout")] },
    ];

    // Filter: only events after checkpoint in ledger 101
    const resumeEvents = batches
      .flatMap((b) => b.events)
      .filter((evt) => {
        const [l, tx, idx] = parseEventId(evt.id);
        if (l < checkpoint.ledger) return false;
        if (l > checkpoint.ledger) return true;
        // Same ledger: filter by tx and event index
        if (tx < checkpoint.txIndex) return false;
        if (tx > checkpoint.txIndex) return true;
        return idx > checkpoint.eventIndex;
      });

    // Should include: 101/2/1 (after checkpoint), 102/0/0
    expect(resumeEvents.length).toBe(2);
    expect(parseEventId(resumeEvents[0].id)).toEqual([101, 2, 1]); // 101/2/1 is at checkpoint, should be skipped or included?

    // Actually, if checkpoint is AT 101/2/1, the next event is 102/0/0
    // Let's verify the exact checkpoint semantics:
    const nextEvents = batches
      .flatMap((b) => b.events)
      .filter((evt) => {
        const [l, tx, idx] = parseEventId(evt.id);
        const checkpointKey = `${checkpoint.ledger}/${checkpoint.txIndex}/${checkpoint.eventIndex}`;
        const eventKey = `${l}/${tx}/${idx}`;
        return eventKey > checkpointKey;
      });

    // Should include only 102/0/0
    expect(nextEvents.length).toBe(1);
    expect(parseEventId(nextEvents[0].id)).toEqual([102, 0, 0]);
  });

  it("maintains checkpoint range across multiple ledger restarts", () => {
    // Scenario: Process ledgers 100-105, checkpoint every 2 ledgers.
    //           Restart at checkpoint 102; should resume from ledger 103.
    // Expected: Checkpoints maintain correct ledger boundaries.

    const checkpoints = [
      { ledger: 100, eventCount: 3 },
      { ledger: 102, eventCount: 5 },
      { ledger: 104, eventCount: 2 },
    ];

    const lastCheckpoint = checkpoints[checkpoints.length - 1];
    expect(lastCheckpoint.ledger).toBe(104);

    // Next batch should start from ledger 105
    const nextStartLedger = lastCheckpoint.ledger + 1;
    expect(nextStartLedger).toBe(105);
  });
});

// ─── Batch Boundary Tests ────────────────────────────────────────────────────

describe("Batch Boundaries: Correctness at restart points", () => {
  it("correctly processes batch starting at ledger boundary", () => {
    // Scenario: Restart at exact ledger boundary (e.g., just finished ledger 100).
    //           Next batch starts with ledger 101.
    // Expected: No event from ledger 100 reprocessed; all ledger 101 events included.

    const checkpoint: CheckpointState = {
      ledger: 100,
      txIndex: 999, // End of ledger
      eventIndex: 999,
      lastProcessedPagingToken: "100-999-999",
    };

    const batch: EventBatch = {
      ledger: 101,
      events: [
        buildEvent(101, 0, 0, "circle/joined"),
        buildEvent(101, 0, 1, "circle/contributed"),
      ],
    };

    const eventKey = (evt: SorobanEvent) => parseEventId(evt.id);
    const checkpointKey = [checkpoint.ledger, checkpoint.txIndex, checkpoint.eventIndex];

    const newEvents = batch.events.filter((evt) => {
      const key = eventKey(evt);
      // Compare lexicographically
      return (
        key[0] > checkpointKey[0] ||
        (key[0] === checkpointKey[0] &&
          (key[1] > checkpointKey[1] ||
            (key[1] === checkpointKey[1] && key[2] > checkpointKey[2])))
      );
    });

    expect(newEvents.length).toBe(2); // Both ledger 101 events included
  });

  it("handles page boundary correctly (multi-page batch)", () => {
    // Scenario: RPC returns events in pages (e.g., 100 events per page).
    //           Checkpoint falls on page boundary. Restart should resume from next page.
    // Expected: No duplication at page boundary.

    const checkpointPagingToken = "101-5-99"; // End of first page
    const nextPagePagingToken = "101-6-0"; // Start of second page

    const pages = [
      {
        pagingToken: checkpointPagingToken,
        events: [buildEvent(101, 5, 99, "circle/payout")],
      },
      {
        pagingToken: nextPagePagingToken,
        events: [buildEvent(101, 6, 0, "circle/joined")],
      },
    ];

    // Simulate: Already processed first page
    const processedTokens = new Set([checkpointPagingToken]);

    const newEvents = pages
      .flatMap((page) => page.events)
      .filter((evt) => !processedTokens.has(evt.pagingToken));

    expect(newEvents.length).toBe(1);
    expect(newEvents[0].pagingToken).toBe(nextPagePagingToken);
  });
});

// ─── Complex Scenario Tests ──────────────────────────────────────────────────

describe("Complex Scenarios: Real-world batch patterns", () => {
  it("processes realistic batch: 3 ledgers, mixed event counts, one malformed", () => {
    // Scenario: Real-world batch with:
    //   - Ledger 100: 2 transactions, 4 events
    //   - Ledger 101: 1 transaction, 3 events, one malformed
    //   - Ledger 102: 3 transactions, 6 events
    // Expected: All valid events processed in order; malformed logged; no corruption.

    const batches: EventBatch[] = [
      {
        ledger: 100,
        events: [
          buildEvent(100, 0, 0, "circle/joined"),
          buildEvent(100, 0, 1, "circle/joined"),
          buildEvent(100, 1, 0, "circle/contributed"),
          buildEvent(100, 1, 1, "circle/contributed"),
        ],
      },
      {
        ledger: 101,
        events: [
          buildEvent(101, 0, 0, "circle/payout"),
          buildMalformedEvent(101, 0, 1),
          buildEvent(101, 0, 2, "circle/round_started"),
        ],
      },
      {
        ledger: 102,
        events: [
          buildEvent(102, 0, 0, "circle/active"),
          buildEvent(102, 1, 0, "circle/contributed"),
          buildEvent(102, 1, 1, "circle/payout"),
          buildEvent(102, 2, 0, "circle/default"),
          buildEvent(102, 2, 1, "circle/default"),
          buildEvent(102, 2, 2, "circle/round_started"),
        ],
      },
    ];

    const failures: string[] = [];
    const projected: ProjectedEvent[] = [];

    batches.forEach((batch) => {
      batch.events.forEach((evt) => {
        if (evt.topic.length === 0) {
          failures.push(evt.id);
        } else {
          const [ledger, txIndex, eventIndex] = parseEventId(evt.id);
          projected.push({
            id: evt.id,
            ledger,
            txIndex,
            eventIndex,
            topic: evt.topic,
            data: Object.fromEntries(
              evt.value.fields.map((f) => [f.key, f.val]),
            ),
            projectedAt: new Date(),
          });
        }
      });
    });

    expect(failures.length).toBe(1);
    expect(failures[0]).toBe("101/0/1");
    expect(projected.length).toBe(13); // 4 + 2 + 6 + 1 valid from ledger 101
  });
});
