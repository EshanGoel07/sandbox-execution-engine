#!/usr/bin/env node
/*
 * Architecture fitness check — fails the build if a package imports something
 * it is not allowed to. Run by `npm run lint` and in CI.
 *
 * This table is the architecture. Keep it and PLAN.md's dependency rules in
 * sync.
 *
 *   ┌─────────────────┬────────────────────────────────────────────────────┐
 *   │ package         │ may import                                         │
 *   ├─────────────────┼────────────────────────────────────────────────────┤
 *   │ packages/shared │ (nothing internal — it is leaf types/DTOs)         │
 *   │ packages/engine │ @vj/shared                                         │
 *   │ packages/infra  │ @vj/shared                                         │
 *   │ apps/api        │ @vj/shared, @vj/infra      (enqueues; never runs)  │
 *   │ apps/worker     │ @vj/shared, @vj/infra, @vj/engine                  │
 *   │ apps/web        │ @vj/shared ONLY  (talks to the API over HTTP)      │
 *   └─────────────────┴────────────────────────────────────────────────────┘
 *
 * Two things are checked:
 *   1. every `@vj/*` import is on its package's allow-list;
 *   2. no relative import escapes into a *different* top-level package
 *      (that would smuggle past rule 1).
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve, dirname, sep } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** package dir (relative, posix-ish) -> set of allowed @vj/* package names */
const ALLOW = {
  "packages/shared": new Set([]),
  "packages/engine": new Set(["@vj/shared"]),
  "packages/infra": new Set(["@vj/shared"]),
  "apps/api": new Set(["@vj/shared", "@vj/infra"]),
  "apps/worker": new Set(["@vj/shared", "@vj/infra", "@vj/engine"]),
  "apps/web": new Set(["@vj/shared"]),
};

const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[^.\w])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[^.\w])require\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "test" || name === "tests") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|mts|cts)$/.test(name)) out.push(full);
  }
  return out;
}

function packageOf(absPath) {
  const rel = relative(ROOT, absPath).split(sep).join("/");
  for (const pkg of Object.keys(ALLOW)) if (rel === pkg || rel.startsWith(pkg + "/")) return pkg;
  return null;
}

function specifiersIn(source) {
  const specs = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    specs.push(m[1] || m[2] || m[3] || m[4]);
  }
  return specs;
}

const violations = [];

for (const pkg of Object.keys(ALLOW)) {
  const pkgDir = join(ROOT, pkg);
  let files;
  try {
    files = walk(pkgDir);
  } catch {
    continue; // package not present (yet)
  }

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const where = relative(ROOT, file);

    for (const spec of specifiersIn(source)) {
      if (spec.startsWith("@vj/")) {
        const name = spec.split("/").slice(0, 2).join("/"); // @vj/foo
        if (name === `@vj/${pkg.split("/")[1]}`) continue; // self-import via alias
        if (!ALLOW[pkg].has(name)) {
          violations.push(`${where}\n    imports ${spec} — ${pkg} may not depend on ${name}`);
        }
        continue;
      }

      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        const targetPkg = packageOf(target);
        if (targetPkg && targetPkg !== pkg) {
          violations.push(
            `${where}\n    relative import "${spec}" escapes into ${targetPkg} — use its @vj/* entry point (if allowed)`
          );
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Architecture boundary violations:\n");
  for (const v of violations) console.error("  " + v + "\n");
  console.error(`${violations.length} violation(s). See the table in scripts/check-boundaries.mjs.`);
  process.exit(1);
}

console.log("boundaries ok — every package imports only what it is allowed to");
