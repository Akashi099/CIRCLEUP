import { test, describe, expect } from "vitest";
import assert from "node:assert/strict";
import {
  redactDatabaseUrl,
  redactCredentialsInText,
  buildPoolConfig,
  getConnectionSecurityReport,
} from "./pool";

describe("Database Transport Security & Connection Options (#936)", () => {
  describe("Secret redaction", () => {
    test("redactDatabaseUrl masks password and leaves host/port/database intact", () => {
      const url = "postgresql://myuser:supersecret123@db.prod.internal:5432/circleup_prod?sslmode=verify-full";
      const redacted = redactDatabaseUrl(url);

      assert.ok(!redacted.includes("supersecret123"), "Password must not be in redacted URL");
      assert.ok(redacted.includes("***"), "Password must be replaced by ***");
      assert.ok(redacted.includes("myuser"), "Username is preserved");
      assert.ok(redacted.includes("db.prod.internal"), "Hostname is preserved");
      assert.ok(redacted.includes("5432"), "Port is preserved");
      assert.ok(redacted.includes("circleup_prod"), "Database name is preserved");
      assert.ok(redacted.includes("sslmode=verify-full"), "Search parameters are preserved");
    });

    test("redactCredentialsInText masks credentials within exception text", () => {
      const rawText = "Failed connecting to postgresql://admin:p%40ssw0rd!@db.host:5432/app with ECONNREFUSED";
      const sanitized = redactCredentialsInText(rawText);

      assert.ok(!sanitized.includes("p%40ssw0rd!"), "Raw password must be stripped from log text");
      assert.ok(sanitized.includes("postgresql://admin:***@db.host:5432/app"));
    });

    test("redactDatabaseUrl safely handles undefined and empty inputs", () => {
      assert.equal(redactDatabaseUrl(undefined), "");
      assert.equal(redactDatabaseUrl(""), "");
    });
  });

  describe("Development profile ergonomics", () => {
    test("allows plain unencrypted local database in development", () => {
      const localUrl = "postgresql://postgres:localpass@localhost:5432/circleup_dev";
      const { poolConfig, security } = buildPoolConfig(localUrl, {
        NODE_ENV: "development",
        CIRCLEUP_PROFILE: "development",
      });

      assert.equal(poolConfig.connectionString, localUrl);
      assert.equal(poolConfig.ssl, undefined, "SSL should not be required in development");
      assert.equal(security.sslEnabled, false);
      assert.equal(security.isProduction, false);
      assert.equal(security.host, "localhost");
      assert.equal(security.database, "circleup_dev");
      assert.equal(security.applicationName, "circleup-indexer");
    });
  });

  describe("Production profile strict security enforcement", () => {
    test("rejects plain unencrypted database URL in production", () => {
      const prodUrl = "postgresql://app:prodpass@db.internal:5432/circleup_prod";

      assert.throws(
        () => {
          buildPoolConfig(prodUrl, {
            NODE_ENV: "production",
            CIRCLEUP_PROFILE: "production",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /Insecure database transport rejected for production/);
          assert.ok(!err.message.includes("prodpass"), "Credentials must never be logged in error");
          return true;
        },
      );
    });

    test("rejects sslmode=disable in production", () => {
      const disabledSslUrl = "postgresql://app:prodpass@db.internal:5432/circleup_prod?sslmode=disable";

      assert.throws(
        () => {
          buildPoolConfig(disabledSslUrl, {
            NODE_ENV: "production",
            CIRCLEUP_PROFILE: "production",
          });
        },
        /Insecure database transport rejected for production/,
      );
    });

    test("rejects silently disabling certificate verification in production", () => {
      const insecureTlsUrl = "postgresql://app:prodpass@db.internal:5432/circleup_prod?sslmode=no-verify";

      assert.throws(
        () => {
          buildPoolConfig(insecureTlsUrl, {
            NODE_ENV: "production",
            CIRCLEUP_PROFILE: "production",
          });
        },
        /Insecure database configuration rejected for production: TLS certificate verification cannot be silently disabled/,
      );
    });

    test("accepts valid TLS configuration with sslmode=verify-full in production", () => {
      const secureUrl = "postgresql://app:prodpass@db.internal:5432/circleup_prod?sslmode=verify-full";
      const { poolConfig, security } = buildPoolConfig(secureUrl, {
        NODE_ENV: "production",
        CIRCLEUP_PROFILE: "production",
        DB_APPLICATION_NAME: "circleup-indexer-prod-1",
      });

      assert.equal(security.sslEnabled, true);
      assert.equal(security.sslRejectUnauthorized, true);
      assert.equal(security.isProduction, true);
      assert.equal(security.applicationName, "circleup-indexer-prod-1");
      assert.equal(poolConfig.application_name, "circleup-indexer-prod-1");
      assert.deepEqual(poolConfig.ssl, { rejectUnauthorized: true });
    });

    test("accepts custom CA certificate via DB_SSL_CA", () => {
      const secureUrl = "postgresql://app:prodpass@db.internal:5432/circleup_prod?sslmode=require";
      const fakeCaPem = "-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----";

      const { poolConfig, security } = buildPoolConfig(secureUrl, {
        NODE_ENV: "production",
        CIRCLEUP_PROFILE: "production",
        DB_SSL_CA: fakeCaPem,
      });

      assert.equal(security.sslEnabled, true);
      assert.equal(security.hasCustomCa, true);
      assert.equal(security.sslRejectUnauthorized, true);
      assert.deepEqual(poolConfig.ssl, {
        rejectUnauthorized: true,
        ca: fakeCaPem,
      });
    });
  });

  describe("Malformed URL safety", () => {
    test("throws descriptive secret-safe error on malformed DATABASE_URL", () => {
      const badUrl = "not-a-valid-url://user:secret@bad";

      assert.throws(
        () => {
          buildPoolConfig(badUrl, {
            NODE_ENV: "development",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /Malformed DATABASE_URL/);
          assert.ok(!err.message.includes("secret"), "Malformed error must not leak secret");
          return true;
        },
      );
    });
  });

  describe("getConnectionSecurityReport", () => {
    test("returns a non-sensitive snapshot matching active pool options", () => {
      const report = getConnectionSecurityReport();
      assert.ok(typeof report.host === "string");
      assert.ok(typeof report.port === "number");
      assert.ok(typeof report.database === "string");
      assert.ok(typeof report.sslEnabled === "boolean");
      assert.ok(typeof report.applicationName === "string");
      assert.ok(typeof report.connectionTimeoutMs === "number");
      // Assert no secret keys exist on report
      assert.equal((report as any).password, undefined);
      assert.equal((report as any).user, undefined);
    });
  });
});
