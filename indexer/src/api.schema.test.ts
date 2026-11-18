/**
 * Issue #850: CI validation for the versioned OpenAPI reference.
 *
 * These tests run as part of CI and detect:
 *   1. The spec file is valid, parseable JSON.
 *   2. The spec declares OpenAPI 3.x.
 *   3. Every Express GET route in api.ts has a corresponding entry in the
 *      spec's `paths` object (using Express :param → {param} conversion).
 *   4. Every path in the spec has a `get` operation with at least one response.
 *   5. All $ref values inside the spec resolve to a declared component schema.
 *   6. Every path's GET operation documents at least a 200 response.
 *   7. The spec file exports its version in info.version and it is a semver string.
 *
 * No external validation library is required — all checks are pure JSON
 * structural assertions so they run in the same Node.js test environment as
 * the rest of the indexer tests.
 *
 * The spec lives at docs/api/v1/openapi.json and is served at
 * GET /openapi/v1.json by the Express app.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Resolve spec path ─────────────────────────────────────────────────────────

const SPEC_PATH = path.resolve(__dirname, "../../docs/api/v1/openapi.json");
const API_TS_PATH = path.resolve(__dirname, "api.ts");

// ── Load fixtures ─────────────────────────────────────────────────────────────

function loadSpec(): Record<string, unknown> {
  const raw = fs.readFileSync(SPEC_PATH, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function loadApiSource(): string {
  return fs.readFileSync(API_TS_PATH, "utf-8");
}

/**
 * Extract every `app.get("…path…"` or `app.get('/…path…'` literal from
 * api.ts.  Returns the raw Express paths (with :param syntax).
 * Skips the /openapi/v1.json route — it is the spec delivery route itself,
 * not a domain API route.
 */
function extractExpressRoutes(source: string): string[] {
  const matches = source.matchAll(/app\.get\(["']([^"']+)["']/g);
  const routes: string[] = [];
  for (const m of matches) {
    const route = m[1];
    if (route === "/openapi/v1.json") continue; // spec-serving route — excluded
    routes.push(route);
  }
  return routes;
}

/**
 * Convert an Express route path to an OpenAPI path:
 *   /circles/:address  →  /circles/{address}
 *   /members/:member/contributions  →  /members/{member}/contributions
 */
function expressToOpenApi(expressPath: string): string {
  return expressPath.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "{$1}");
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Spec file is valid JSON
// ═══════════════════════════════════════════════════════════════════════════════

test("#850 openapi.json exists and is valid JSON", () => {
  assert.ok(
    fs.existsSync(SPEC_PATH),
    `OpenAPI spec not found at: ${SPEC_PATH}`,
  );
  assert.doesNotThrow(() => loadSpec(), "openapi.json must be parseable as JSON");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Spec declares OpenAPI 3.x
// ═══════════════════════════════════════════════════════════════════════════════

test("#850 spec declares openapi 3.x version", () => {
  const spec = loadSpec();
  assert.ok(
    typeof spec.openapi === "string",
    "spec must have an 'openapi' string field",
  );
  assert.ok(
    (spec.openapi as string).startsWith("3."),
    `spec.openapi must start with '3.' (got: '${spec.openapi}')`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Spec has an info block with a semver version
// ═══════════════════════════════════════════════════════════════════════════════

test("#850 spec has info.version matching semver", () => {
  const spec = loadSpec();
  const info = spec.info as Record<string, unknown> | undefined;
  assert.ok(typeof info === "object" && info !== null, "spec must have an 'info' object");
  assert.ok(
    typeof info.version === "string" && info.version.length > 0,
    "spec.info.version must be a non-empty string",
  );
  // Semver: N.N.N (we accept N.N and N.N.N for leniency)
  assert.match(
    info.version as string,
    /^\d+\.\d+/,
    `spec.info.version must look like a semver string (got: '${info.version}')`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Every Express GET route has a path entry in the spec
// ═══════════════════════════════════════════════════════════════════════════════

test("#850 every Express GET route is documented in openapi.json", () => {
  const source = loadApiSource();
  const spec = loadSpec();
  const paths = spec.paths as Record<string, unknown> | undefined;
  assert.ok(typeof paths === "object" && paths !== null, "spec must have a 'paths' object");

  const expressRoutes = extractExpressRoutes(source);
  assert.ok(expressRoutes.length > 0, "api.ts must register at least one GET route");

  const missing: string[] = [];
  for (const expressRoute of expressRoutes) {
    const openApiPath = expressToOpenApi(expressRoute);
    if (!(openApiPath in paths)) {
      missing.push(`${expressRoute}  →  ${openApiPath}`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `The following Express routes are missing from openapi.json paths:\n${missing.map((r) => `  • ${r}`).join("\n")}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Every spec path has a GET operation with a 200 response
// ═══════════════════════════════════════════════════════════════════════════════

test("#850 every openapi path has a GET operation with a 200 response", () => {
  const spec = loadSpec();
  const paths = spec.paths as Record<string, unknown>;

  const deficient: string[] = [];
  for (const [specPath, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    const pi = pathItem as Record<string, unknown>;
    const getOp = pi.get as Record<string, unknown> | undefined;

    if (!getOp) {
      deficient.push(`${specPath}: missing GET operation`);
      continue;
    }

    const responses = getOp.responses as Record<string, unknown> | undefined;
    if (!responses || !("200" in responses)) {
      deficient.push(`${specPath}: GET operation has no 200 response`);
    }
  }

  assert.deepEqual(
    deficient,
    [],
    `The following spec paths have incomplete GET operations:\n${deficient.map((d) => `  • ${d}`).join("\n")}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. All $ref values resolve to declared component schemas
// ═══════════════════════════════════════════════════════════════════════════════

test("#850 all $ref values resolve to declared component schemas", () => {
  const spec = loadSpec();
  const components = spec.components as Record<string, unknown> | undefined;
  const schemas = (components?.schemas as Record<string, unknown>) ?? {};

  /**
   * Walk the entire spec JSON tree and collect every $ref string that starts
   * with "#/components/schemas/".  Inline schemas (no $ref) are ignored.
   */
  function collectRefs(node: unknown, refs: string[]): void {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) collectRefs(item, refs);
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (key === "$ref" && typeof value === "string") {
        refs.push(value);
      } else {
        collectRefs(value, refs);
      }
    }
  }

  const allRefs: string[] = [];
  collectRefs(spec.paths, allRefs);

  const unresolved: string[] = [];
  for (const ref of allRefs) {
    if (!ref.startsWith("#/components/schemas/")) continue;
    const schemaName = ref.slice("#/components/schemas/".length);
    if (!(schemaName in schemas)) {
      unresolved.push(ref);
    }
  }

  // Deduplicate before reporting
  const unique = [...new Set(unresolved)];
  assert.deepEqual(
    unique,
    [],
    `The following $ref values do not resolve to a declared component schema:\n${unique.map((r) => `  • ${r}`).join("\n")}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Spec path count is consistent with Express route count (staleness guard)
// ═══════════════════════════════════════════════════════════════════════════════

test("#850 spec path count matches or exceeds Express route count (no silent drops)", () => {
  const source = loadApiSource();
  const spec = loadSpec();
  const paths = spec.paths as Record<string, unknown>;

  const expressRoutes = extractExpressRoutes(source);
  const specPathCount = Object.keys(paths).length;

  // The spec may document more paths than Express if it includes deprecated
  // paths or versioned extras — that is acceptable.  What is NOT acceptable
  // is the spec having FEWER paths than Express has routes.
  assert.ok(
    specPathCount >= expressRoutes.length,
    `Spec has ${specPathCount} paths but api.ts registers ${expressRoutes.length} GET routes. ` +
      `Add the missing routes to openapi.json.`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. The /openapi/v1.json serving route exists in api.ts
// ═══════════════════════════════════════════════════════════════════════════════

test("#850 api.ts serves the spec file at GET /openapi/v1.json", () => {
  const source = loadApiSource();
  assert.match(
    source,
    /app\.get\(["']\/openapi\/v1\.json["']/,
    "api.ts must register a route for GET /openapi/v1.json",
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Pagination parameters documented for paginated routes
// ═══════════════════════════════════════════════════════════════════════════════

test("#850 paginated routes document page and limit query parameters", () => {
  const spec = loadSpec();
  const paths = spec.paths as Record<string, Record<string, unknown>>;

  // These are the routes we know are paginated
  const paginatedPaths = ["/circles", "/members/{member}/contributions"];

  for (const paginatedPath of paginatedPaths) {
    if (!(paginatedPath in paths)) continue; // already caught by test 4

    const pathItem = paths[paginatedPath];
    const getOp = pathItem.get as Record<string, unknown> | undefined;
    if (!getOp) continue;

    const params = (getOp.parameters as Array<Record<string, unknown>>) ?? [];
    const paramNames = params.map((p) => p.name as string);

    assert.ok(
      paramNames.includes("page"),
      `${paginatedPath} GET operation must document a 'page' query parameter`,
    );
    assert.ok(
      paramNames.includes("limit"),
      `${paginatedPath} GET operation must document a 'limit' query parameter`,
    );
  }
});
