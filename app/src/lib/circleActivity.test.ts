/**
 * Tests for the circle activity data layer.
 *
 * Acceptance criteria (issue #timeline):
 *   - Invalid addresses are rejected before any fetch.
 *   - Empty event lists are handled (not an error).
 *   - Many events, pagination, and hasMore propagate correctly.
 *   - Indexer outage, server error, and network failure are distinct reasons.
 *   - Unknown event types do not cause parse errors.
 *   - Partial / missing optional fields produce null, not exceptions.
 *   - 404 returns not_found (distinct from indexer_outage / server).
 *   - fetchedAtMs is close to Date.now().
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchCircleActivity } from "./circleActivity";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_ADDRESS   = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const INVALID_ADDRESS = "not-a-contract-address";

function makeEvent(ledger = 100, pos = 0, type = "circle_contribute") {
  return {
    type,
    actor: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA001",
    round: 0,
    amount: "10000000",
    penalty: null,
    tx_hash: "deadbeefdeadbeef",
    ledger,
    event_position: pos,
    id: `${ledger}-${pos}-1`,
    timestamp: "2024-01-01T00:00:00Z",
  };
}

function makePagination(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    page: 1,
    limit: 50,
    total: 1,
    totalPages: 1,
    hasMore: false,
    ...overrides,
  };
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetch(status: number, body: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

// ─── Address validation ───────────────────────────────────────────────────────

describe("fetchCircleActivity — address validation", () => {
  it("returns invalid_address for a non-contract address", async () => {
    const result = await fetchCircleActivity(INVALID_ADDRESS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_address");
  });

  it("does not call fetch for an invalid address", async () => {
    global.fetch = vi.fn();
    await fetchCircleActivity(INVALID_ADDRESS);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns invalid_address for a G-prefixed wallet address", async () => {
    const result = await fetchCircleActivity(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA001",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_address");
  });

  it("proceeds to fetch for a valid C-prefixed contract address", async () => {
    mockFetch(200, {
      circle_address: VALID_ADDRESS,
      events: [],
      pagination: makePagination({ total: 0, totalPages: 0 }),
    });
    const result = await fetchCircleActivity(VALID_ADDRESS);
    expect(result.ok).toBe(true);
  });
});

// ─── Empty events ─────────────────────────────────────────────────────────────

describe("fetchCircleActivity — no events", () => {
  it("returns ok:true with empty events for a 200 with empty array", async () => {
    mockFetch(200, {
      circle_address: VALID_ADDRESS,
      events: [],
      pagination: makePagination({ total: 0, totalPages: 0 }),
    });
    const result = await fetchCircleActivity(VALID_ADDRESS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.events).toHaveLength(0);
    expect(result.data.total).toBe(0);
  });

  it("empty events is distinct from an error state", async () => {
    mockFetch(200, {
      circle_address: VALID_ADDRESS,
      events: [],
      pagination: makePagination({ total: 0, totalPages: 0 }),
    });
    const result = await fetchCircleActivity(VALID_ADDRESS);
    expect(result.ok).toBe(true);
  });
});

// ─── Many events ─────────────────────────────────────────────────────────────

describe("fetchCircleActivity — many events", () => {
  it("parses multiple event entries", async () => {
    const events = [
      makeEvent(100, 0, "circle_contribute"),
      makeEvent(101, 0, "circle_payout"),
      makeEvent(102, 0, "circle_default"),
    ];
    mockFetch(200, {
      circle_address: VALID_ADDRESS,
      events,
      pagination: makePagination({ total: 3 }),
    });
    const result = await fetchCircleActivity(VALID_ADDRESS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.events).toHaveLength(3);
    expect(result.data.total).toBe(3);
  });

  it("preserves ledger and event_position on each entry", async () => {
    const events = [makeEvent(500, 2, "circle_contribute")];
    mockFetch(200, {
      circle_address: VALID_ADDRESS,
      events,
      pagination: makePagination({ total: 1 }),
    });
    const result = await fetchCircleActivity(VALID_ADDRESS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.events[0].ledger).toBe(500);
    expect(result.data.events[0].event_position).toBe(2);
  });

  it("propagates pagination metadata", async () => {
    mockFetch(200, {
      circle_address: VALID_ADDRESS,
      events: [makeEvent()],
      pagination: makePagination({ total: 100, page: 2, totalPages: 2, hasMore: false }),
    });
    const result = await fetchCircleActivity(VALID_ADDRESS, { page: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.page).toBe(2);
    expect(result.data.totalPages).toBe(2);
    expect(result.data.total).toBe(100);
    expect(result.data.hasMore).toBe(false);
  });
});

// ─── Unknown event types ──────────────────────────────────────────────────────

describe("fetchCircleActivity — unknown event types", () => {
  it("does not reject unknown event type strings", async () => {
    const events = [makeEvent(100, 0, "some_future_event_type")];
    mockFetch(200, {
      circle_address: VALID_ADDRESS,
      events,
      pagination: makePagination({ total: 1 }),
    });
    const result = await fetchCircleActivity(VALID_ADDRESS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.events[0].type).toBe("some_future_event_type");
  });

  it("preserves mixed known and unknown event types", async () => {
    const events = [
      makeEvent(100, 0, "circle_contribute"),
      makeEvent(101, 0, "unknown_future"),
    ];
    mockFetch(200, {
      circle_address: VALID_ADDRESS,
      events,
      pagination: makePagination({ total: 2 }),
    });
    const result = await fetchCircleActivity(VALID_ADDRESS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.events).toHaveLength(2);
    const types = result.data.events.map((e) => e.type);
    expect(types).toContain("circle_contribute");
    expect(types).toContain("unknown_future");
  });
});

// ─── Partial / null optional fields ──────────────────────────────────────────

describe("fetchCircleActivity — partial data", () => {
  it("handles events missing optional fields without throwing", async () => {
    // Minimal event with only required fields
    const events = [
      {
        type: "circle_payout",
        actor: "GAAAA",
        round: 0,
        ledger: 200,
        event_position: 0,
        id: "200-0-1",
      },
    ];
    mockFetch(200, {
      circle_address: VALID_ADDRESS,
      events,
      pagination: makePagination({ total: 1 }),
    });
    const result = await fetchCircleActivity(VALID_ADDRESS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const e = result.data.events[0];
    expect(e.amount).toBeNull();
    expect(e.penalty).toBeNull();
    expect(e.tx_hash).toBeNull();
    expect(e.timestamp).toBeNull();
  });
});

// ─── Error states ─────────────────────────────────────────────────────────────

describe("fetchCircleActivity — error states", () => {
  it("returns not_found for 404", async () => {
    mockFetch(404, { error: "Circle not found" });
    const result = await fetchCircleActivity(VALID_ADDRESS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
  });

  it("returns indexer_outage for 503", async () => {
    mockFetch(503, {});
    const result = await fetchCircleActivity(VALID_ADDRESS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("indexer_outage");
  });

  it("returns server for 500", async () => {
    mockFetch(500, {});
    const result = await fetchCircleActivity(VALID_ADDRESS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("server");
  });

  it("returns network when fetch throws", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("Network error"));
    const result = await fetchCircleActivity(VALID_ADDRESS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("network");
  });

  it("returns parse when body is not an object", async () => {
    mockFetch(200, "not-an-object");
    const result = await fetchCircleActivity(VALID_ADDRESS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("parse");
  });

  it("returns parse when events field is missing", async () => {
    mockFetch(200, { circle_address: VALID_ADDRESS });
    const result = await fetchCircleActivity(VALID_ADDRESS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("parse");
  });

  it("not_found, indexer_outage, and server are distinct reasons", async () => {
    mockFetch(404, {});
    const r404 = await fetchCircleActivity(VALID_ADDRESS);
    mockFetch(503, {});
    const r503 = await fetchCircleActivity(VALID_ADDRESS);
    mockFetch(500, {});
    const r500 = await fetchCircleActivity(VALID_ADDRESS);

    expect(r404.ok).toBe(false);
    expect(r503.ok).toBe(false);
    expect(r500.ok).toBe(false);

    if (r404.ok || r503.ok || r500.ok) return;
    expect(r404.reason).toBe("not_found");
    expect(r503.reason).toBe("indexer_outage");
    expect(r500.reason).toBe("server");
    expect(r404.reason).not.toBe(r503.reason);
    expect(r503.reason).not.toBe(r500.reason);
  });
});

// ─── Freshness ────────────────────────────────────────────────────────────────

describe("fetchCircleActivity — freshness", () => {
  it("fetchedAtMs is close to Date.now()", async () => {
    mockFetch(200, {
      circle_address: VALID_ADDRESS,
      events: [],
      pagination: makePagination({ total: 0, totalPages: 0 }),
    });
    const before = Date.now();
    const result = await fetchCircleActivity(VALID_ADDRESS);
    const after  = Date.now();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fetchedAtMs).toBeGreaterThanOrEqual(before);
    expect(result.fetchedAtMs).toBeLessThanOrEqual(after + 50);
  });

  it("fetchedAt is a valid ISO-8601 timestamp", async () => {
    mockFetch(200, {
      circle_address: VALID_ADDRESS,
      events: [],
      pagination: makePagination({ total: 0, totalPages: 0 }),
    });
    const result = await fetchCircleActivity(VALID_ADDRESS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Number.isNaN(Date.parse(result.data.fetchedAt))).toBe(false);
  });
});

// ─── AbortSignal ─────────────────────────────────────────────────────────────

describe("fetchCircleActivity — AbortSignal", () => {
  it("returns network error when aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    global.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("Aborted"), { name: "AbortError" }),
    );
    const result = await fetchCircleActivity(VALID_ADDRESS, { signal: ctrl.signal });
    expect(result.ok).toBe(false);
  });
});
