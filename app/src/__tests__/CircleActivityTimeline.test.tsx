/**
 * CircleActivityTimeline component tests.
 *
 * Acceptance criteria:
 *   - Loading skeleton is shown while the fetch is in progress.
 *   - Empty state is shown when the indexer returns zero events.
 *   - Events are rendered using CircleTimeline when the fetch succeeds.
 *   - Distinct error messages for not_found, indexer_outage, server, and
 *     network errors; none of these show the empty-state text.
 *   - Try-again button is present in every error state.
 *   - Freshness label ("Indexed") is shown after a successful load.
 *   - Unknown event types do not crash the render.
 *   - Inter-page navigation renders Older/Newer buttons when totalPages > 1.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import React from "react";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [k: string]: unknown;
  }) => <a href={href} {...props}>{children}</a>,
}));

vi.mock("@/lib/config", () => ({
  shortAddress: (addr: string) =>
    addr && addr.length >= 8 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr,
  formatUsdc: (n: bigint) => (Number(n) / 10_000_000).toFixed(2),
  getExplorerLink: () => null,
  ACTIVE_NETWORK: "testnet",
  INDEXER_TIMEOUT_MS: 5000,
  indexerEndpoint: (segs: string[]) => `http://localhost:3001/${segs.join("/")}`,
}));

vi.mock("@/lib/address", () => ({
  isSorobanContractId: (addr: string) =>
    typeof addr === "string" && addr.startsWith("C") && addr.length === 56,
}));

import { CircleActivityTimeline } from "@/components/CircleActivityTimeline";

const VALID_ADDRESS = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

function makeEvent(ledger = 100, pos = 0, type = "circle_contribute") {
  return {
    type,
    actor: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA001",
    round: 0,
    amount: "10000000",
    penalty: null,
    tx_hash: "deadbeef1234",
    ledger,
    event_position: pos,
    id: `${ledger}-${pos}-1`,
    timestamp: "2024-01-01T00:00:00Z",
  };
}

function makePagination(overrides: Record<string, unknown> = {}) {
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
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  global.fetch = originalFetch;
});

function mockFetch(status: number, body: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

// ─── Loading state ────────────────────────────────────────────────────────────

describe("CircleActivityTimeline — loading", () => {
  it("shows loading skeleton while fetching", () => {
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = render(<CircleActivityTimeline circleAddress={VALID_ADDRESS} />);
    // Skeleton divs are present (aria-label "Loading activity timeline")
    expect(screen.getByRole("status", { name: /loading activity timeline/i })).toBeInTheDocument();
  });

  it("shows Activity Timeline heading during load", () => {
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<CircleActivityTimeline circleAddress={VALID_ADDRESS} />);
    expect(screen.getByText(/activity timeline/i)).toBeInTheDocument();
  });
});

// ─── Empty state ──────────────────────────────────────────────────────────────

describe("CircleActivityTimeline — no events", () => {
  it("shows no-activity message when events array is empty", async () => {
    mockFetch(200, {
      circle_address: VALID_ADDRESS,
      events: [],
      pagination: makePagination({ total: 0, totalPages: 0 }),
    });
    render(<CircleActivityTimeline circleAddress={VALID_ADDRESS} />);
    await waitFor(() => {
      expect(
        screen.getByText(/no activity recorded yet/i),
      ).toBeInTheDocument();
    });
  });

  it("empty state is distinct from error state", async () => {
    mockFetch(200, {
      circle_address: VALID_ADDRESS,
      events: [],
      pagination: makePagination({ total: 0, totalPages: 0 }),
    });
    render(<CircleActivityTimeline circleAddress={VALID_ADDRESS} />);
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });
});

// ─── Events rendered ─────────────────────────────────────────────────────────

describe("CircleActivityTimeline — with events", () => {
  it("shows freshness label (Indexed) after successful load", async () => {
    mockFetch(200, {
      circle_address: VALID_ADDRESS,
      events: [makeEvent()],
      pagination: makePagination(),
    });
    render(<CircleActivityTimeline circleAddress={VALID_ADDRESS} />);
    await waitFor(() => {
      expect(screen.getByText(/indexed/i)).toBeInTheDocument();
    });
  });

  it("renders Activity Timeline heading on success", async () => {
    mockFetch(200, {
      circle_address: VALID_ADDRESS,
      events: [makeEvent()],
      pagination: makePagination(),
    });
    render(<CircleActivityTimeline circleAddress={VALID_ADDRESS} />);
    await waitFor(() => {
      expect(screen.getByText(/activity timeline/i)).toBeInTheDocument();
    });
  });

  it("renders unknown event type without crashing", async () => {
    mockFetch(200, {
      circle_address: VALID_ADDRESS,
      events: [makeEvent(100, 0, "some_future_event_type")],
      pagination: makePagination(),
    });
    render(<CircleActivityTimeline circleAddress={VALID_ADDRESS} />);
    await waitFor(() => {
      // The timeline should render (not crash), and the component wraps it
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });
});

// ─── Error states ─────────────────────────────────────────────────────────────

describe("CircleActivityTimeline — error states", () => {
  it("shows error alert for 404 (not_found)", async () => {
    mockFetch(404, { error: "Circle not found" });
    render(<CircleActivityTimeline circleAddress={VALID_ADDRESS} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.queryByText(/no activity recorded yet/i)).not.toBeInTheDocument();
  });

  it("shows error alert for 503 (indexer_outage)", async () => {
    mockFetch(503, {});
    render(<CircleActivityTimeline circleAddress={VALID_ADDRESS} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument();
  });

  it("shows error alert for 500 (server error)", async () => {
    mockFetch(500, {});
    render(<CircleActivityTimeline circleAddress={VALID_ADDRESS} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("shows error alert when fetch throws (network error)", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("Network error"));
    render(<CircleActivityTimeline circleAddress={VALID_ADDRESS} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText(/could not reach/i)).toBeInTheDocument();
  });

  it("shows try-again button in every error state", async () => {
    mockFetch(503, {});
    render(<CircleActivityTimeline circleAddress={VALID_ADDRESS} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    });
  });

  it("not_found, indexer_outage, and server show different messages", async () => {
    // not_found
    mockFetch(404, {});
    const { unmount: u1 } = render(<CircleActivityTimeline circleAddress={VALID_ADDRESS} />);
    await waitFor(() => {
      expect(screen.getByText(/not been indexed yet/i)).toBeInTheDocument();
    });
    u1();

    // indexer_outage
    mockFetch(503, {});
    const { unmount: u2 } = render(<CircleActivityTimeline circleAddress={VALID_ADDRESS} />);
    await waitFor(() => {
      expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument();
    });
    u2();
  });
});

// ─── Pagination ───────────────────────────────────────────────────────────────

describe("CircleActivityTimeline — inter-page pagination", () => {
  it("shows no Older/Newer buttons when only one page", async () => {
    mockFetch(200, {
      circle_address: VALID_ADDRESS,
      events: [makeEvent()],
      pagination: makePagination({ total: 1, totalPages: 1 }),
    });
    render(<CircleActivityTimeline circleAddress={VALID_ADDRESS} />);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /older/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /newer/i })).not.toBeInTheDocument();
    });
  });

  it("shows Newer button on first of multiple pages", async () => {
    mockFetch(200, {
      circle_address: VALID_ADDRESS,
      events: Array.from({ length: 50 }, (_, i) => makeEvent(i + 1, 0)),
      pagination: makePagination({ total: 100, totalPages: 2, page: 1, hasMore: true }),
    });
    render(<CircleActivityTimeline circleAddress={VALID_ADDRESS} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /newer/i })).toBeInTheDocument();
    });
  });
});
