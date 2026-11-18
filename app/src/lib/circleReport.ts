/**
 * Circle Report export utilities (Issue #844).
 *
 * Generates shareable, read-only reports from validated circle data. Reports are:
 * - Reproducible from public API data (no additional sources)
 * - Print-friendly with minimal styles
 * - Clearly identified with generation time and indexer freshness
 * - Free of wallet secrets and signing data
 */

import type { CircleDetailData } from "@/lib/circleTypes";
import { formatUsdc } from "@/lib/config";

export interface CircleReportData {
  /** Timestamp when the report was generated (ISO-8601) */
  generatedAtMs: number;
  /** Indexer checkpoint time (ISO-8601), or null if unknown */
  checkpointTime: string | null;
  /** Human-readable network name (e.g. "Testnet", "Mainnet") */
  networkName: string;
  /** Circle contract address */
  circleAddress: string;
  /** Formatted report as HTML string */
  html: string;
  /** Plain text version for copy-paste */
  plainText: string;
}

/**
 * Format stroops as USDC with 2 decimal places.
 */
function formatStroops(stroops: string): string {
  try {
    const n = BigInt(stroops.trim() || "0");
    if (n < 0n) return "0.00";
    const units = n / 10_000_000n;
    const frac = n % 10_000_000n;
    const fracStr = frac.toString().padStart(7, "0").slice(0, 2);
    return `${units.toString()}.${fracStr}`;
  } catch {
    return "0.00";
  }
}

/**
 * Short address representation (first 4 + last 4 chars).
 */
function shortAddr(addr: string): string {
  return addr.length > 11
    ? `${addr.slice(0, 4)}…${addr.slice(-4)}`
    : addr;
}

/**
 * Build an HTML report from circle detail data.
 */
export function buildCircleReportHtml(
  data: CircleDetailData,
  circleAddress: string,
  networkName: string,
  generatedAtMs: number,
): string {
  const generatedAt = new Date(generatedAtMs);
  const checkpointTime = data.checkpointTime
    ? new Date(data.checkpointTime).toLocaleString()
    : "Unknown";
  const generatedAtStr = generatedAt.toLocaleString();

  const circle = data.circle;
  const roundAmountUsdc = formatStroops(circle.round_amount);
  const totalPot = (() => {
    try {
      const roundAmount = BigInt(circle.round_amount);
      const memberCount = BigInt(data.members.length);
      const totalStroops = roundAmount * memberCount;
      return formatStroops(totalStroops.toString());
    } catch {
      return "Unknown";
    }
  })();

  const completedRounds = data.rounds || [];
  const currentRoundContributions = data.currentRound?.contributions.length ?? 0;
  const currentRoundTotal = data.members.length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CircleUp Report - ${shortAddr(circleAddress)}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: #1a1a1a;
      background: white;
      padding: 20px;
    }
    .page-break {
      page-break-after: always;
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      margin-bottom: 8px;
      color: #0f0f0f;
    }
    h2 {
      font-size: 16px;
      font-weight: 600;
      margin-top: 20px;
      margin-bottom: 12px;
      color: #1a1a1a;
      border-bottom: 1px solid #e5e7eb;
      padding-bottom: 6px;
    }
    .subtitle {
      font-size: 12px;
      color: #666;
      margin-bottom: 20px;
    }
    .info-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 20px;
    }
    .info-item {
      border-left: 3px solid #e5e7eb;
      padding-left: 12px;
    }
    .info-label {
      font-size: 11px;
      font-weight: 600;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .info-value {
      font-size: 13px;
      color: #1a1a1a;
      word-break: break-all;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
    }
    .status-pending { background-color: #fef3c7; color: #92400e; }
    .status-active { background-color: #dbeafe; color: #1e40af; }
    .status-completed { background-color: #dcfce7; color: #15803d; }
    .status-cancelled { background-color: #fee2e2; color: #991b1b; }
    .status-closed { background-color: #f3f4f6; color: #374151; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
    }
    table thead {
      background-color: #f9fafb;
    }
    table th {
      text-align: left;
      padding: 10px;
      font-size: 12px;
      font-weight: 600;
      color: #666;
      border-bottom: 1px solid #e5e7eb;
    }
    table td {
      padding: 10px;
      font-size: 13px;
      color: #1a1a1a;
      border-bottom: 1px solid #f3f4f6;
    }
    table tr:hover {
      background-color: #fafafa;
    }
    .amount {
      font-family: 'Monaco', 'Courier New', monospace;
      text-align: right;
    }
    .address-mono {
      font-family: 'Monaco', 'Courier New', monospace;
      font-size: 12px;
      word-break: break-all;
    }
    .footer {
      margin-top: 40px;
      padding-top: 12px;
      border-top: 1px solid #e5e7eb;
      font-size: 10px;
      color: #999;
    }
    .advisory {
      background-color: #f9fafb;
      border-left: 3px solid #fbbf24;
      padding: 12px;
      margin: 16px 0;
      font-size: 12px;
      color: #666;
      line-height: 1.5;
    }
    @media print {
      body { padding: 0; }
      .page-break { page-break-after: always; }
    }
  </style>
</head>
<body>
  <h1>CircleUp Circle Report</h1>
  <div class="subtitle">Read-only snapshot from public on-chain and indexed data</div>

  <div class="info-grid">
    <div class="info-item">
      <div class="info-label">Circle Address</div>
      <div class="info-value address-mono">${circleAddress}</div>
    </div>
    <div class="info-item">
      <div class="info-label">Network</div>
      <div class="info-value">${networkName}</div>
    </div>
    <div class="info-item">
      <div class="info-label">Status</div>
      <div class="info-value">
        <span class="status-badge status-${circle.status.toLowerCase()}">
          ${circle.status}
        </span>
      </div>
    </div>
    <div class="info-item">
      <div class="info-label">Creator</div>
      <div class="info-value address-mono">${shortAddr(circle.creator)}</div>
    </div>
  </div>

  <div class="advisory">
    <strong>Data Freshness:</strong> Generated on ${generatedAtStr}. 
    Indexer checkpoint: ${checkpointTime}. 
    This report is derived from indexed data and may lag the chain by one or more ledgers.
  </div>

  <h2>Circle Details</h2>
  <div class="info-grid">
    <div class="info-item">
      <div class="info-label">Members</div>
      <div class="info-value">${data.members.length}</div>
    </div>
    <div class="info-item">
      <div class="info-label">Per-Member Round Contribution</div>
      <div class="info-value amount">${roundAmountUsdc} USDC</div>
    </div>
    <div class="info-item">
      <div class="info-label">Total Pot Size</div>
      <div class="info-value amount">${totalPot} USDC</div>
    </div>
    <div class="info-item">
      <div class="info-label">Current Round</div>
      <div class="info-value">${circle.current_round} of ${circle.total_rounds}</div>
    </div>
    <div class="info-item">
      <div class="info-label">Round Progress</div>
      <div class="info-value">${currentRoundContributions} of ${currentRoundTotal} contributions received</div>
    </div>
  </div>

  ${circle.deadline_ledger != null ? `
  <div class="info-grid">
    <div class="info-item">
      <div class="info-label">Deadline Ledger</div>
      <div class="info-value">${circle.deadline_ledger}</div>
    </div>
  </div>
  ` : ""}

  <h2>Members (${data.members.length})</h2>
  ${data.members.length > 0 ? `
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Address</th>
        <th style="text-align: right;">Payout Order</th>
        <th style="text-align: right;">Collateral</th>
        <th style="text-align: right;">Defaults</th>
        <th style="text-align: right;">Reputation</th>
      </tr>
    </thead>
    <tbody>
      ${data.members.map((m, i) => `
      <tr>
        <td>${i + 1}</td>
        <td class="address-mono">${shortAddr(m.member_address)}</td>
        <td style="text-align: right;">${m.payout_order ?? "—"}</td>
        <td class="amount">${formatStroops(m.collateral || "0")} USDC</td>
        <td style="text-align: right;">${m.defaults || 0}</td>
        <td style="text-align: right;">${m.reputation_score ?? "—"}</td>
      </tr>
      `).join("")}
    </tbody>
  </table>
  ` : "<p>No members yet.</p>"}

  ${data.currentRound && data.currentRound.contributions.length > 0 ? `
  <h2>Current Round Contributions</h2>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Member</th>
        <th class="amount">Amount</th>
        <th>Transaction</th>
      </tr>
    </thead>
    <tbody>
      ${data.currentRound.contributions.map((c, i) => `
      <tr>
        <td>${i + 1}</td>
        <td class="address-mono">${shortAddr(c.member_address)}</td>
        <td class="amount">${formatStroops(c.amount)} USDC</td>
        <td class="address-mono">${shortAddr(c.tx_hash)}</td>
      </tr>
      `).join("")}
    </tbody>
  </table>
  ` : ""}

  ${completedRounds.length > 0 ? `
  <h2>Round History (${completedRounds.length} rounds)</h2>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Status</th>
        <th>Recipient</th>
        <th class="amount">Amount</th>
        <th>Contributions</th>
      </tr>
    </thead>
    <tbody>
      ${completedRounds.map((r, i) => `
      <tr>
        <td>${r.roundIndex}</td>
        <td><span class="status-badge status-${r.status.toLowerCase()}">${r.status}</span></td>
        <td class="address-mono">${shortAddr(r.recipient)}</td>
        <td class="amount">${formatStroops(r.amount)} USDC</td>
        <td style="text-align: right;">${r.contributions.length}</td>
      </tr>
      `).join("")}
    </tbody>
  </table>
  ` : ""}

  <div class="footer">
    <p>
      <strong>Advisory:</strong> This report is derived from validated public data on the 
      ${networkName} network and indexed records. It does not constitute an audit or guarantee 
      of contract state. For definitive circle status, query the smart contract directly or 
      consult the full CircleUp application.
    </p>
    <p style="margin-top: 8px;">
      Generated: ${generatedAtStr} (UTC) | Indexer checkpoint: ${checkpointTime}
    </p>
  </div>
</body>
</html>`;
}

/**
 * Build a plain-text version of the report for copy-paste sharing.
 */
export function buildCircleReportText(
  data: CircleDetailData,
  circleAddress: string,
  networkName: string,
  generatedAtMs: number,
): string {
  const generatedAt = new Date(generatedAtMs);
  const checkpointTime = data.checkpointTime
    ? new Date(data.checkpointTime).toLocaleString()
    : "Unknown";
  const generatedAtStr = generatedAt.toLocaleString();

  const circle = data.circle;
  const roundAmountUsdc = formatStroops(circle.round_amount);
  const totalPot = (() => {
    try {
      const roundAmount = BigInt(circle.round_amount);
      const memberCount = BigInt(data.members.length);
      const totalStroops = roundAmount * memberCount;
      return formatStroops(totalStroops.toString());
    } catch {
      return "Unknown";
    }
  })();

  const currentRoundContributions = data.currentRound?.contributions.length ?? 0;
  const currentRoundTotal = data.members.length;

  const lines: string[] = [
    "╔════════════════════════════════════════════════════════════╗",
    "║ CircleUp Circle Report                                     ║",
    "║ Read-only snapshot from public on-chain and indexed data   ║",
    "╚════════════════════════════════════════════════════════════╝",
    "",
    `Circle Address: ${circleAddress}`,
    `Network: ${networkName}`,
    `Status: ${circle.status}`,
    `Creator: ${circle.creator}`,
    "",
    "─ Circle Details ─",
    `Members: ${data.members.length}`,
    `Per-Member Round Contribution: ${roundAmountUsdc} USDC`,
    `Total Pot Size: ${totalPot} USDC`,
    `Current Round: ${circle.current_round} of ${circle.total_rounds}`,
    `Round Progress: ${currentRoundContributions} of ${currentRoundTotal} contributions received`,
    ...(circle.deadline_ledger != null ? [`Deadline Ledger: ${circle.deadline_ledger}`] : []),
    "",
    "─ Data Freshness ─",
    `Generated: ${generatedAtStr}`,
    `Indexer Checkpoint: ${checkpointTime}`,
    "⚠ This report is derived from indexed data and may lag the chain by one or more ledgers.",
    "",
  ];

  if (data.members.length > 0) {
    lines.push("─ Members ─");
    data.members.forEach((m, i) => {
      lines.push(
        `${i + 1}. ${shortAddr(m.member_address)} ` +
        `(Payout: ${m.payout_order ?? "—"}, ` +
        `Collateral: ${formatStroops(m.collateral || "0")} USDC, ` +
        `Defaults: ${m.defaults || 0}, ` +
        `Rep: ${m.reputation_score ?? "—"})`
      );
    });
    lines.push("");
  }

  if (data.currentRound && data.currentRound.contributions.length > 0) {
    lines.push("─ Current Round Contributions ─");
    data.currentRound.contributions.forEach((c, i) => {
      lines.push(
        `${i + 1}. ${shortAddr(c.member_address)}: ` +
        `${formatStroops(c.amount)} USDC (tx: ${shortAddr(c.tx_hash)})`
      );
    });
    lines.push("");
  }

  if (data.rounds && data.rounds.length > 0) {
    lines.push(`─ Round History (${data.rounds.length} rounds) ─`);
    data.rounds.forEach((r) => {
      lines.push(
        `Round ${r.roundIndex} (${r.status}): ${shortAddr(r.recipient)} ← ` +
        `${formatStroops(r.amount)} USDC (${r.contributions.length} contributions)`
      );
    });
    lines.push("");
  }

  lines.push(
    "─ Advisory ─",
    "This report is derived from validated public data on the " + networkName + " network",
    "and indexed records. It does not constitute an audit or guarantee of contract state.",
    "For definitive circle status, query the smart contract directly.",
    ""
  );

  return lines.join("\n");
}

/**
 * Export circle data as a report (HTML or text).
 */
export function exportCircleReport(
  data: CircleDetailData,
  circleAddress: string,
  networkName: string,
  format: "html" | "text" = "html",
): CircleReportData {
  const generatedAtMs = Date.now();
  return {
    generatedAtMs,
    checkpointTime: data.checkpointTime,
    networkName,
    circleAddress,
    html: buildCircleReportHtml(data, circleAddress, networkName, generatedAtMs),
    plainText: buildCircleReportText(data, circleAddress, networkName, generatedAtMs),
  };
}

/**
 * Trigger a download of the circle report as an HTML file.
 */
export function downloadCircleReportHtml(
  report: CircleReportData,
  circleAddress: string,
): void {
  const filename = `circle-report-${shortAddr(circleAddress).replace("…", "-")}-${new Date(report.generatedAtMs).toISOString().split("T")[0]}.html`;
  const blob = new Blob([report.html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Trigger a download of the circle report as a plain text file.
 */
export function downloadCircleReportText(
  report: CircleReportData,
  circleAddress: string,
): void {
  const filename = `circle-report-${shortAddr(circleAddress).replace("…", "-")}-${new Date(report.generatedAtMs).toISOString().split("T")[0]}.txt`;
  const blob = new Blob([report.plainText], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
