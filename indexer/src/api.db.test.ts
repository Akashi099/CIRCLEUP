/**
 * API integration tests against a real Postgres database.
 *
 * Guarded by DATABASE_URL — skipped entirely when that variable is unset.
 * Applies migrations, seeds isolated projection rows, and exercises each
 * route through supertest so the full SQL + serialisation path is covered.
 *
 * Test isolation strategy:
 *   Every test block uses a unique address prefix to avoid cross-test FK
 *   conflicts.  A shared cleanup helper removes all fixture rows in the
 *   finally block of each test so failures don't contaminate later tests.
 *
 * CI requirement: a Postgres service (e.g. postgres:16-alpine) must be
 * available at DATABASE_URL before these tests run.  See docker-compose.yml
 * for the service definition used in local development.
 *
 * Safety: DATABASE_URL must point at a local or _test/_dev database.
 * The test will abort immediately if it detects a non-local, non-test target
 * to prevent accidentally running destructive migration + seed operations
 * against staging or production.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";

function fixtureContractAddress(label: string): string {
  const seed = createHash("sha256").update(label).digest();
  return StrKey.encodeContract(seed);
}

function fixtureMemberAddress(label: string): string {
  const seed = createHash("sha256").update(label).digest();
  return StrKey.encodeEd25519PublicKey(seed);
}

const hasDb = Boolean(process.env.DATABASE_URL);

if (hasDb) {
  // Fail fast if DATABASE_URL points at a non-local, non-test database.
  // This check runs before any DB connection is opened.
  const { assertLocalDatabase } = require("./db/dbGuard") as typeof import("./db/dbGuard");
  try {
    assertLocalDatabase(process.env.DATABASE_URL, "indexer integration tests");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const request = require("supertest") as typeof import("supertest");
  const { createApp } = require("./api") as typeof import("./api");
  const { runMigrations } = require("./db/migrate") as typeof import("./db/migrate");
  const { pool } = require("./db/pool") as typeof import("./db/pool");

  const app = createApp();

  before(async () => {
    await runMigrations();
  });

  after(async () => {
    await pool.end();
  });

  // ── Helpers ───────────────────────────────────────────────────────────────────

  async function seedCircle(
    address: string,
    opts: {
      creator?: string;
      roundAmount?: number;
      memberCount?: number;
      status?: string;
      currentRound?: number;
      totalRounds?: number;
      createdLedger?: number;
    } = {},
  ) {
    const {
      creator       = fixtureMemberAddress("creator"),
      roundAmount   = 100,
      memberCount   = 2,
      status        = "Active",
      currentRound  = 0,
      totalRounds   = 2,
      createdLedger = 1000,
    } = opts;
    await pool.query(
      `INSERT INTO circles
         (address, creator, round_amount, member_count, status,
          current_round, total_rounds, created_ledger)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (address) DO NOTHING`,
      [address, creator, roundAmount, memberCount, status, currentRound, totalRounds, createdLedger],
    );
  }

  async function seedMember(circleAddress: string, memberAddress: string, payoutOrder = 0) {
    await pool.query(
      `INSERT INTO circle_members (circle_address, member_address, payout_order)
       VALUES ($1, $2, $3)
       ON CONFLICT (circle_address, member_address) DO NOTHING`,
      [circleAddress, memberAddress, payoutOrder],
    );
  }

  async function seedContribution(
    circleAddress: string,
    memberAddress: string,
    roundIndex: number,
    ledger: number,
  ) {
    const txHash = `dbtest-tx-${circleAddress}-${memberAddress}-${roundIndex}`;
    await pool.query(
      `INSERT INTO contributions (circle_address, member_address, round_index, amount, tx_hash, ledger)
       VALUES ($1, $2, $3, 100, $4, $5)
       ON CONFLICT (circle_address, member_address, round_index) DO NOTHING`,
      [circleAddress, memberAddress, roundIndex, txHash, ledger],
    );
  }

  async function seedReputation(memberAddress: string, score: number) {
    await pool.query(
      `INSERT INTO reputation (member_address, score)
       VALUES ($1, $2)
       ON CONFLICT (member_address) DO UPDATE SET score = $2`,
      [memberAddress, score],
    );
  }

  async function cleanCircle(address: string) {
    await pool.query("DELETE FROM contributions WHERE circle_address = $1",  [address]);
    await pool.query("DELETE FROM payouts WHERE circle_address = $1",        [address]);
    await pool.query("DELETE FROM defaults WHERE circle_address = $1",       [address]);
    await pool.query("DELETE FROM circle_members WHERE circle_address = $1", [address]);
    await pool.query("DELETE FROM circles WHERE address = $1",               [address]);
  }

  // ── GET /circles ─────────────────────────────────────────────────────────────

  test("GET /circles returns 200 with pagination envelope", async () => {
    const addr = fixtureContractAddress("list-circle");
    await seedCircle(addr);
    try {
      const res = await request(app).get("/circles");
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.circles), "circles must be an array");
      assert.ok(
        typeof res.body.pagination.total === "number",
        "pagination.total must be a number",
      );
      assert.ok(
        typeof res.body.pagination.page === "number",
        "pagination.page must be a number",
      );
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /circles filters by status", async () => {
    const pending   = fixtureContractAddress("status-pending");
    const completed = fixtureContractAddress("status-completed");
    await seedCircle(pending,   { status: "Pending" });
    await seedCircle(completed, { status: "Completed" });

    try {
      const res = await request(app).get("/circles?status=Pending");
      assert.equal(res.status, 200);
      for (const c of res.body.circles as Array<{ status: string }>) {
        assert.equal(c.status, "Pending", "all returned circles must be Pending");
      }
    } finally {
      await cleanCircle(pending);
      await cleanCircle(completed);
    }
  });

  test("GET /circles returns 400 for invalid status value", async () => {
    const res = await request(app).get("/circles?status=Unknown");
    assert.equal(res.status, 400);
    assert.ok(res.body.error, "error key must be present in 400 response");
  });

  test("GET /circles returns 400 for invalid page parameter", async () => {
    const res = await request(app).get("/circles?page=0");
    assert.equal(res.status, 400);
  });

  test("GET /circles returns 400 for invalid limit parameter", async () => {
    const res = await request(app).get("/circles?limit=999");
    assert.equal(res.status, 400);
  });

  test("GET /circles pagination: page 2 returns the next slice", async () => {
    const addrs = ["page-a", "page-b", "page-c"].map(fixtureContractAddress);
    for (const addr of addrs) await seedCircle(addr, { status: "Pending" });

    try {
      const page1 = await request(app).get("/circles?limit=2&page=1&status=Pending&sort=created_ledger&order=asc");
      const page2 = await request(app).get("/circles?limit=2&page=2&status=Pending&sort=created_ledger&order=asc");

      assert.equal(page1.status, 200);
      assert.equal(page2.status, 200);
      assert.equal(page1.body.circles.length, 2);

      // Page 1 and page 2 must not share the same first address.
      if (page2.body.circles.length > 0) {
        assert.notEqual(
          page1.body.circles[0].address,
          page2.body.circles[0].address,
          "page 2 must start where page 1 ended",
        );
      }
    } finally {
      for (const addr of addrs) await cleanCircle(addr);
    }
  });

  // ── GET /circles/summary ─────────────────────────────────────────────────────

  test("GET /circles/summary returns counts by status with a total", async () => {
    const addr = fixtureContractAddress("summary-circle");
    await seedCircle(addr, { status: "Active" });

    try {
      const res = await request(app).get("/circles/summary");
      assert.equal(res.status, 200);
      assert.ok(typeof res.body.total === "number",    "total must be a number");
      assert.ok(typeof res.body.byStatus === "object", "byStatus must be an object");
      assert.ok("Active" in res.body.byStatus,         "byStatus must include Active key");
      assert.ok(res.body.byStatus["Active"] >= 1,      "Active count must be at least 1");
    } finally {
      await cleanCircle(addr);
    }
  });

  // ── GET /circles/:address ────────────────────────────────────────────────────

  test("GET /circles/:address returns circle detail with members", async () => {
    const addr   = fixtureContractAddress("detail-circle");
    const member = fixtureMemberAddress("detail-member");
    await seedCircle(addr);
    await seedMember(addr, member, 0);

    try {
      const res = await request(app).get(`/circles/${addr}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.circle.address, addr);
      assert.ok(Array.isArray(res.body.members), "members must be an array");
      assert.equal(res.body.members.length, 1,   "must return the seeded member");
      assert.equal(res.body.members[0].member_address, member);
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /circles/:address returns 404 for unknown address", async () => {
    const res = await request(app).get(`/circles/${fixtureContractAddress("unknown-address")}`);
    assert.equal(res.status, 404);
  });

  test("GET /circles/:address returns 400 when address is blank", async () => {
    // Route with whitespace-only segment — express normalises this to an empty
    // segment which the router may 404 or 400 depending on routing layer.
    // We just verify we don't get a 200 with a blank address.
    const res = await request(app).get("/circles/%20");
    assert.notEqual(res.status, 200);
  });

  // ── GET /circles/:address/members ────────────────────────────────────────────

  test("GET /circles/:address/members returns member list with totals", async () => {
    const addr    = fixtureContractAddress("members-circle");
    const member1 = fixtureMemberAddress("members-1");
    const member2 = fixtureMemberAddress("members-2");
    await seedCircle(addr);
    await seedMember(addr, member1, 0);
    await seedMember(addr, member2, 1);

    try {
      const res = await request(app).get(`/circles/${addr}/members`);
      assert.equal(res.status, 200);
      assert.equal(res.body.members.length, 2);
      assert.equal(res.body.totals.memberCount, 2);
      assert.equal(typeof res.body.totals.totalCollateral, "string");
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /circles/:address/members returns 404 for unknown circle", async () => {
    const res = await request(app).get(`/circles/${fixtureContractAddress("no-such-circle")}/members`);
    assert.equal(res.status, 404);
  });

  test("GET /circles/:address/members includes hasContributedCurrentRound per member (#539)", async () => {
    const addr   = fixtureContractAddress("member-has-contributed-circle");
    const member = fixtureMemberAddress("member-has-contributed");
    await seedCircle(addr, { status: "Active", currentRound: 0 });
    await seedMember(addr, member, 0);
    await seedContribution(addr, member, 0, 1001);

    try {
      const res = await request(app).get(`/circles/${addr}/members`);
      assert.equal(res.status, 200);
      const m = res.body.members.find(
        (x: { member_address: string }) => x.member_address === member,
      );
      assert.ok(m, "seeded member must appear in response");
      assert.equal(
        m.has_contributed_current_round,
        true,
        "has_contributed_current_round must be true after contribution in round 0",
      );
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /circles/:address/members reports false hasContributedCurrentRound when not contributed (#539)", async () => {
    const addr   = fixtureContractAddress("member-not-contributed-circle");
    const member = fixtureMemberAddress("member-not-contributed");
    await seedCircle(addr, { status: "Active", currentRound: 0 });
    await seedMember(addr, member, 0);

    try {
      const res = await request(app).get(`/circles/${addr}/members`);
      assert.equal(res.status, 200);
      const m = res.body.members.find(
        (x: { member_address: string }) => x.member_address === member,
      );
      assert.ok(m, "seeded member must appear in response");
      assert.equal(
        m.has_contributed_current_round,
        false,
        "has_contributed_current_round must be false when member has not contributed",
      );
    } finally {
      await cleanCircle(addr);
    }
  });

  // ── GET /members/:member/contributions ───────────────────────────────────────

  test("GET /members/:member/contributions returns empty list for unknown member", async () => {
    const res = await request(app).get(`/members/${fixtureMemberAddress("unknown-member")}/contributions`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.contributions, []);
    assert.equal(res.body.pagination.total, 0);
  });

  test("GET /members/:member/contributions returns contribution history", async () => {
    const addr   = fixtureContractAddress("contributions-circle");
    const member = fixtureMemberAddress("contributions-member");
    await seedCircle(addr);
    await seedMember(addr, member, 0);
    await seedContribution(addr, member, 0, 1001);
    await seedContribution(addr, member, 1, 1002);

    try {
      const res = await request(app).get(`/members/${member}/contributions`);
      assert.equal(res.status, 200);
      assert.equal(res.body.contributions.length, 2);
      assert.equal(res.body.pagination.total, 2);
      assert.equal(res.body.member, member);
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /members/:member/contributions returns totalAmount aggregate (#541)", async () => {
    const addr   = fixtureContractAddress("contribution-amount-circle");
    const member = fixtureMemberAddress("contribution-amount-member");
    await seedCircle(addr);
    await seedMember(addr, member, 0);
    await seedContribution(addr, member, 0, 1001);
    await seedContribution(addr, member, 1, 1002);

    try {
      const res = await request(app).get(`/members/${member}/contributions`);
      assert.equal(res.status, 200);
      assert.ok(
        typeof res.body.totalAmount === "string",
        "totalAmount must be a string (numeric amount)",
      );
      // Two contributions of 100 each = 200
      assert.equal(Number(res.body.totalAmount), 200);
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /members/:member/contributions returns hasMore=false on last page (#541)", async () => {
    const addr   = fixtureContractAddress("contribution-has-more-circle");
    const member = fixtureMemberAddress("contribution-has-more-member");
    await seedCircle(addr);
    await seedMember(addr, member, 0);
    await seedContribution(addr, member, 0, 1001);

    try {
      const res = await request(app).get(`/members/${member}/contributions?limit=10&page=1`);
      assert.equal(res.status, 200);
      assert.equal(res.body.pagination.hasMore, false, "hasMore must be false when total fits on one page");
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /members/:member/contributions paginates correctly", async () => {
    const addr   = fixtureContractAddress("contribution-pagination-circle");
    const member = fixtureMemberAddress("contribution-pagination-member");
    await seedCircle(addr);
    await seedMember(addr, member, 0);
    for (let i = 0; i < 5; i++) {
      await seedContribution(addr, member, i, 2000 + i);
    }

    try {
      const res = await request(app).get(`/members/${member}/contributions?limit=2&page=1`);
      assert.equal(res.status, 200);
      assert.equal(res.body.contributions.length, 2);
      assert.equal(res.body.pagination.total, 5);
      assert.equal(res.body.pagination.totalPages, 3);
      assert.equal(res.body.pagination.hasMore, true, "hasMore must be true when more pages remain");
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /members/:member/contributions filters by ?circle= and returns 404 for unknown circle", async () => {
    const member = fixtureMemberAddress("circle-filter-member");
    const res = await request(app).get(
      `/members/${member}/contributions?circle=${fixtureContractAddress("nonexistent-filter")}`,
    );
    assert.equal(res.status, 404, "unknown ?circle= filter must return 404");
  });

  test("GET /members/:member/contributions returns 400 for invalid limit", async () => {
    const res = await request(app).get(`/members/${fixtureMemberAddress("invalid-limit")}/contributions?limit=abc`);
    assert.equal(res.status, 400);
  });

  // ── GET /reputation/:member ───────────────────────────────────────────────────

  test("GET /reputation/:member returns score 0 and found=false for unknown member", async () => {
    const res = await request(app).get(`/reputation/${fixtureMemberAddress("unknown-reputation")}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.score, 0);
    assert.equal(res.body.found, false);
  });

  test("GET /reputation/:member returns correct score for a known member", async () => {
    const member = fixtureMemberAddress("known-reputation");
    await seedReputation(member, 3);

    try {
      const res = await request(app).get(`/reputation/${member}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.score, 3);
      assert.equal(res.body.found, true);
      assert.equal(res.body.member, member);
    } finally {
      await pool.query("DELETE FROM reputation WHERE member_address = $1", [member]);
    }
  });

  // ── GET /indexer/state ───────────────────────────────────────────────────────

  test("GET /indexer/state returns lastLedger and totalEvents", async () => {
    const res = await request(app).get("/indexer/state");
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.lastLedger === "number",  "lastLedger must be a number");
    assert.ok(typeof res.body.totalEvents === "number", "totalEvents must be a number");
    assert.ok(typeof res.body.updatedAt === "string",   "updatedAt must be a string");
  });

  // ── GET /circles/:address/rounds ─────────────────────────────────────────────

  test("GET /circles/:address/rounds returns 200 with status metadata on every round (issue #529)", async () => {
    const addr    = fixtureContractAddress("round-status-circle");
    const member1 = fixtureMemberAddress("round-status-member-1");
    const member2 = fixtureMemberAddress("round-status-member-2");
    const VALID_STATUSES = new Set(["completed", "current", "cancelled", "open"]);

    // Active 2-member circle: round 0 paid out, round 1 in progress
    await seedCircle(addr, {
      status:       "Active",
      currentRound: 1,
      totalRounds:  2,
    });
    await seedMember(addr, member1, 0);
    await seedMember(addr, member2, 1);

    // Seed contributions for round 0
    await seedContribution(addr, member1, 0, 1001);
    await seedContribution(addr, member2, 0, 1002);

    // Seed the payout for round 0
    await pool.query(
      `INSERT INTO payouts
         (circle_address, recipient, round_index, amount, tx_hash, ledger)
       VALUES ($1, $2, 0, 200, 'dbtest-payout-tx-0', 1010)
       ON CONFLICT DO NOTHING`,
      [addr, member1],
    );

    // Seed a contribution for round 1 (current)
    await seedContribution(addr, member1, 1, 1020);

    try {
      const res = await request(app).get(`/circles/${addr}/rounds`);
      assert.equal(res.status, 200, "rounds endpoint must return 200");

      const { rounds, currentRound, openRounds } = res.body as {
        rounds: Array<Record<string, unknown>>;
        currentRound: Record<string, unknown> | null;
        openRounds: Array<Record<string, unknown>>;
      };

      assert.ok(Array.isArray(rounds), "rounds must be an array");
      assert.ok(Array.isArray(openRounds), "openRounds must be an array");

      // Every completed round must carry status: "completed"
      assert.ok(rounds.length >= 1, "at least one completed round expected");
      for (const round of rounds) {
        assert.ok(
          "status" in round,
          `rounds[${round.roundIndex}] is missing the status field (issue #529)`,
        );
        assert.ok(
          VALID_STATUSES.has(String(round.status)),
          `rounds[${round.roundIndex}].status has invalid value "${round.status}"`,
        );
        assert.equal(
          round.status,
          "completed",
          `rounds[${round.roundIndex}].status must be "completed" for a paid-out round`,
        );
      }

      // currentRound must carry status: "current" for an Active circle
      assert.ok(currentRound !== null, "currentRound must be present for Active circle");
      assert.ok(
        "status" in currentRound!,
        "currentRound is missing the status field (issue #529)",
      );
      assert.ok(
        VALID_STATUSES.has(String(currentRound!.status)),
        `currentRound.status has invalid value "${currentRound!.status}"`,
      );
      assert.equal(
        currentRound!.status,
        "current",
        "currentRound.status must be 'current' for an Active circle",
      );

      // openRounds, if any, must each carry status: "open"
      for (const round of openRounds) {
        assert.ok(
          "status" in round,
          `openRounds[${round.roundIndex}] is missing the status field`,
        );
        assert.equal(round.status, "open");
      }
    } finally {
      await pool.query("DELETE FROM payouts WHERE circle_address = $1", [addr]);
      await cleanCircle(addr);
    }
  });

  test("GET /circles/:address/rounds returns status='cancelled' for currentRound of a Cancelled circle (issue #529)", async () => {
    const addr   = fixtureContractAddress("rounds-cancelled-circle");
    const member = fixtureMemberAddress("rounds-cancelled-member");

    await seedCircle(addr, {
      status:       "Cancelled",
      currentRound: 0,
      totalRounds:  2,
    });
    await seedMember(addr, member, 0);

    try {
      const res = await request(app).get(`/circles/${addr}/rounds`);
      assert.equal(res.status, 200);

      const { currentRound } = res.body as {
        currentRound: Record<string, unknown> | null;
      };

      assert.ok(currentRound !== null, "currentRound must be present for a Cancelled circle");
      assert.ok(
        "status" in currentRound!,
        "currentRound is missing the status field (issue #529)",
      );
      assert.equal(
        currentRound!.status,
        "cancelled",
        "currentRound.status must be 'cancelled' for a Cancelled circle",
      );
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /circles/:address/rounds: 404 for unknown circle", async () => {
    const res = await request(app).get(`/circles/${fixtureContractAddress("no-rounds-circle")}/rounds`);
    assert.equal(res.status, 404);
  });
  test("GET /circles returns 400 for invalid sort field", async () => {
    const res = await request(app).get("/circles?sort=nonexistent_field");
    assert.equal(res.status, 400);
  });

  test("GET /circles returns 400 for invalid order value", async () => {
    const res = await request(app).get("/circles?order=sideways");
    assert.equal(res.status, 400);
  });

  // ── #530 GET /circles/:address/members — stable totals for empty contributions ─

  test("GET /circles/:address/members returns numeric totalContributions=0 when no contributions are seeded", async () => {
    const addr   = fixtureContractAddress("empty-contribution-circle");
    const member = fixtureMemberAddress("empty-contribution-member");
    await seedCircle(addr);
    await seedMember(addr, member, 0);

    try {
      const res = await request(app).get(`/circles/${addr}/members`);
      assert.equal(res.status, 200);
      assert.equal(
        res.body.totals.totalContributions,
        0,
        "totalContributions must be 0 when no contributions are seeded",
      );
      assert.equal(
        typeof res.body.totals.totalContributions,
        "number",
        "totalContributions must be a number, not null or a string",
      );
      assert.equal(
        res.body.members[0].total_contributions,
        0,
        "per-member total_contributions must be 0 (number) when no contributions exist",
      );
      assert.equal(
        typeof res.body.members[0].total_contributions,
        "number",
        "per-member total_contributions must be a number, not a string",
      );
    } finally {
      await cleanCircle(addr);
    }
  });

  // ── #531 GET /indexer/state — entity counts ───────────────────────────────────

  test("GET /indexer/state includes entityCounts with numeric totals and circlesByStatus", async () => {
    const addr = fixtureContractAddress("state-entity-circle");
    await seedCircle(addr, { status: "Active" });

    try {
      const res = await request(app).get("/indexer/state");
      assert.equal(res.status, 200);
      const { entityCounts } = res.body as { entityCounts: Record<string, unknown> };
      assert.ok(
        typeof entityCounts === "object" && entityCounts !== null,
        "entityCounts must be an object",
      );
      assert.equal(typeof entityCounts.circles,       "number", "entityCounts.circles must be a number");
      assert.equal(typeof entityCounts.members,       "number", "entityCounts.members must be a number");
      assert.equal(typeof entityCounts.contributions, "number", "entityCounts.contributions must be a number");
      assert.equal(typeof entityCounts.payouts,       "number", "entityCounts.payouts must be a number");
      assert.equal(typeof entityCounts.defaults,      "number", "entityCounts.defaults must be a number");
      assert.ok(
        typeof entityCounts.circlesByStatus === "object" && entityCounts.circlesByStatus !== null,
        "entityCounts.circlesByStatus must be an object",
      );
      assert.ok(
        (entityCounts.circles as number) >= 1,
        "entityCounts.circles must be at least 1 after seeding",
      );
    } finally {
      await cleanCircle(addr);
    }
  });

  // ── #532 GET /indexer/schema — migration status diagnostics ──────────────────

  test("GET /indexer/schema returns schema state and full migration details", async () => {
    const res = await request(app).get("/indexer/schema");
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.state,          "string",  "state must be a string");
    assert.equal(typeof res.body.summary,        "string",  "summary must be a string");
    assert.equal(typeof res.body.canStartSafely, "boolean", "canStartSafely must be a boolean");
    assert.ok(Array.isArray(res.body.applied),             "applied must be an array");
    assert.ok(Array.isArray(res.body.pending),             "pending must be an array");
    assert.ok(Array.isArray(res.body.missingOnDisk),       "missingOnDisk must be an array");
    assert.ok(Array.isArray(res.body.modified),            "modified must be an array");
    assert.equal(
      res.body.state,
      "clean",
      "schema state must be clean after running all migrations in before()",
    );
    assert.equal(res.body.canStartSafely, true, "canStartSafely must be true when state is clean");
  });

  // ── #533 GET /indexer/schema — 004 migration applied ─────────────────────────

  test("GET /indexer/schema — 004_query_plan_indexes migration is listed as applied", async () => {
    const res = await request(app).get("/indexer/schema");
    assert.equal(res.status, 200);
    const applied = res.body.applied as string[];
    assert.ok(
      applied.some((f: string) => f.startsWith("004")),
      "004_query_plan_indexes migration must appear in the applied list",
    );
  });

  test("bounded histories preserve maximum, final, empty pages and exact wire amounts", async () => {
    const address = fixtureContractAddress("bounded-history");
    const member = fixtureMemberAddress("bounded-history");
    await seedCircle(address);
    try {
      await pool.query(`INSERT INTO contributions (circle_address, member_address, round_index, amount, tx_hash, ledger)
        SELECT $1, $2, n, 9007199254740993, 'bounded-history-' || n, 2000
        FROM generate_series(0, 100) AS n`, [address, member]);
      const first = await request(app).get(`/circles/${address}/history?limit=100`);
      assert.equal(first.status, 200);
      assert.equal(first.body.events.length, 100);
      assert.equal(first.body.events[0].record.amount, "9007199254740993");
      assert.equal(typeof first.body.events[0].record.ledger, "string");
      assert.equal(first.body.pagination.hasMore, true);
      const final = await request(app).get(`/circles/${address}/history?limit=100&page=2`);
      assert.equal(final.body.events.length, 1);
      assert.equal(final.body.pagination.hasMore, false);
      const ids = [...first.body.events, ...final.body.events].map((e: any) => e.record.id);
      assert.equal(new Set(ids).size, 101);
      const empty = await request(app).get(`/circles/${address}/history?limit=100&page=3`);
      assert.deepEqual(empty.body.events, []);
      assert.equal(empty.body.pagination.hasMore, false);
      assert.equal((await request(app).get(`/circles/${address}/history?limit=101`)).status, 400);
      assert.equal((await request(app).get(`/circles/${address}/rounds`)).status, 413);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM contributions WHERE circle_address = $1", [address])).rows[0].count, 101);
    } finally { await cleanCircle(address); }
  });

  // ── GET /members/:member/circles (#dashboard) ─────────────────────────────────

  test("GET /members/:member/circles returns empty list for a member with no circles", async () => {
    const member = fixtureMemberAddress("no-circles-member");
    const res = await request(app).get(`/members/${member}/circles`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.circles, [], "circles must be empty for a member with no memberships");
    assert.equal(res.body.pagination.total, 0);
  });

  test("GET /members/:member/circles returns circles the member belongs to", async () => {
    const addr1  = fixtureContractAddress("member-circles-a");
    const addr2  = fixtureContractAddress("member-circles-b");
    const member = fixtureMemberAddress("member-circles-member");
    await seedCircle(addr1, { status: "Active" });
    await seedCircle(addr2, { status: "Pending" });
    await seedMember(addr1, member, 0);
    await seedMember(addr2, member, 0);

    try {
      const res = await request(app).get(`/members/${member}/circles`);
      assert.equal(res.status, 200);
      assert.equal(res.body.pagination.total, 2, "must find both circles");
      const addresses = res.body.circles.map((c: { circle: { address: string } }) => c.circle.address);
      assert.ok(addresses.includes(addr1), "addr1 must be in result");
      assert.ok(addresses.includes(addr2), "addr2 must be in result");
    } finally {
      await cleanCircle(addr1);
      await cleanCircle(addr2);
    }
  });

  test("GET /members/:member/circles response includes circle and member sub-objects", async () => {
    const addr   = fixtureContractAddress("member-circles-shape");
    const member = fixtureMemberAddress("member-circles-shape-member");
    await seedCircle(addr, { status: "Active" });
    await seedMember(addr, member, 0);

    try {
      const res = await request(app).get(`/members/${member}/circles`);
      assert.equal(res.status, 200);
      assert.equal(res.body.circles.length, 1);
      const item = res.body.circles[0];
      // circle sub-object has the standard circle row fields
      assert.equal(typeof item.circle,          "object", "circle sub-object must be present");
      assert.equal(item.circle.address,         addr,     "circle.address must match");
      assert.equal(typeof item.circle.status,   "string", "circle.status must be a string");
      // member sub-object has participation fields
      assert.equal(typeof item.member,          "object", "member sub-object must be present");
      assert.equal(typeof item.member.collateral, "string", "member.collateral must be a string");
      assert.equal(typeof item.member.defaults,   "number", "member.defaults must be a number");
      assert.equal(
        typeof item.member.total_contributions,
        "number",
        "member.total_contributions must be a number",
      );
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /members/:member/circles filters by ?status=", async () => {
    const addrA  = fixtureContractAddress("member-circles-status-a");
    const addrB  = fixtureContractAddress("member-circles-status-b");
    const member = fixtureMemberAddress("member-circles-status-member");
    await seedCircle(addrA, { status: "Active" });
    await seedCircle(addrB, { status: "Pending" });
    await seedMember(addrA, member, 0);
    await seedMember(addrB, member, 0);

    try {
      const res = await request(app).get(`/members/${member}/circles?status=Active`);
      assert.equal(res.status, 200);
      const addresses = res.body.circles.map((c: { circle: { address: string } }) => c.circle.address);
      assert.ok(addresses.includes(addrA),  "Active circle must be included");
      assert.ok(!addresses.includes(addrB), "Pending circle must be excluded by status filter");
    } finally {
      await cleanCircle(addrA);
      await cleanCircle(addrB);
    }
  });

  test("GET /members/:member/circles returns 400 for invalid address", async () => {
    const res = await request(app).get("/members/not-a-stellar-address/circles");
    assert.equal(res.status, 400);
  });

  test("GET /members/:member/circles returns 400 for invalid status", async () => {
    const member = fixtureMemberAddress("member-circles-bad-status");
    const res = await request(app).get(`/members/${member}/circles?status=NotAStatus`);
    assert.equal(res.status, 400);
  });

  test("GET /members/:member/circles pagination works", async () => {
    const addrs  = ["mc-page-a", "mc-page-b", "mc-page-c"].map(fixtureContractAddress);
    const member = fixtureMemberAddress("member-circles-pagination");
    for (const addr of addrs) {
      await seedCircle(addr);
      await seedMember(addr, member, 0);
    }

    try {
      const page1 = await request(app).get(`/members/${member}/circles?limit=2&page=1`);
      const page2 = await request(app).get(`/members/${member}/circles?limit=2&page=2`);
      assert.equal(page1.status, 200);
      assert.equal(page2.status, 200);
      assert.equal(page1.body.circles.length, 2);
      // Page 1 and page 2 must not share the same first circle
      if (page2.body.circles.length > 0) {
        assert.notEqual(
          page1.body.circles[0].circle.address,
          page2.body.circles[0].circle.address,
          "page 2 must start where page 1 ended",
        );
      }
    } finally {
      for (const addr of addrs) await cleanCircle(addr);
    }
  });

  test("GET /members/:member/circles includes total_contributions for the member", async () => {
    const addr   = fixtureContractAddress("member-circles-contrib");
    const member = fixtureMemberAddress("member-circles-contrib-member");
    await seedCircle(addr, { status: "Active", currentRound: 1 });
    await seedMember(addr, member, 0);
    await seedContribution(addr, member, 0, 1001);
    await seedContribution(addr, member, 1, 1002);

    try {
      const res = await request(app).get(`/members/${member}/circles`);
      assert.equal(res.status, 200);
      const item = res.body.circles.find(
        (c: { circle: { address: string } }) => c.circle.address === addr,
      );
      assert.ok(item, "circle must be in result");
      assert.equal(item.member.total_contributions, 2, "must count both contributions");
    } finally {
      await cleanCircle(addr);
    }
  });

  // ── GET /circles/:address/activity (#timeline) ───────────────────────────────

  test("GET /circles/:address/activity returns 200 with empty events for a circle with no activity", async () => {
    const addr = fixtureContractAddress("activity-empty-circle");
    await seedCircle(addr);
    try {
      const res = await request(app).get(`/circles/${addr}/activity`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.events, [], "events must be empty with no activity");
      assert.equal(res.body.circle_address, addr);
      assert.equal(res.body.pagination.total, 0);
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /circles/:address/activity returns 404 for unknown circle", async () => {
    const res = await request(app).get(
      `/circles/${fixtureContractAddress("activity-unknown-circle")}/activity`,
    );
    assert.equal(res.status, 404);
  });

  test("GET /circles/:address/activity returns events with ledger and type fields", async () => {
    const addr   = fixtureContractAddress("activity-with-events");
    const member = fixtureMemberAddress("activity-with-events-member");
    await seedCircle(addr, { status: "Active", currentRound: 0 });
    await seedMember(addr, member, 0);
    await seedContribution(addr, member, 0, 2000);

    try {
      const res = await request(app).get(`/circles/${addr}/activity`);
      assert.equal(res.status, 200);
      assert.ok(res.body.events.length >= 1, "must have at least one event");
      const ev = res.body.events[0];
      assert.equal(typeof ev.type,           "string",  "type must be a string");
      assert.equal(typeof ev.actor,          "string",  "actor must be a string");
      assert.equal(typeof ev.ledger,         "number",  "ledger must be a number");
      assert.equal(typeof ev.event_position, "number",  "event_position must be a number");
      assert.equal(typeof ev.round,          "number",  "round must be a number");
      assert.equal(typeof ev.id,             "string",  "id must be a string");
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /circles/:address/activity events are ordered by ledger ASC", async () => {
    const addr    = fixtureContractAddress("activity-ordered");
    const member1 = fixtureMemberAddress("activity-ordered-m1");
    const member2 = fixtureMemberAddress("activity-ordered-m2");
    await seedCircle(addr, { status: "Active", currentRound: 0 });
    await seedMember(addr, member1, 0);
    await seedMember(addr, member2, 1);
    await seedContribution(addr, member1, 0, 1000);
    await seedContribution(addr, member2, 0, 2000);

    try {
      const res = await request(app).get(`/circles/${addr}/activity`);
      assert.equal(res.status, 200);
      assert.ok(res.body.events.length >= 2, "must have at least 2 events");
      const ledgers = res.body.events.map((e: { ledger: number }) => e.ledger);
      for (let i = 1; i < ledgers.length; i++) {
        assert.ok(
          ledgers[i] >= ledgers[i - 1],
          `events must be in ascending ledger order: ${ledgers[i - 1]} > ${ledgers[i]}`,
        );
      }
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /circles/:address/activity includes payout event with type=circle_payout", async () => {
    const addr   = fixtureContractAddress("activity-payout");
    const member = fixtureMemberAddress("activity-payout-member");
    await seedCircle(addr, { status: "Active", currentRound: 1, totalRounds: 2 });
    await seedMember(addr, member, 0);
    // Seed a completed payout
    await pool.query(
      `INSERT INTO payouts
         (circle_address, recipient, round_index, amount, tx_hash, ledger)
       VALUES ($1, $2, 0, 200, 'activity-payout-tx', 1500)
       ON CONFLICT DO NOTHING`,
      [addr, member],
    );

    try {
      const res = await request(app).get(`/circles/${addr}/activity`);
      assert.equal(res.status, 200);
      const payout = res.body.events.find(
        (e: { type: string }) => e.type === "circle_payout",
      );
      assert.ok(payout, "payout event must appear in activity feed");
      assert.equal(payout.actor, member, "payout actor must be the recipient");
    } finally {
      await pool.query("DELETE FROM payouts WHERE circle_address = $1", [addr]);
      await cleanCircle(addr);
    }
  });

  test("GET /circles/:address/activity pagination works", async () => {
    const addr   = fixtureContractAddress("activity-pagination");
    const member = fixtureMemberAddress("activity-pagination-member");
    await seedCircle(addr, { status: "Active", currentRound: 5 });
    await seedMember(addr, member, 0);
    for (let i = 0; i < 5; i++) {
      await seedContribution(addr, member, i, 3000 + i);
    }

    try {
      const page1 = await request(app).get(`/circles/${addr}/activity?limit=2&page=1`);
      const page2 = await request(app).get(`/circles/${addr}/activity?limit=2&page=2`);
      assert.equal(page1.status, 200);
      assert.equal(page2.status, 200);
      assert.equal(page1.body.events.length, 2, "page 1 must have 2 events");
      assert.equal(page1.body.pagination.total, 5, "total must be 5");
      assert.equal(page1.body.pagination.hasMore, true, "hasMore must be true on page 1");
      // Pages must not overlap
      if (page2.body.events.length > 0) {
        assert.notEqual(
          page1.body.events[0].id,
          page2.body.events[0].id,
          "pages must not share the same first event",
        );
      }
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /circles/:address/activity returns 400 for invalid limit", async () => {
    const addr = fixtureContractAddress("activity-invalid-limit");
    await seedCircle(addr);
    try {
      const res = await request(app).get(`/circles/${addr}/activity?limit=abc`);
      assert.equal(res.status, 400);
    } finally {
      await cleanCircle(addr);
    }
  });
}
