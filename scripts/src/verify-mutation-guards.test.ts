import { describe, it, expect } from "vitest";
import {
  MUTATION_GUARDS,
  EXCLUDED_MUTATIONS,
  validateMutationCatalog,
} from "./verify-mutation-guards";

describe("verify-mutation-guards catalog", () => {
  it("validates that all guard IDs are unique", () => {
    const result = validateMutationCatalog();
    expect(result.valid).toBe(true);
    expect(result.totalGuards).toBe(MUTATION_GUARDS.length);
    expect(result.excludedCount).toBe(EXCLUDED_MUTATIONS.length);
  });

  it("ensures every factory guard has a non-empty protectedCondition and risk", () => {
    const factoryGuards = MUTATION_GUARDS.filter((g) => g.contract === "circle_factory");
    expect(factoryGuards.length).toBeGreaterThanOrEqual(8);
    for (const g of factoryGuards) {
      expect(g.protectedCondition.length).toBeGreaterThan(0);
      expect(g.riskIfRemoved.length).toBeGreaterThan(0);
      expect(g.testFile).toContain("circle_factory/tests/mutation_guard_tests.rs");
    }
  });

  it("ensures every reputation guard has a non-empty protectedCondition and risk", () => {
    const repGuards = MUTATION_GUARDS.filter((g) => g.contract === "reputation");
    expect(repGuards.length).toBeGreaterThanOrEqual(7);
    for (const g of repGuards) {
      expect(g.protectedCondition.length).toBeGreaterThan(0);
      expect(g.riskIfRemoved.length).toBeGreaterThan(0);
      expect(g.testFile).toContain("reputation/tests/mutation_guard_tests.rs");
    }
  });

  it("documents every excluded mutation with clear rationale", () => {
    for (const ex of EXCLUDED_MUTATIONS) {
      expect(ex.id).toBeDefined();
      expect(ex.condition.length).toBeGreaterThan(0);
      expect(ex.exclusionReason.length).toBeGreaterThan(15);
    }
  });
});

