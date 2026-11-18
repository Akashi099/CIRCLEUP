import { describe, it, expect } from "vitest";
import { buildCircleReportHtml, buildCircleReportText, exportCircleReport } from "./circleReport";
import type { CircleDetailData } from "./circleTypes";

const mockData: CircleDetailData = {
  circle: {
    address: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    creator: "GBBD47UZQ2HSKQ2W7XIVNUP5Z6GVWGJBVNCFVEY2AXWYVGNHTHT7ICBB",
    status: "Active",
    round_amount: "100000000", // 10 USDC
    member_count: 3,
    current_round: 2,
    total_rounds: 12,
    created_ledger: 1000,
    updated_at: "2026-01-15T10:00:00Z",
    deadline_ledger: 2000,
  },
  members: [
    {
      member_address: "GBU2NLGDBW3VDLQGSX2A5YQXQFEDCLW3U4LS7P3VYQMZ5H4FPSMQY32",
      payout_order: 1,
      collateral: "100000000",
      defaults: 0,
      joined_at: "2026-01-10T00:00:00Z",
      reputation_score: 1,
      total_contributions: "300000000",
    },
    {
      member_address: "GCZST3XVCDTUJ76ZAV2HA72KYABJZR5VPR42MHNHOXR24KWBFABTQZQ",
      payout_order: 2,
      collateral: "100000000",
      defaults: 0,
      joined_at: "2026-01-10T00:00:00Z",
      reputation_score: 1,
      total_contributions: "200000000",
    },
    {
      member_address: "GDDKAVKTZK7E2RWY7IJDXSF4EYJ5FYV46SQYYLVQ23M3N27HU46DKUQ",
      payout_order: 3,
      collateral: "100000000",
      defaults: 1,
      joined_at: "2026-01-10T00:00:00Z",
      reputation_score: 0,
      total_contributions: "100000000",
    },
  ],
  rounds: [
    {
      roundIndex: 1,
      status: "completed",
      recipient: "GBBD47UZQ2HSKQ2W7XIVNUP5Z6GVWGJBVNCFVEY2AXWYVGNHTHT7ICBB",
      amount: "300000000",
      txHash: "a".repeat(64),
      contributions: [
        { member_address: "GBU2NLGDBW3VDLQGSX2A5YQXQFEDCLW3U4LS7P3VYQMZ5H4FPSMQY32", amount: "100000000", tx_hash: "b".repeat(64) },
        { member_address: "GCZST3XVCDTUJ76ZAV2HA72KYABJZR5VPR42MHNHOXR24KWBFABTQZQ", amount: "100000000", tx_hash: "c".repeat(64) },
        { member_address: "GDDKAVKTZK7E2RWY7IJDXSF4EYJ5FYV46SQYYLVQ23M3N27HU46DKUQ", amount: "100000000", tx_hash: "d".repeat(64) },
      ],
      defaults: [],
    },
  ],
  currentRound: {
    roundIndex: 2,
    status: "current",
    recipient: "GCZST3XVCDTUJ76ZAV2HA72KYABJZR5VPR42MHNHOXR24KWBFABTQZQ",
    amount: "300000000",
    txHash: null,
    contributions: [
      { member_address: "GBU2NLGDBW3VDLQGSX2A5YQXQFEDCLW3U4LS7P3VYQMZ5H4FPSMQY32", amount: "100000000", tx_hash: "e".repeat(64) },
      { member_address: "GCZST3XVCDTUJ76ZAV2HA72KYABJZR5VPR42MHNHOXR24KWBFABTQZQ", amount: "100000000", tx_hash: "f".repeat(64) },
    ],
    defaults: [],
  },
  openRounds: [],
  pendingDefaults: [],
  latestLedger: 1500,
  checkpointTime: "2026-01-15T10:05:00Z",
};

describe("circleReport", () => {
  const circleAddress = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const networkName = "Testnet";

  describe("buildCircleReportHtml", () => {
    it("generates valid HTML", () => {
      const html = buildCircleReportHtml(mockData, circleAddress, networkName, Date.now());
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("<html");
      expect(html).toContain("</html>");
      expect(html).toContain("<body>");
      expect(html).toContain("</body>");
    });

    it("includes circle status", () => {
      const html = buildCircleReportHtml(mockData, circleAddress, networkName, Date.now());
      expect(html).toContain("Active");
    });

    it("includes member count", () => {
      const html = buildCircleReportHtml(mockData, circleAddress, networkName, Date.now());
      expect(html).toContain("3");
    });

    it("includes member list", () => {
      const html = buildCircleReportHtml(mockData, circleAddress, networkName, Date.now());
      expect(html).toContain("Members");
      // Check for short addresses
      expect(html).toContain("GBBD…ICBB");
    });

    it("excludes secrets and signing data", () => {
      const html = buildCircleReportHtml(mockData, circleAddress, networkName, Date.now());
      expect(html).not.toMatch(/xdr|secret|sign|private|key/i);
    });

    it("includes data freshness notice", () => {
      const html = buildCircleReportHtml(mockData, circleAddress, networkName, Date.now());
      expect(html).toContain("may lag the chain");
    });

    it("includes round history", () => {
      const html = buildCircleReportHtml(mockData, circleAddress, networkName, Date.now());
      expect(html).toContain("Round History");
      expect(html).toContain("completed");
    });
  });

  describe("buildCircleReportText", () => {
    it("generates valid plain text", () => {
      const text = buildCircleReportText(mockData, circleAddress, networkName, Date.now());
      expect(text).toContain("CircleUp Circle Report");
      expect(text).toContain("─");
    });

    it("includes circle status", () => {
      const text = buildCircleReportText(mockData, circleAddress, networkName, Date.now());
      expect(text).toContain("Status: Active");
    });

    it("includes member details", () => {
      const text = buildCircleReportText(mockData, circleAddress, networkName, Date.now());
      expect(text).toContain("Members");
      expect(text).toContain("Defaults:");
    });

    it("excludes secrets and signing data", () => {
      const text = buildCircleReportText(mockData, circleAddress, networkName, Date.now());
      expect(text).not.toMatch(/xdr|secret|sign|private|key/i);
    });

    it("is shareable (no special formatting issues)", () => {
      const text = buildCircleReportText(mockData, circleAddress, networkName, Date.now());
      const lines = text.split("\n");
      expect(lines.length).toBeGreaterThan(10);
    });
  });

  describe("exportCircleReport", () => {
    it("returns both HTML and text formats", () => {
      const report = exportCircleReport(mockData, circleAddress, networkName, "html");
      expect(report.html).toBeTruthy();
      expect(report.plainText).toBeTruthy();
      expect(report.html).toContain("<!DOCTYPE html>");
      expect(report.plainText).toContain("Circle Report");
    });

    it("includes generation timestamp", () => {
      const before = Date.now();
      const report = exportCircleReport(mockData, circleAddress, networkName, "html");
      const after = Date.now();
      expect(report.generatedAtMs).toBeGreaterThanOrEqual(before);
      expect(report.generatedAtMs).toBeLessThanOrEqual(after);
    });

    it("includes indexer checkpoint time", () => {
      const report = exportCircleReport(mockData, circleAddress, networkName, "html");
      expect(report.checkpointTime).toBe(mockData.checkpointTime);
    });

    it("preserves circle address and network", () => {
      const report = exportCircleReport(mockData, circleAddress, networkName, "html");
      expect(report.circleAddress).toBe(circleAddress);
      expect(report.networkName).toBe(networkName);
    });
  });

  describe("formatStroops", () => {
    it("correctly formats stroops as USDC", () => {
      const html = buildCircleReportHtml(mockData, circleAddress, networkName, Date.now());
      // 100000000 stroops = 10.00 USDC
      expect(html).toContain("10.00 USDC");
      // 300000000 stroops = 30.00 USDC
      expect(html).toContain("30.00 USDC");
    });
  });
});
