#!/usr/bin/env node
/*
 * Fails the build if packages/sdk-ts/src/generated/openapi.ts is stale —
 * i.e. openapi.yaml changed and `npm run generate -w @vj/sdk` wasn't re-run.
 * Run by `npm run lint`.
 *
 * openapi.yaml is the source of truth for the public API. Two checks keep
 * the code honest against it: this one (the SDK's types match the spec) and
 * the integration test's contract validation (the server's responses match
 * the spec).
 */
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = join(ROOT, "openapi.yaml");
const COMMITTED = join(ROOT, "packages/sdk-ts/src/generated/openapi.ts");
const BIN = join(ROOT, "node_modules/.bin/openapi-typescript");

const dir = mkdtempSync(join(tmpdir(), "sdk-types-"));
try {
  const fresh = join(dir, "openapi.ts");
  execFileSync(BIN, [SPEC, "-o", fresh], { stdio: "pipe" });
  if (readFileSync(fresh, "utf8") !== readFileSync(COMMITTED, "utf8")) {
    console.error(
      "SDK types are stale: openapi.yaml changed but packages/sdk-ts/src/generated/openapi.ts was not regenerated.\n" +
        "Run: npm run generate -w @vj/sdk"
    );
    process.exit(1);
  }
  console.log("sdk types ok — generated from the current openapi.yaml");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
