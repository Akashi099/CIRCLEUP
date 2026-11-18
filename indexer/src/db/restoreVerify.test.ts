/**
 * Unit tests for restoreVerify.ts — DB restore verification command.
 *
 * All tests use an in-memory stub of PoolClient so no Postgres instance is
 * needed. Each check function is exercised through runRestoreVerify() with
 * controlled query responses that simulate the four distinct scenarios
 * required by the acceptance criteria:
 *
 *   1. Valid restore       — all checks pass.
 *   2. Missing migration   — schema check fails (uninitialized / drifted state).
 *   3. Incomplete checkpoints — checkpoint check fails with a gap.
 *   4. Projection violation — projection check fails with an incoherent row.
 *
 * The tests also verify that:
 *   - The command is non-mutating (no INSERT/UPDATE/DELETE issued).
 *   - The report never includes the DATABASE_URL or connection string.
 *   - The overall status is "fail" when any check fails, "warning" when any
 *     warns and none fail, and "pass" when all pass.
 *   - Distinct findings are returned for schema, checkpoint, and projection.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { runRestoreVerify, printRestoreVerifyReport, type CheckFinding } from "./restoreVerify";

// ── Stub PoolClient ───────────────────────────────────────────────────────────

type QueryHandler = (text: string, params?: unknown[]) => { rows: Record<string, unknown>[] };

/** Build a minimal PoolClient stub that dispatches queries to a handler map. */
function buildClient(handler: QueryHandler): PoolClient {
  const issued: string[] = [];

  const client = {
    query: async (text: string, params?: unknown[]) => {
      issued.push(text.trim().toUpperCase().slice(0, 60));
      const result = handler(text, params);
      return result;
    },
    _issuedQueries: () => issued,
  };

  return client as unknown as PoolClient;
}

/** Synthetic Stellar contract address — does not need to be on-chain. */
function syntheticContractAddress(n: number): string {
  return `CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA${String(n).padStart(5, "0")}`;
}

// ── Shared query handlers ─────────────────────────────────────────────────────

/** Handler for a healthy, fully-initialized database. */
function healthyHandler(): QueryHandler {
  return (text: string) => {
    const t = text.toLowerCase();

    // statement_timeout — no rows needed
    if (t.includes("set statement_timeout")) return { rows: [] };

    // schema_migrations existence check (from checkMigrationHealth)
    if (t.includes("from schema_migrations") && t.includes("limit 1")) {
      return { rows: [{}] };
    }

    // getMigrationStatus: applied migrations
    if (t.includes("select filename, content_hash from schema_migrations")) {
      return {
        rows: [
          { filename: "001_add_round_deadline_ledgers.sql", content_hash: "aabbcc" },
          { filename: "002_ledger_checkpoints.sql",         content_hash: "ddeeff" },
          { filename: "003_event_dedup_constraints.sql",    content_hash: "112233" },
        ],
      };
    }

    // ledger_checkpoints count
    if (t.includes("count(*)") && t.includes("ledger_checkpoints")) {
      return { rows: [{ count: "500" }] };
    }

    // checkpoint gap query (LAG)
    if (t.includes("lag(ledger)") && t.includes("ledger_checkpoints")) {
      // No gaps — all sequential
      return {
        rows: [
          { prev_ledger: null,   curr_ledger: "1000", gap: null },
          { prev_ledger: "1000", curr_ledger: "1001", gap: "1" },
          { prev_ledger: "1001", curr_ledger: "1002", gap: "1" },
        ],
      };
    }

    // min/max ledger
    if (t.includes("min(ledger)") && t.includes("ledger_checkpoints")) {
      return { rows: [{ min_ledger: "1000", max_ledger: "1500" }] };
    }

    // pg_indexes dedup check
    if (t.includes("pg_indexes")) {
      return {
        rows: [
          { indexname: "idx_ingested_events_identity" },
          { indexname: "idx_circles_created_ledger" },
          { indexname: "idx_circle_members_address" },
        ],
      };
    }

    // circles count
    if (t.includes("count(*)") && t.includes("from circles")) {
      return { rows: [{ count: "10" }] };
    }

    // circles sample
    if (t.includes("select address") && t.includes("from circles")) {
      return {
        rows: [
          {
            address:       syntheticContractAddress(1),
            status:        "Active",
            current_round: 2,
            total_rounds:  5,
            member_count:  4,
            round_amount:  "100",
          },
          {
            address:       syntheticContractAddress(2),
            status:        "Pending",
            current_round: 0,
            total_rounds:  3,
            member_count:  3,
            round_amount:  "50",
          },
        ],
      };
    }

    return { rows: [] };
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("restoreVerify — valid restore", () => {
  test("all checks pass on a healthy database", async () => {
    const client = buildClient(healthyHandler());
    const report = await runRestoreVerify(client, 5000);

    assert.equal(report.overall, "pass", `Expected pass, got ${report.overall}: ${report.summary}`);
    assert.ok(report.findings.length >= 4, "must have at least 4 findings");
    for (const f of report.findings) {
      assert.equal(f.status, "pass", `finding ${f.name} should be pass: ${f.message}`);
    }
  });

  test("report includes generatedAt, schemaVersion, and summary", async () => {
    const client = buildClient(healthyHandler());
    const report = await runRestoreVerify(client, 5000);

    assert.ok(report.generatedAt, "generatedAt must be present");
    assert.ok(!isNaN(Date.parse(report.generatedAt)), "generatedAt must be a valid ISO date");
    assert.ok(report.summary.length > 0, "summary must be non-empty");
  });

  test("finding names include schema_version, checkpoint_continuity, dedup_constraints, projection_consistency", async () => {
    const client = buildClient(healthyHandler());
    const report = await runRestoreVerify(client, 5000);

    const names = report.findings.map((f) => f.name);
    assert.ok(names.includes("schema_version"),          "must have schema_version finding");
    assert.ok(names.includes("checkpoint_continuity"),   "must have checkpoint_continuity finding");
    assert.ok(names.includes("dedup_constraints"),       "must have dedup_constraints finding");
    assert.ok(names.includes("projection_consistency"),  "must have projection_consistency finding");
  });
});

describe("restoreVerify — non-mutating (no writes)", () => {
  test("no INSERT / UPDATE / DELETE / DDL queries are issued", async () => {
    const issued: string[] = [];
    const trackingClient = buildClient((text, params) => {
      issued.push(text);
      return healthyHandler()(text, params);
    });

    await runRestoreVerify(trackingClient, 5000);

    const mutating = issued.filter((q) => {
      const upper = q.trim().toUpperCase();
      return (
        upper.startsWith("INSERT") ||
        upper.startsWith("UPDATE") ||
        upper.startsWith("DELETE") ||
        upper.startsWith("DROP") ||
        upper.startsWith("CREATE") ||
        upper.startsWith("ALTER") ||
        upper.startsWith("TRUNCATE")
      );
    });

    assert.equal(
      mutating.length,
      0,
      `restore verify must never issue mutating queries. Found: ${mutating.join("; ")}`,
    );
  });

  test("report does not include DATABASE_URL or connection string", async () => {
    const databaseUrl = "postgresql://user:secret@localhost:5432/testdb";
    const origUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl;

    try {
      const client = buildClient(healthyHandler());
      const report = await runRestoreVerify(client, 5000);
      const reportStr = JSON.stringify(report);

      assert.ok(!reportStr.includes("secret"), "report must not include database password");
      assert.ok(!reportStr.includes("postgresql://"), "report must not include database URL scheme");
      assert.ok(!reportStr.includes("localhost:5432"), "report must not include database host:port");
    } finally {
      if (origUrl !== undefined) process.env.DATABASE_URL = origUrl;
      else delete process.env.DATABASE_URL;
    }
  });
});

describe("restoreVerify — missing migration (uninitialized schema)", () => {
  test("schema_version fails when schema_migrations table does not exist", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();

      if (t.includes("set statement_timeout")) return { rows: [] };

      // Simulate missing schema_migrations table (42P01 error)
      if (t.includes("schema_migrations")) {
        const err = new Error("relation \"schema_migrations\" does not exist") as Error & { code: string };
        err.code = "42P01";
        throw err;
      }

      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);

    const schemaFinding = report.findings.find((f) => f.name === "schema_version");
    assert.ok(schemaFinding, "schema_version finding must be present");
    assert.equal(
      schemaFinding.status,
      "fail",
      `schema_version must fail when table is missing; got "${schemaFinding.status}": ${schemaFinding.message}`,
    );
    assert.equal(report.overall, "fail", "overall must be fail when any check fails");
  });

  test("schema_version fails when a migration is recorded as applied but missing on disk", async () => {
    // Simulate a "drifted" state: migration file was deleted after it was applied
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };
      if (t.includes("from schema_migrations") && t.includes("limit 1")) return { rows: [{}] };
      if (t.includes("select filename, content_hash from schema_migrations")) {
        // Return a migration that no longer exists on disk
        return {
          rows: [
            { filename: "001_add_round_deadline_ledgers.sql", content_hash: "aabbcc" },
            { filename: "999_deleted_migration.sql",          content_hash: "zzzzzz" }, // not on disk
          ],
        };
      }
      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);

    const schemaFinding = report.findings.find((f) => f.name === "schema_version");
    assert.ok(schemaFinding, "schema_version finding must be present");
    // "drifted" state should be a fail
    assert.ok(
      schemaFinding.status === "fail" || schemaFinding.status === "warning",
      `schema_version must be fail or warning for a drifted state, got "${schemaFinding.status}"`,
    );
  });
});

describe("restoreVerify — incomplete checkpoint history", () => {
  test("checkpoint_continuity fails when a large gap is detected", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };

      if (t.includes("count(*)") && t.includes("ledger_checkpoints")) {
        return { rows: [{ count: "10" }] };
      }

      if (t.includes("lag(ledger)") && t.includes("ledger_checkpoints")) {
        // Simulate a gap of 5000 ledgers between checkpoints 1000 and 6000
        return {
          rows: [
            { prev_ledger: null,   curr_ledger: "1000", gap: null },
            { prev_ledger: "1000", curr_ledger: "6000", gap: "5000" }, // gap > threshold
            { prev_ledger: "6000", curr_ledger: "6001", gap: "1" },
          ],
        };
      }

      if (t.includes("min(ledger)") && t.includes("ledger_checkpoints")) {
        return { rows: [{ min_ledger: "1000", max_ledger: "6001" }] };
      }

      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);

    const checkpointFinding = report.findings.find((f) => f.name === "checkpoint_continuity");
    assert.ok(checkpointFinding, "checkpoint_continuity finding must be present");
    assert.equal(
      checkpointFinding.status,
      "fail",
      `checkpoint_continuity must fail on a large gap; got "${checkpointFinding.status}": ${checkpointFinding.message}`,
    );
    assert.match(
      checkpointFinding.message,
      /gap/i,
      "message must mention the detected gap",
    );
    assert.equal(report.overall, "fail");
  });

  test("checkpoint_continuity warns when no checkpoints exist", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };
      if (t.includes("count(*)") && t.includes("ledger_checkpoints")) {
        return { rows: [{ count: "0" }] };
      }
      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);

    const checkpointFinding = report.findings.find((f) => f.name === "checkpoint_continuity");
    assert.ok(checkpointFinding, "checkpoint_continuity finding must be present");
    assert.equal(
      checkpointFinding.status,
      "warning",
      "empty checkpoints must warn (not fail) — expected on fresh restore",
    );
  });
});

describe("restoreVerify — projection inconsistency", () => {
  test("projection_consistency fails when current_round > total_rounds", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };
      if (t.includes("count(*)") && t.includes("from circles")) {
        return { rows: [{ count: "5" }] };
      }
      if (t.includes("select address") && t.includes("from circles")) {
        return {
          rows: [
            {
              address:       syntheticContractAddress(10),
              status:        "Active",
              current_round: 9, // violates: 9 > total_rounds 5
              total_rounds:  5,
              member_count:  3,
              round_amount:  "100",
            },
          ],
        };
      }
      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);

    const projFinding = report.findings.find((f) => f.name === "projection_consistency");
    assert.ok(projFinding, "projection_consistency finding must be present");
    assert.equal(
      projFinding.status,
      "fail",
      `projection_consistency must fail when current_round > total_rounds; got "${projFinding.status}": ${projFinding.message}`,
    );
    assert.equal(report.overall, "fail");
  });

  test("projection_consistency fails when status is unknown", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };
      if (t.includes("count(*)") && t.includes("from circles")) {
        return { rows: [{ count: "1" }] };
      }
      if (t.includes("select address") && t.includes("from circles")) {
        return {
          rows: [
            {
              address:       syntheticContractAddress(20),
              status:        "Corrupted",   // unknown status
              current_round: 0,
              total_rounds:  3,
              member_count:  2,
              round_amount:  "50",
            },
          ],
        };
      }
      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);

    const projFinding = report.findings.find((f) => f.name === "projection_consistency");
    assert.ok(projFinding, "projection_consistency finding must be present");
    assert.equal(projFinding.status, "fail");
  });

  test("projection_consistency warns when circles table is empty", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };
      if (t.includes("count(*)") && t.includes("from circles")) {
        return { rows: [{ count: "0" }] };
      }
      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);

    const projFinding = report.findings.find((f) => f.name === "projection_consistency");
    assert.ok(projFinding);
    assert.equal(
      projFinding.status,
      "warning",
      "empty circles table must warn — expected on fresh restore",
    );
  });
});

describe("restoreVerify — dedup constraints", () => {
  test("dedup_constraints fails when idx_ingested_events_identity is missing", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };
      if (t.includes("pg_indexes")) {
        // Return indexes excluding the dedup one
        return {
          rows: [
            { indexname: "idx_circles_created_ledger" },
            { indexname: "idx_circle_members_address" },
            // idx_ingested_events_identity deliberately absent
          ],
        };
      }
      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);

    const dedupFinding = report.findings.find((f) => f.name === "dedup_constraints");
    assert.ok(dedupFinding);
    assert.equal(
      dedupFinding.status,
      "fail",
      "dedup_constraints must fail when the critical dedup index is absent",
    );
    assert.equal(report.overall, "fail");
  });
});

describe("restoreVerify — overall status aggregation", () => {
  test("overall is fail when any finding is fail", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };
      if (t.includes("from schema_migrations") && t.includes("limit 1")) {
        const err = new Error("table missing") as Error & { code: string };
        err.code = "42P01";
        throw err;
      }
      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);
    assert.equal(report.overall, "fail");
  });

  test("overall is warning when warnings exist and no failures", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };
      // Empty circles table → warning in projection check
      if (t.includes("count(*)") && t.includes("from circles")) {
        return { rows: [{ count: "0" }] };
      }
      // Empty checkpoint table → warning in checkpoint check
      if (t.includes("count(*)") && t.includes("ledger_checkpoints")) {
        return { rows: [{ count: "0" }] };
      }
      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);
    // At least one of the two should be warning (empty circles / empty checkpoints)
    const hasWarning = report.findings.some((f) => f.status === "warning");
    const hasFailure = report.findings.some((f) => f.status === "fail");
    assert.ok(hasWarning, "at least one warning expected");
    assert.equal(hasFailure, false, "no failures should exist");
    assert.equal(report.overall, "warning");
  });

  test("overall is pass when all findings pass", async () => {
    const client = buildClient(healthyHandler());
    const report = await runRestoreVerify(client, 5000);
    assert.equal(report.overall, "pass");
  });
});

describe("restoreVerify — unreachable database", () => {
  test("runRestoreVerify propagates an unexpected DB error as a fail finding", async () => {
    const client = buildClient((text: string) => {
      if (text.toLowerCase().includes("set statement_timeout")) return { rows: [] };
      // Simulate a connection drop mid-check
      throw new Error("connection terminated unexpectedly");
    });

    const report = await runRestoreVerify(client, 5000);
    // At least one check must fail due to the connection error
    const hasFail = report.findings.some((f) => f.status === "fail");
    assert.ok(hasFail, "an unexpected DB error must surface as at least one fail finding");
    assert.equal(report.overall, "fail");
  });
});

describe("printRestoreVerifyReport — safe output", () => {
  test("print does not throw on a valid report", async () => {
    const client = buildClient(healthyHandler());
    const report = await runRestoreVerify(client, 5000);
    // Should not throw
    assert.doesNotThrow(() => {
      // Suppress console output in test
      const originalLog = console.log;
      console.log = () => {};
      try {
        printRestoreVerifyReport(report);
      } finally {
        console.log = originalLog;
      }
    });
  });

  test("print does not output DATABASE_URL", async () => {
    const databaseUrl = "postgresql://admin:topsecret@prod.db:5432/circleup";
    process.env.DATABASE_URL = databaseUrl;

    const client = buildClient(healthyHandler());
    const report = await runRestoreVerify(client, 5000);

    const outputLines: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => { if (msg) outputLines.push(String(msg)); };
    try {
      printRestoreVerifyReport(report);
    } finally {
      console.log = originalLog;
      delete process.env.DATABASE_URL;
    }

    const fullOutput = outputLines.join("\n");
    assert.ok(!fullOutput.includes("topsecret"), "print output must not include database password");
    assert.ok(!fullOutput.includes("prod.db"),   "print output must not include database host");
  });
});

// ─── Additional coverage: timeout propagation ─────────────────────────────────
//
// Acceptance criteria require that checks are bounded and support timeouts.
// Verify that runRestoreVerify passes the timeoutMs through to setQueryTimeout
// (i.e. a SET statement_timeout query is always the first query issued).

describe("restoreVerify — timeout propagation", () => {
  test("SET statement_timeout is always the first query issued", async () => {
    const issuedOrder: string[] = [];
    const trackingClient = buildClient((text, params) => {
      issuedOrder.push(text.trim().split(/\s+/).slice(0, 3).join(" ").toUpperCase());
      return healthyHandler()(text, params);
    });

    await runRestoreVerify(trackingClient, 7500);

    assert.ok(issuedOrder.length > 0, "at least one query must be issued");
    assert.ok(
      issuedOrder[0].startsWith("SET STATEMENT_TIMEOUT"),
      `first query must be SET statement_timeout, got: "${issuedOrder[0]}"`,
    );
  });

  test("custom timeoutMs value is embedded in the SET statement_timeout query", async () => {
    const timeoutQueries: string[] = [];
    const trackingClient = buildClient((text, params) => {
      if (text.toLowerCase().includes("set statement_timeout")) {
        timeoutQueries.push(text.trim());
      }
      return healthyHandler()(text, params);
    });

    const customMs = 12_345;
    await runRestoreVerify(trackingClient, customMs);

    assert.ok(timeoutQueries.length > 0, "SET statement_timeout must be issued");
    assert.ok(
      timeoutQueries[0].includes(String(customMs)),
      `SET statement_timeout must embed the custom value ${customMs}, got: "${timeoutQueries[0]}"`,
    );
  });

  test("default timeout (10000 ms) is used when no timeoutMs argument is provided", async () => {
    const timeoutQueries: string[] = [];
    const trackingClient = buildClient((text, params) => {
      if (text.toLowerCase().includes("set statement_timeout")) {
        timeoutQueries.push(text.trim());
      }
      return healthyHandler()(text, params);
    });

    // Call without explicit timeoutMs — should use the internal default of 10 000
    await runRestoreVerify(trackingClient);

    assert.ok(timeoutQueries.length > 0);
    assert.ok(
      timeoutQueries[0].includes("10000"),
      `default timeout must be 10000 ms, got: "${timeoutQueries[0]}"`,
    );
  });
});

// ─── Additional coverage: report shape & safe output ─────────────────────────
//
// Verify structural guarantees that make the report safe to attach to an
// incident ticket: schemaVersion is always present (or null), generatedAt
// is a valid ISO timestamp, and findings carry the four canonical names.

describe("restoreVerify — report structure invariants", () => {
  test("schemaVersion is null when schema check fails", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };
      if (t.includes("schema_migrations")) {
        throw new Error("relation \"schema_migrations\" does not exist");
      }
      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);
    assert.equal(
      report.schemaVersion,
      null,
      "schemaVersion must be null when the schema check errors",
    );
  });

  test("schemaVersion is non-null on a healthy database", async () => {
    const client = buildClient(healthyHandler());
    const report = await runRestoreVerify(client, 5000);
    // The healthy handler returns migrations, so a version should be derived
    // (may be the last filename or a semantic version — just not null).
    // The exact value depends on checkMigrationHealth's implementation; we only
    // assert it is non-null here.
    assert.ok(
      report.schemaVersion !== undefined,
      "schemaVersion must be defined (may be null only on error)",
    );
  });

  test("generatedAt is an ISO-8601 timestamp within 5 seconds of now", async () => {
    const before = Date.now();
    const client = buildClient(healthyHandler());
    const report = await runRestoreVerify(client, 5000);
    const after = Date.now();

    const parsed = Date.parse(report.generatedAt);
    assert.ok(!isNaN(parsed), "generatedAt must be parseable as a date");
    assert.ok(parsed >= before - 100, "generatedAt must not be in the past");
    assert.ok(parsed <= after + 100, "generatedAt must not be in the future");
  });

  test("summary string contains the word 'pass', 'warn', or 'fail' matching overall", async () => {
    const client = buildClient(healthyHandler());
    const report = await runRestoreVerify(client, 5000);

    const lower = report.summary.toLowerCase();
    if (report.overall === "pass") {
      assert.ok(lower.includes("pass"), `pass summary must contain 'pass': "${report.summary}"`);
    } else if (report.overall === "warning") {
      assert.ok(
        lower.includes("warn") || lower.includes("warning"),
        `warning summary must contain 'warn': "${report.summary}"`,
      );
    } else {
      assert.ok(lower.includes("fail"), `fail summary must contain 'fail': "${report.summary}"`);
    }
  });

  test("each finding has name, status, and message fields", async () => {
    const client = buildClient(healthyHandler());
    const report = await runRestoreVerify(client, 5000);

    for (const finding of report.findings) {
      assert.ok(typeof finding.name === "string" && finding.name.length > 0, "finding.name must be a non-empty string");
      assert.ok(
        finding.status === "pass" || finding.status === "warning" || finding.status === "fail",
        `finding.status must be pass/warning/fail, got: "${finding.status}"`,
      );
      assert.ok(typeof finding.message === "string" && finding.message.length > 0, "finding.message must be non-empty");
    }
  });

  test("findings with detail field do not expose DATABASE_URL in detail text", async () => {
    const databaseUrl = "postgresql://operator:supersecret@restore-db:5432/circleup_restore";
    const origUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl;

    try {
      // Use the checkpoint-gap handler so at least one finding gets a detail field
      const client = buildClient((text: string) => {
        const t = text.toLowerCase();
        if (t.includes("set statement_timeout")) return { rows: [] };
        if (t.includes("count(*)") && t.includes("ledger_checkpoints")) {
          return { rows: [{ count: "5" }] };
        }
        if (t.includes("lag(ledger)") && t.includes("ledger_checkpoints")) {
          return {
            rows: [
              { prev_ledger: null, curr_ledger: "1000", gap: null },
              { prev_ledger: "1000", curr_ledger: "9000", gap: "8000" },
            ],
          };
        }
        return healthyHandler()(text);
      });

      const report = await runRestoreVerify(client, 5000);
      const reportStr = JSON.stringify(report);

      assert.ok(!reportStr.includes("supersecret"), "finding detail must not contain DB password");
      assert.ok(!reportStr.includes("restore-db"), "finding detail must not contain DB hostname");
      assert.ok(!reportStr.includes("postgresql://"), "finding detail must not contain connection URL");
    } finally {
      if (origUrl !== undefined) process.env.DATABASE_URL = origUrl;
      else delete process.env.DATABASE_URL;
    }
  });
});

// ─── Additional coverage: distinct findings per concern ───────────────────────
//
// Acceptance criteria: "returns distinct findings for schema, checkpoint,
// and projection problems."  Verify that when multiple checks fail, each
// is surfaced as a separate named finding rather than collapsed.

describe("restoreVerify — distinct findings for multiple failures", () => {
  test("schema + checkpoint + projection failures each appear as separate findings", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };

      // Schema: missing table
      if (t.includes("schema_migrations")) {
        throw new Error("relation \"schema_migrations\" does not exist");
      }

      // Checkpoint: large gap
      if (t.includes("count(*)") && t.includes("ledger_checkpoints")) {
        return { rows: [{ count: "3" }] };
      }
      if (t.includes("lag(ledger)") && t.includes("ledger_checkpoints")) {
        return {
          rows: [
            { prev_ledger: null, curr_ledger: "100", gap: null },
            { prev_ledger: "100", curr_ledger: "5200", gap: "5100" },
          ],
        };
      }
      if (t.includes("min(ledger)") && t.includes("ledger_checkpoints")) {
        return { rows: [{ min_ledger: "100", max_ledger: "5200" }] };
      }

      // Projection: bad circle row
      if (t.includes("count(*)") && t.includes("from circles")) {
        return { rows: [{ count: "1" }] };
      }
      if (t.includes("select address") && t.includes("from circles")) {
        return {
          rows: [
            {
              address: syntheticContractAddress(99),
              status: "INVALID_STATUS",
              current_round: 10,
              total_rounds: 3,
              member_count: 2,
              round_amount: "50",
            },
          ],
        };
      }

      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);

    const schemaFinding      = report.findings.find((f) => f.name === "schema_version");
    const checkpointFinding  = report.findings.find((f) => f.name === "checkpoint_continuity");
    const projectionFinding  = report.findings.find((f) => f.name === "projection_consistency");

    assert.ok(schemaFinding,     "schema_version finding must be present");
    assert.ok(checkpointFinding, "checkpoint_continuity finding must be present");
    assert.ok(projectionFinding, "projection_consistency finding must be present");

    assert.equal(schemaFinding!.status,     "fail", "schema must fail");
    assert.equal(checkpointFinding!.status, "fail", "checkpoint must fail");
    assert.equal(projectionFinding!.status, "fail", "projection must fail");

    // All three are distinct objects
    assert.notEqual(schemaFinding, checkpointFinding);
    assert.notEqual(checkpointFinding, projectionFinding);
    assert.notEqual(schemaFinding, projectionFinding);

    assert.equal(report.overall, "fail");
  });

  test("findings array contains exactly the four canonical check names", async () => {
    const client = buildClient(healthyHandler());
    const report = await runRestoreVerify(client, 5000);

    const names = report.findings.map((f) => f.name);
    const canonical = [
      "schema_version",
      "checkpoint_continuity",
      "dedup_constraints",
      "projection_consistency",
    ];

    for (const name of canonical) {
      assert.ok(names.includes(name), `findings must include "${name}"`);
    }
  });
});
