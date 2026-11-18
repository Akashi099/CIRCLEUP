import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  batchEnd,
  boundedInteger,
  BatchLimitError,
  BackfillInterruptedError,
  runBoundedBackfill,
  type BackfillProgress,
  type BackfillCheckpoint,
} from "./backfill";
import { fetchAllEventsWithPagination } from "./indexer";
import type { SorobanRpc } from "@stellar/stellar-sdk";

const event = (id: string, ledger = 10) => ({ id, ledger }) as SorobanRpc.Api.EventResponse;

// ─── Existing: batch integer caps and pagination guards ───────────────────────

test("batch configuration has hard integer caps", () => {
  assert.equal(batchEnd(10, 1000, 100), 109);
  assert.equal(batchEnd(10, 12, 100), 12);
  for (const value of ["0", "-1", "1.2", "Infinity", "10001", ""])
    assert.throws(() => boundedInteger("ledgers", value, 100, 10000));
});

test("page and event exhaustion fail without exposing a partial batch", async () => {
  const rpc = { getEvents: async () => ({ latestLedger: 100, events: [event("a"), event("b")] }) };
  await assert.rejects(
    fetchAllEventsWithPagination(rpc, { fromLedger: 10, toLedger: 20, filters: [], limit: 2, maxPages: 1 }),
    BatchLimitError,
  );
  await assert.rejects(
    fetchAllEventsWithPagination(rpc, { fromLedger: 10, toLedger: 20, filters: [], limit: 2, maxEvents: 1 }),
    BatchLimitError,
  );
});

test("interrupted fetch restarts from the same ledger and retrieves the full range", async () => {
  const starts: number[] = [];
  let stopped = false;
  const rpc = {
    getEvents: async (req: SorobanRpc.Server.GetEventsRequest) => {
      if (req.startLedger !== undefined) starts.push(req.startLedger);
      if (req.cursor) return { latestLedger: 100, events: [] };
      stopped = true;
      return { latestLedger: 100, events: [event("a"), event("b")] };
    },
  };
  const options = { fromLedger: 10, toLedger: 20, filters: [], limit: 2 };
  await assert.rejects(
    fetchAllEventsWithPagination(rpc, { ...options, shouldStop: () => stopped }),
    /interrupted/,
  );
  const complete = await fetchAllEventsWithPagination(rpc, options);
  assert.deepEqual(starts, [10, 10]);
  assert.equal(complete.length, 2);
});

test("a short final page succeeds even when it uses the last allowed page", async () => {
  const rpc = { getEvents: async () => ({ latestLedger: 100, events: [event("a")] }) };
  assert.equal(
    (await fetchAllEventsWithPagination(rpc, { fromLedger: 10, toLedger: 20, filters: [], limit: 2, maxPages: 1 }))
      .length,
    1,
  );
});

// ─── Issue #852: runBoundedBackfill — progress, checkpoints, interruption ─────

describe("runBoundedBackfill", () => {
  // ── 1. Happy path: processes every batch, advances checkpoint ─────────────

  test("processes the full range in correctly-sized batches", async () => {
    const processed: Array<{ from: number; to: number }> = [];

    const result = await runBoundedBackfill({
      fromLedger: 10,
      toLedger: 29,         // 20 ledgers total
      maxLedgersPerBatch: 7,
      maxEvents: 10_000,
      processBatch: async (from, to) => { processed.push({ from, to }); },
    });

    // Expect batches: [10,16], [17,23], [24,29]
    assert.deepEqual(processed, [
      { from: 10, to: 16 },
      { from: 17, to: 23 },
      { from: 24, to: 29 },
    ]);
    assert.equal(result.durableLedger, 29);
  });

  // ── 2. Checkpoint fires after every batch with the durable ledger ─────────

  test("onCheckpoint fires after each committed batch with the correct ledger", async () => {
    const checkpoints: BackfillCheckpoint[] = [];

    await runBoundedBackfill({
      fromLedger: 1,
      toLedger: 10,
      maxLedgersPerBatch: 3,
      maxEvents: 10_000,
      processBatch: async () => {},
      onCheckpoint: (cp) => checkpoints.push(cp),
    });

    // Batches: [1,3], [4,6], [7,9], [10,10]
    assert.equal(checkpoints.length, 4);
    assert.equal(checkpoints[0].durableLedger, 3);
    assert.equal(checkpoints[1].durableLedger, 6);
    assert.equal(checkpoints[2].durableLedger, 9);
    assert.equal(checkpoints[3].durableLedger, 10);

    // Every checkpoint must carry a valid ISO-8601 timestamp.
    for (const cp of checkpoints) {
      assert.ok(
        !isNaN(new Date(cp.committedAt).getTime()),
        `checkpoint.committedAt must be a valid ISO date: ${cp.committedAt}`,
      );
    }
  });

  // ── 3. onProgress fires before each batch with live metadata ─────────────

  test("onProgress fires before each batch with correct remaining estimate", async () => {
    const snapshots: BackfillProgress[] = [];

    await runBoundedBackfill({
      fromLedger: 100,
      toLedger: 109,         // 10 ledgers, batch size 5 → 2 batches
      maxLedgersPerBatch: 5,
      maxEvents: 10_000,
      processBatch: async () => {},
      onProgress: (p) => snapshots.push(p),
    });

    assert.equal(snapshots.length, 2);

    // First snapshot: before batch [100,104]
    assert.equal(snapshots[0].fromLedger, 100);
    assert.equal(snapshots[0].toLedger, 104);
    assert.equal(snapshots[0].headLedger, 109);
    // remaining = 109 - 99 = 10; estimatedBatches = ceil(10/5) = 2
    assert.equal(snapshots[0].remainingLedgers, 10);
    assert.equal(snapshots[0].estimatedBatches, 2);

    // Second snapshot: before batch [105,109]
    assert.equal(snapshots[1].fromLedger, 105);
    assert.equal(snapshots[1].toLedger, 109);
    assert.equal(snapshots[1].remainingLedgers, 5);  // 109 - 104
    assert.equal(snapshots[1].estimatedBatches, 1);
  });

  // ── 4. Interruption: throws BackfillInterruptedError with durable ledger ──

  test("shouldStop causes BackfillInterruptedError with the last durable ledger", async () => {
    let batchCount = 0;

    await assert.rejects(
      runBoundedBackfill({
        fromLedger: 1,
        toLedger: 20,
        maxLedgersPerBatch: 5,
        maxEvents: 10_000,
        processBatch: async () => { batchCount++; },
        // Stop after the second batch is committed (durable=10)
        shouldStop: () => batchCount >= 2,
      }),
      (err: unknown) => {
        assert.ok(err instanceof BackfillInterruptedError, "must throw BackfillInterruptedError");
        assert.equal(err.durableLedger, 10,
          "durableLedger must be the last committed ledger (10 after two 5-ledger batches)");
        return true;
      },
    );

    // Exactly two batches ran before the stop signal fired.
    assert.equal(batchCount, 2);
  });

  // ── 5. Resume from interrupted checkpoint covers the full range ───────────

  test("resume from an interrupted checkpoint covers the remaining range without gaps", async () => {
    const allProcessed: Array<{ from: number; to: number }> = [];
    let batchCount = 0;

    // First run: interrupted after batch 2 (durable ledger = 10)
    let interruptedAt = -1;
    await assert.rejects(
      runBoundedBackfill({
        fromLedger: 1,
        toLedger: 20,
        maxLedgersPerBatch: 5,
        maxEvents: 10_000,
        processBatch: async (from, to) => {
          batchCount++;
          allProcessed.push({ from, to });
        },
        shouldStop: () => batchCount >= 2,
      }),
      (err: unknown) => {
        assert.ok(err instanceof BackfillInterruptedError);
        interruptedAt = err.durableLedger;
        return true;
      },
    );

    assert.equal(interruptedAt, 10);

    // Second run: resume from durable ledger + 1
    const result = await runBoundedBackfill({
      fromLedger: interruptedAt + 1, // 11
      toLedger: 20,
      maxLedgersPerBatch: 5,
      maxEvents: 10_000,
      processBatch: async (from, to) => { allProcessed.push({ from, to }); },
    });

    assert.equal(result.durableLedger, 20);

    // Combined runs must cover every ledger from 1 to 20 without gaps.
    assert.deepEqual(allProcessed, [
      { from: 1,  to: 5  },
      { from: 6,  to: 10 },
      { from: 11, to: 15 },
      { from: 16, to: 20 },
    ]);
  });

  // ── 6. Failed batch does not advance the durable checkpoint ───────────────

  test("a failed batch propagates the error and leaves checkpoint unchanged", async () => {
    const checkpoints: BackfillCheckpoint[] = [];
    let batchCount = 0;

    await assert.rejects(
      runBoundedBackfill({
        fromLedger: 1,
        toLedger: 15,
        maxLedgersPerBatch: 5,
        maxEvents: 10_000,
        processBatch: async (from, to) => {
          batchCount++;
          if (batchCount === 2) throw new Error("simulated DB failure on batch 2");
        },
        onCheckpoint: (cp) => checkpoints.push(cp),
      }),
      /simulated DB failure/,
    );

    // Only the first batch committed successfully.
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].durableLedger, 5,
      "checkpoint must only reflect the first committed batch");
    assert.equal(batchCount, 2, "two batches attempted before the failure");
  });

  // ── 7. BatchLimitError propagates unchanged ───────────────────────────────

  test("BatchLimitError from processBatch propagates without wrapping", async () => {
    await assert.rejects(
      runBoundedBackfill({
        fromLedger: 1,
        toLedger: 10,
        maxLedgersPerBatch: 5,
        maxEvents: 10_000,
        processBatch: async () => {
          throw new BatchLimitError("event budget exceeded in test");
        },
      }),
      BatchLimitError,
    );
  });

  // ── 8. Empty range returns immediately without calling processBatch ────────

  test("empty range (fromLedger > toLedger) returns without calling processBatch", async () => {
    let called = false;
    const result = await runBoundedBackfill({
      fromLedger: 20,
      toLedger: 10,          // from > to → empty range
      maxLedgersPerBatch: 5,
      maxEvents: 10_000,
      processBatch: async () => { called = true; },
    });

    assert.equal(called, false, "processBatch must not be called for an empty range");
    assert.equal(result.durableLedger, 19,
      "durableLedger must be fromLedger - 1 for an empty range");
  });

  // ── 9. Single-ledger range works correctly ────────────────────────────────

  test("single-ledger range processes exactly one batch", async () => {
    const processed: Array<{ from: number; to: number }> = [];

    const result = await runBoundedBackfill({
      fromLedger: 42,
      toLedger: 42,
      maxLedgersPerBatch: 100,
      maxEvents: 10_000,
      processBatch: async (from, to) => { processed.push({ from, to }); },
    });

    assert.deepEqual(processed, [{ from: 42, to: 42 }]);
    assert.equal(result.durableLedger, 42);
  });

  // ── 10. batchEnd never overshoots the head ────────────────────────────────

  test("batchEnd clamps to head when batch size would overshoot", () => {
    // 1000 ledgers available, batch size 300, start at 850
    // → end should be 1000 (not 850 + 300 - 1 = 1149)
    assert.equal(batchEnd(850, 1000, 300), 1000);
    // Start near end: should use exactly the remaining ledgers
    assert.equal(batchEnd(950, 1000, 300), 1000);
    // Mid-range: should use the full batch size
    assert.equal(batchEnd(100, 1000, 100), 199);
  });
});
