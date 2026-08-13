import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateFrontendBundleBudget } from "./release-methodology.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "scripts", "fixtures", "ws15-release-contract.json"), "utf8"));
const result = evaluateFrontendBundleBudget(path.join(root, "frontend", "dist"), fixture.frontendBundleBudget);
const report = { schemaVersion: 1, kind: "crewforge-frontend-bundle-budget", ...result, gate: { passed: result.passed } };
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!result.passed) process.exitCode = 2;
