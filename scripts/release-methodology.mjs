import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const normalize = (value) => value.split(path.sep).join("/");

function walkFiles(directory, relativeDirectory = "", results = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = normalize(relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Release inventory refuses symbolic link: ${relative}`);
    if (entry.isDirectory()) walkFiles(absolute, relative, results);
    else if (entry.isFile()) results.push(relative);
  }
  return results;
}

export function discoverBackendTests(backendRoot) {
  const source = path.join(backendRoot, "src");
  return walkFiles(source, "src").filter((relative) => relative.endsWith(".test.ts")).sort();
}

export function assertMandatoryTestMarkers(root, fixture) {
  const groups = [
    ["security", fixture.mandatorySecurityTests],
    ["recovery", fixture.mandatoryRecoveryTests],
  ];
  for (const [name, mandatoryFiles] of groups) {
    const markers = fixture.mandatoryTestMarkers?.[name];
    if (!Array.isArray(markers) || markers.length === 0) throw new Error(`Mandatory ${name} marker group is empty`);
    for (const marker of markers) {
      if (!mandatoryFiles.includes(marker.file)) throw new Error(`Mandatory ${name} marker file is not in its gate: ${marker.file}`);
      const absolute = path.join(root, "backend", marker.file);
      const source = fs.readFileSync(absolute, "utf8");
      const occurrences = source.split(marker.testName).length - 1;
      if (occurrences !== 1) throw new Error(`Mandatory ${name} marker must occur exactly once in ${marker.file}: ${marker.testName}`);
    }
  }
  return true;
}

export function snapshotPathExcluded(relative, fixture) {
  const normalized = normalize(relative); const segments = normalized.split("/"); const top = segments[0]; const name = segments.at(-1) || "";
  if (fixture.snapshot.excludedRootEntries.includes(top)) return true;
  if (fixture.snapshot.excludedRelativePaths.some((item) => normalized === item || normalized.startsWith(`${item}/`))) return true;
  if (segments.some((segment) => fixture.snapshot.excludedDirectoryNames.includes(segment))) return true;
  if (fixture.snapshot.excludedFileNames.includes(name)) return true;
  if (fixture.snapshot.excludedSuffixes.some((suffix) => name.endsWith(suffix))) return true;
  if (/^\.env(?:\.|$)/.test(name) && name !== ".env.example") return true;
  return false;
}

function gitOutput(root, args, encoding = "utf8") {
  const result = spawnSync("git", ["-C", root, ...args], { encoding, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.error?.message || String(result.stderr || result.status).trim()}`);
  return result.stdout;
}

function nulList(value) { return String(value).split("\0").filter(Boolean).map(normalize).sort(); }
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function collectGitSourceInventory(root, fixture) {
  const head = String(gitOutput(root, ["rev-parse", "--verify", "HEAD"])).trim();
  const trackedFiles = nulList(gitOutput(root, ["ls-files", "-z", "--cached"]));
  const deletedTrackedFiles = nulList(gitOutput(root, ["ls-files", "-z", "--deleted"]));
  const intendedUntrackedFiles = nulList(gitOutput(root, ["ls-files", "-z", "--others", "--exclude-standard"]));
  const deleted = new Set(deletedTrackedFiles);
  const expectedIncludedFiles = [...new Set([...trackedFiles.filter((relative) => !deleted.has(relative)), ...intendedUntrackedFiles])]
    .filter((relative) => !snapshotPathExcluded(relative, fixture))
    .filter((relative) => fs.existsSync(path.join(root, relative)))
    .sort();
  const trackedPatch = gitOutput(root, ["diff", "--binary", "--full-index", "HEAD", "--"], null);
  const record = { head, trackedFiles, deletedTrackedFiles, intendedUntrackedFiles, expectedIncludedFiles, trackedPatchSha256: digest(trackedPatch) };
  return { ...record, inventorySha256: digest(JSON.stringify(record)) };
}

export function assertSnapshotCompleteness(manifestEntries, inventory) {
  const actual = [...new Set(manifestEntries.map((entry) => normalize(entry.path)))].sort();
  const expected = [...new Set(inventory.expectedIncludedFiles)].sort();
  const actualSet = new Set(actual); const expectedSet = new Set(expected);
  const omitted = expected.filter((relative) => !actualSet.has(relative));
  const unexpected = actual.filter((relative) => !expectedSet.has(relative));
  if (omitted.length || unexpected.length) {
    const details = [
      omitted.length ? `omitted intended source: ${omitted.slice(0, 20).join(", ")}` : "",
      unexpected.length ? `not present in Git tracked + intended untracked inventory: ${unexpected.slice(0, 20).join(", ")}` : "",
    ].filter(Boolean).join("; ");
    throw new Error(`Clean snapshot inventory is incomplete: ${details}`);
  }
  return { passed: true, expectedFiles: expected.length, actualFiles: actual.length };
}

export function evaluateFrontendBundleBudget(distRoot, budget) {
  const failures = []; const indexPath = path.join(distRoot, "index.html");
  if (!fs.existsSync(indexPath)) return { passed: false, failures: ["frontend dist/index.html is missing"], assets: [], exceptionsApplied: [] };
  const html = fs.readFileSync(indexPath, "utf8");
  const mainMatch = html.match(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+\.js)["']/i) || html.match(/<script\b[^>]*\bsrc=["']([^"']+\.js)["'][^>]*\btype=["']module["']/i);
  const mainShell = mainMatch?.[1]?.replace(/^\.?\//, "") || null;
  if (!mainShell) failures.push("frontend index.html does not identify a module main shell");
  const javascript = walkFiles(distRoot).filter((relative) => relative.endsWith(".js"));
  const exceptions = (budget.exceptions || []).map((item) => ({ ...item, regex: new RegExp(item.pattern) }));
  const exceptionsApplied = [];
  const assets = javascript.map((relative) => {
    const bytes = fs.statSync(path.join(distRoot, relative)).size;
    const exception = exceptions.find((item) => item.regex.test(relative));
    if (exception) exceptionsApplied.push({ path: relative, bytes, pattern: exception.pattern, reason: exception.reason });
    else if (relative === mainShell && bytes > budget.mainShellMaxBytes) failures.push(`main shell ${relative} is ${bytes} bytes, over ${budget.mainShellMaxBytes}`);
    else if (relative !== mainShell && bytes > budget.otherJavaScriptMaxBytes) failures.push(`JavaScript chunk ${relative} is ${bytes} bytes, over ${budget.otherJavaScriptMaxBytes} without an explicit exception`);
    return { path: relative, bytes, mainShell: relative === mainShell, exception: exception ? { pattern: exception.pattern, reason: exception.reason } : null };
  });
  if (mainShell && !javascript.includes(mainShell)) failures.push(`main shell asset is missing: ${mainShell}`);
  return { passed: failures.length === 0, failures, mainShell, limits: { mainShellMaxBytes: budget.mainShellMaxBytes, otherJavaScriptMaxBytes: budget.otherJavaScriptMaxBytes }, assets, exceptionsApplied };
}
