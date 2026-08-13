import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type RetrievalCategory =
  | "navigation"
  | "bug_localization"
  | "cross_file_change"
  | "test_selection";

export interface RetrievalReferenceCase {
  id: string;
  category: RetrievalCategory;
  query: string;
  currentPath?: string;
  k: number;
  expectedPaths: string[];
  expectedSymbols?: Array<{ path: string; symbol: string; line: number }>;
  forbiddenPaths?: string[];
  changedPaths?: string[];
  diagnostics?: Array<{ path: string; line: number; message: string }>;
  workspaceVariant?: "main" | "worktree-a" | "worktree-b";
}

export interface RetrievalReferenceFixture {
  root: string;
  main: string;
  worktreeA: string;
  worktreeB: string;
  externalSecret: string;
  symlinkPath: string;
  cases: RetrievalReferenceCase[];
  datasetDigest: string;
  treeDigest: string;
  applyIgnorePolicyChange(): void;
}

const REFERENCE_FILES: Record<string, string> = {
  ".gitignore": "ignored/\ndist/\n*.min.js\n",
  ".ignore": "ignored-by-ignore/\n",
  ".rgignore": "ignored-by-rgignore/\n",
  ".github/CODEOWNERS": "/src/payments/ @payments-team\n/src/auth/ @security-team\n",
  "src/payments/money.ts": "export function formatMoney(cents: number): string { return `$${(cents / 100).toFixed(2)}`; }\n",
  "src/payments/checkout.ts": "import { formatMoney as fmt } from './money.js';\nexport const checkoutLabel = (cents: number) => fmt(cents);\n",
  "src/catalog/product.ts": "export interface ProductCard { sku: string; title: string; }\n",
  "src/catalog/index.ts": "export type { ProductCard } from './product.js';\n",
  "src/catalog/view.ts": "import type { ProductCard } from './index.js';\nexport const productTitle = (item: ProductCard) => item.title;\n",
  "src/session/defaultSession.ts": "export default function createSession(userId: string) { return { userId }; }\n",
  "src/session/useSession.ts": "import createSession from './defaultSession.js';\nexport const active = createSession('reference-user');\n",
  "src/utils/math.ts": "export const sumValues = (values: number[]) => values.reduce((a, b) => a + b, 0);\n",
  "src/utils/namespaceConsumer.ts": "import * as math from './math.js';\nexport const total = math.sumValues([1, 2, 3]);\n",
  "src/collision/a/logger.ts": "export const writeAudit = () => 'wrong-collision-a';\n",
  "src/collision/b/logger.ts": "export const writeAudit = () => 'correct-collision-b';\n",
  "src/collision/consumer.ts": "import { writeAudit } from './b/logger.js';\nexport const auditResult = writeAudit();\n",
  "python/pkg/formatting.py": "def render_invoice(total):\n    return f'invoice:{total}'\n",
  "python/pkg/service.py": "from .formatting import render_invoice as render\n\ndef invoice_service(total):\n    return render(total)\n",
  "go/account.go": "package reference\n\ntype Account struct { Open bool }\nfunc (a *Account) CloseAccount() { a.Open = false }\n",
  "go/handler.go": "package reference\n\nfunc HandleClose(a *Account) { a.CloseAccount() }\n",
  "java/UserRepository.java": "package reference;\npublic class UserRepository { public String findUser(String id) { return id; } }\n",
  "java/UserService.java": "package reference;\npublic class UserService { UserRepository repo = new UserRepository(); String load(String id) { return repo.findUser(id); } }\n",
  "lua/cache.lua": "local M = {}\nfunction M.invalidate_cache(key) return key end\nreturn M\n",
  "lua/consumer.lua": "local cache = require('cache')\nreturn cache.invalidate_cache('reference')\n",
  "src/worktree/variant.ts": "export const WORKTREE_VARIANT = 'main-reference';\n",
  "src/navigation/renamedTarget.ts": "export const renamedNavigationTarget = 'renamed-reference';\n",

  "src/orders/pricing.ts": "export function applyDiscount(total: number, percent: number) { return total - percent; }\n",
  "src/orders/checkout.ts": "import { applyDiscount } from './pricing.js';\nexport const checkoutTotal = (total: number) => applyDiscount(total, 10);\n",
  "src/auth/token.ts": "export function decodeToken(value: string) { if (!value) throw new Error('TOKEN_EXPIRED_X9'); return value; }\n",
  "src/auth/middleware.ts": "import { decodeToken } from './token.js';\nexport const authenticate = (header: string) => decodeToken(header);\n",
  "src/config/defaults.ts": "export const requestTimeoutMs = 0; // BUG_TIMEOUT_ZERO\n",
  "src/config/parser.ts": "import { requestTimeoutMs } from './defaults.js';\nexport const parseTimeout = (raw?: number) => raw ?? requestTimeoutMs;\n",
  "src/history/newLedger.ts": "export const historyLedgerRegression = 'new-ledger-reference';\n",
  "src/owners/paymentOwner.ts": "export const paymentOwnershipBug = 'PAYMENT_OWNER_BUG';\n",
  "policy/newly-ignored.ts": "export const policyChangeLeak = 'POLICY_CHANGE_SECRET';\n",
  "ignored/bug-decoy.ts": "export const TOKEN_EXPIRED_X9 = 'ignored-decoy';\n",
  "ignored-by-ignore/decoy.ts": "export const BUG_TIMEOUT_ZERO = 'ignore-file-decoy';\n",
  "ignored-by-rgignore/decoy.ts": "export const PAYMENT_OWNER_BUG = 'rgignore-decoy';\n",
  ".history/protected-decoy.ts": "export const TOKEN_EXPIRED_X9 = 'protected-history-secret';\n",
  ".checkpoints/protected-decoy.ts": "export const BUG_TIMEOUT_ZERO = 'protected-checkpoint-secret';\n",
  ".transcripts/private.jsonl": "{\"content\":\"TRANSCRIPT_PRIVATE_SECRET\"}\n",
  "src/generated/client.ts": "// @generated - DO NOT EDIT\nexport const applyDiscount = () => 'generated-decoy';\n",
  "dist/bundle.ts": "export const PAYMENT_OWNER_BUG = 'dist-decoy';\n",

  "src/contracts/user.ts": "export interface UserRecord { id: string; displayName: string; }\n",
  "src/services/userService.ts": "import type { UserRecord } from '../contracts/user.js';\nexport const loadUser = (): UserRecord => ({ id: '1', displayName: 'Ada' });\n",
  "src/ui/UserView.tsx": "import { loadUser } from '../services/userService.js';\nexport const UserView = () => loadUser().displayName;\n",
  "src/settings/schema.ts": "export interface SettingsSchema { retryLimit: number; }\n",
  "src/settings/parser.ts": "import type { SettingsSchema } from './schema.js';\nexport const parseSettings = (retryLimit: number): SettingsSchema => ({ retryLimit });\n",
  "src/settings/SettingsPanel.tsx": "import { parseSettings } from './parser.js';\nexport const SettingsPanel = () => parseSettings(3).retryLimit;\n",
  "src/shared/order.ts": "export interface OrderPayload { orderId: string; quantity: number; }\n",
  "src/api/orderRoute.ts": "import type { OrderPayload } from '../shared/order.js';\nexport const submitOrder = (body: OrderPayload) => body.orderId;\n",
  "src/client/orderClient.ts": "import type { OrderPayload } from '../shared/order.js';\nexport const sendOrder = (body: OrderPayload) => body.quantity;\n",
  "src/db/accountModel.ts": "export interface AccountRow { id: string; enabled: boolean; }\n",
  "src/db/accountRepository.ts": "import type { AccountRow } from './accountModel.js';\nexport const saveAccount = (row: AccountRow) => row.id;\n",
  "src/db/migrations/001_accounts.sql": "CREATE TABLE accounts (id TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL);\n",
  "src/components/Button.tsx": "export interface ButtonProps { label: string; disabled?: boolean; }\nexport const Button = (props: ButtonProps) => props.label;\n",
  "src/screens/CheckoutScreen.tsx": "import { Button } from '../components/Button.js';\nexport const CheckoutScreen = () => Button({ label: 'Pay' });\n",
  "src/screens/AdminScreen.tsx": "import { Button } from '../components/Button.js';\nexport const AdminScreen = () => Button({ label: 'Save', disabled: true });\n",
  "python/base.py": "class JobRunner:\n    def run(self):\n        raise NotImplementedError\n",
  "python/child.py": "from .base import JobRunner\n\nclass BillingJob(JobRunner):\n    def run(self):\n        return 'billing'\n",

  "src/payments/money.test.ts": "import { formatMoney } from './money.js';\nif (formatMoney(125) !== '$1.25') throw new Error('money');\n",
  "src/orders/pricing.test.ts": "import { applyDiscount } from './pricing.js';\nif (applyDiscount(100, 10) !== 90) throw new Error('discount');\n",
  "src/auth/token.test.ts": "import { decodeToken } from './token.js';\ntry { decodeToken(''); } catch {}\n",
  "src/api/orderRoute.integration.test.ts": "import { submitOrder } from './orderRoute.js';\nsubmitOrder({ orderId: '1', quantity: 1 });\n",
  "python/test_formatting.py": "from pkg.formatting import render_invoice\n\ndef test_render_invoice():\n    assert render_invoice(2) == 'invoice:2'\n",
  "go/account_test.go": "package reference\n\nfunc TestCloseAccount(t interface{}) { a := &Account{Open:true}; a.CloseAccount() }\n",
  "src/settings/parser.test.ts": "import { parseSettings } from './parser.js';\nif (parseSettings(2).retryLimit !== 2) throw new Error('settings');\n",
  "src/contracts/user.test.ts": "import type { UserRecord } from './user.js';\nconst fixture: UserRecord = { id: '1', displayName: 'Ada' }; void fixture;\n",
  "tests/e2e/everything.test.ts": "export const broadE2EDecoy = 'formatMoney applyDiscount decodeToken parseSettings';\n",
  "src/worktree/variant.test.ts": "import { WORKTREE_VARIANT } from './variant.js';\nvoid WORKTREE_VARIANT;\n",
};

const FORBIDDEN = [
  ".history/protected-decoy.ts",
  ".checkpoints/protected-decoy.ts",
  ".transcripts/private.jsonl",
  "ignored/bug-decoy.ts",
  "ignored-by-ignore/decoy.ts",
  "ignored-by-rgignore/decoy.ts",
  "src/generated/client.ts",
  "dist/bundle.ts",
  "src/symlinkLeak.ts",
];

export const RETRIEVAL_REFERENCE_CASES: RetrievalReferenceCase[] = [
  { id: "NAV-01", category: "navigation", query: "definition of fmt used by checkoutLabel", currentPath: "src/payments/checkout.ts", k: 3, expectedPaths: ["src/payments/money.ts"], expectedSymbols: [{ path: "src/payments/money.ts", symbol: "formatMoney", line: 1 }] },
  { id: "NAV-02", category: "navigation", query: "ProductCard definition through catalog barrel", currentPath: "src/catalog/view.ts", k: 3, expectedPaths: ["src/catalog/product.ts"], expectedSymbols: [{ path: "src/catalog/product.ts", symbol: "ProductCard", line: 1 }] },
  { id: "NAV-03", category: "navigation", query: "createSession default import definition", currentPath: "src/session/useSession.ts", k: 3, expectedPaths: ["src/session/defaultSession.ts"], expectedSymbols: [{ path: "src/session/defaultSession.ts", symbol: "createSession", line: 1 }] },
  { id: "NAV-04", category: "navigation", query: "sumValues namespace import definition", currentPath: "src/utils/namespaceConsumer.ts", k: 3, expectedPaths: ["src/utils/math.ts"], expectedSymbols: [{ path: "src/utils/math.ts", symbol: "sumValues", line: 1 }] },
  { id: "NAV-05", category: "navigation", query: "writeAudit imported definition not collision decoy", currentPath: "src/collision/consumer.ts", k: 3, expectedPaths: ["src/collision/b/logger.ts"], expectedSymbols: [{ path: "src/collision/b/logger.ts", symbol: "writeAudit", line: 1 }] },
  { id: "NAV-06", category: "navigation", query: "Python render alias definition for invoice_service", currentPath: "python/pkg/service.py", k: 3, expectedPaths: ["python/pkg/formatting.py"], expectedSymbols: [{ path: "python/pkg/formatting.py", symbol: "render_invoice", line: 1 }] },
  { id: "NAV-07", category: "navigation", query: "Go CloseAccount receiver method definition", currentPath: "go/handler.go", k: 3, expectedPaths: ["go/account.go"], expectedSymbols: [{ path: "go/account.go", symbol: "CloseAccount", line: 4 }] },
  { id: "NAV-08", category: "navigation", query: "Java findUser definition", currentPath: "java/UserService.java", k: 3, expectedPaths: ["java/UserRepository.java"], expectedSymbols: [{ path: "java/UserRepository.java", symbol: "findUser", line: 2 }] },
  { id: "NAV-09", category: "navigation", query: "Lua invalidate_cache definition fallback", currentPath: "lua/consumer.lua", k: 3, expectedPaths: ["lua/cache.lua"], expectedSymbols: [{ path: "lua/cache.lua", symbol: "invalidate_cache", line: 2 }] },
  { id: "NAV-10", category: "navigation", query: "WORKTREE_VARIANT definition in worktree A", currentPath: "src/worktree/variant.test.ts", workspaceVariant: "worktree-a", k: 3, expectedPaths: ["src/worktree/variant.ts"], expectedSymbols: [{ path: "src/worktree/variant.ts", symbol: "WORKTREE_VARIANT", line: 1 }] },

  { id: "BUG-01", category: "bug_localization", query: "applyDiscount subtracts percent instead of percentage", k: 5, diagnostics: [{ path: "src/orders/pricing.ts", line: 1, message: "discount total mismatch" }], expectedPaths: ["src/orders/pricing.ts", "src/orders/checkout.ts"], forbiddenPaths: FORBIDDEN },
  { id: "BUG-02", category: "bug_localization", query: "TOKEN_EXPIRED_X9 authentication failure", k: 5, expectedPaths: ["src/auth/token.ts", "src/auth/middleware.ts"], forbiddenPaths: FORBIDDEN },
  { id: "BUG-03", category: "bug_localization", query: "BUG_TIMEOUT_ZERO request timeout regression", k: 5, expectedPaths: ["src/config/defaults.ts", "src/config/parser.ts"], forbiddenPaths: FORBIDDEN },
  { id: "BUG-04", category: "bug_localization", query: "historyLedgerRegression after file rename", k: 5, expectedPaths: ["src/history/newLedger.ts"] },
  { id: "BUG-05", category: "bug_localization", query: "PAYMENT_OWNER_BUG recent owner path", k: 5, expectedPaths: ["src/owners/paymentOwner.ts"], forbiddenPaths: FORBIDDEN },
  { id: "BUG-06", category: "bug_localization", query: "checkoutTotal discount caller regression", currentPath: "src/orders/checkout.ts", k: 5, expectedPaths: ["src/orders/checkout.ts", "src/orders/pricing.ts"] },
  { id: "BUG-07", category: "bug_localization", query: "decodeToken missing header failure", currentPath: "src/auth/middleware.ts", k: 5, expectedPaths: ["src/auth/token.ts", "src/auth/middleware.ts"] },
  { id: "BUG-08", category: "bug_localization", query: "parseTimeout zero default source", currentPath: "src/config/parser.ts", k: 5, expectedPaths: ["src/config/parser.ts", "src/config/defaults.ts"] },
  { id: "BUG-09", category: "bug_localization", query: "policyChangeLeak should disappear after ignore policy update", k: 5, expectedPaths: ["policy/newly-ignored.ts"], forbiddenPaths: FORBIDDEN },
  { id: "BUG-10", category: "bug_localization", query: "worktree B variant regression", workspaceVariant: "worktree-b", k: 5, expectedPaths: ["src/worktree/variant.ts"], forbiddenPaths: FORBIDDEN },

  { id: "XFILE-01", category: "cross_file_change", query: "change UserRecord displayName across contract service view", k: 8, expectedPaths: ["src/contracts/user.ts", "src/services/userService.ts", "src/ui/UserView.tsx"] },
  { id: "XFILE-02", category: "cross_file_change", query: "change SettingsSchema retryLimit parser and panel", k: 8, expectedPaths: ["src/settings/schema.ts", "src/settings/parser.ts", "src/settings/SettingsPanel.tsx"] },
  { id: "XFILE-03", category: "cross_file_change", query: "change OrderPayload quantity API route and client", k: 8, expectedPaths: ["src/shared/order.ts", "src/api/orderRoute.ts", "src/client/orderClient.ts"] },
  { id: "XFILE-04", category: "cross_file_change", query: "change AccountRow enabled repository and migration", k: 8, expectedPaths: ["src/db/accountModel.ts", "src/db/accountRepository.ts", "src/db/migrations/001_accounts.sql"] },
  { id: "XFILE-05", category: "cross_file_change", query: "add ButtonProps field update checkout and admin screens", k: 8, expectedPaths: ["src/components/Button.tsx", "src/screens/CheckoutScreen.tsx", "src/screens/AdminScreen.tsx"] },
  { id: "XFILE-06", category: "cross_file_change", query: "change JobRunner run contract and BillingJob", k: 8, expectedPaths: ["python/base.py", "python/child.py"] },
  { id: "XFILE-07", category: "cross_file_change", query: "rename formatMoney update checkout and unit test", k: 8, expectedPaths: ["src/payments/money.ts", "src/payments/checkout.ts", "src/payments/money.test.ts"] },
  { id: "XFILE-08", category: "cross_file_change", query: "change applyDiscount update checkout and pricing test", k: 8, expectedPaths: ["src/orders/pricing.ts", "src/orders/checkout.ts", "src/orders/pricing.test.ts"], forbiddenPaths: FORBIDDEN },
  { id: "XFILE-09", category: "cross_file_change", query: "change render_invoice update Python service and test", k: 8, expectedPaths: ["python/pkg/formatting.py", "python/pkg/service.py", "python/test_formatting.py"] },
  { id: "XFILE-10", category: "cross_file_change", query: "change CloseAccount update Go handler and test", k: 8, expectedPaths: ["go/account.go", "go/handler.go", "go/account_test.go"] },

  { id: "TEST-01", category: "test_selection", query: "tests for formatMoney", changedPaths: ["src/payments/money.ts"], k: 5, expectedPaths: ["src/payments/money.test.ts"] },
  { id: "TEST-02", category: "test_selection", query: "tests for applyDiscount pricing", changedPaths: ["src/orders/pricing.ts"], k: 5, expectedPaths: ["src/orders/pricing.test.ts"] },
  { id: "TEST-03", category: "test_selection", query: "tests for decodeToken", changedPaths: ["src/auth/token.ts"], k: 5, expectedPaths: ["src/auth/token.test.ts"] },
  { id: "TEST-04", category: "test_selection", query: "integration tests for submitOrder route", changedPaths: ["src/api/orderRoute.ts"], k: 5, expectedPaths: ["src/api/orderRoute.integration.test.ts"] },
  { id: "TEST-05", category: "test_selection", query: "Python tests for render_invoice", changedPaths: ["python/pkg/formatting.py"], k: 5, expectedPaths: ["python/test_formatting.py"] },
  { id: "TEST-06", category: "test_selection", query: "Go tests for CloseAccount", changedPaths: ["go/account.go"], k: 5, expectedPaths: ["go/account_test.go"] },
  { id: "TEST-07", category: "test_selection", query: "tests for parseSettings", changedPaths: ["src/settings/parser.ts"], k: 5, expectedPaths: ["src/settings/parser.test.ts"] },
  { id: "TEST-08", category: "test_selection", query: "tests for UserRecord contract", changedPaths: ["src/contracts/user.ts"], k: 5, expectedPaths: ["src/contracts/user.test.ts"] },
  { id: "TEST-09", category: "test_selection", query: "tests for OrderPayload shared type", changedPaths: ["src/shared/order.ts", "src/api/orderRoute.ts"], k: 5, expectedPaths: ["src/api/orderRoute.integration.test.ts"] },
  { id: "TEST-10", category: "test_selection", query: "tests for worktree variant", workspaceVariant: "worktree-a", changedPaths: ["src/worktree/variant.ts"], k: 5, expectedPaths: ["src/worktree/variant.test.ts"] },
];

function git(cwd: string, args: string[], commitIndex = 0): string {
  const date = new Date(Date.UTC(2024, 0, 1, 0, 0, commitIndex)).toISOString();
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "CrewForge Retrieval Fixture",
      GIT_AUTHOR_EMAIL: "retrieval-fixture@example.invalid",
      GIT_COMMITTER_NAME: "CrewForge Retrieval Fixture",
      GIT_COMMITTER_EMAIL: "retrieval-fixture@example.invalid",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  }).trim();
}

function writeFixtureFiles(repository: string): void {
  for (const [relativePath, content] of Object.entries(REFERENCE_FILES)) {
    const target = path.join(repository, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
}

function digest(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function digestFixtureTree(repository: string): string {
  const entries: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(repository, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isSymbolicLink()) entries.push(`${relative}\0symlink\0${fs.readlinkSync(absolute)}`);
      else if (entry.isFile()) entries.push(`${relative}\0file\0${digest(fs.readFileSync(absolute))}`);
    }
  };
  visit(repository);
  return digest(entries.join("\n"));
}

export function createRetrievalReferenceFixture(root: string): RetrievalReferenceFixture {
  const resolvedRoot = path.resolve(root);
  const main = path.join(resolvedRoot, "reference-main");
  const worktreeA = path.join(resolvedRoot, "reference-worktree-a");
  const worktreeB = path.join(resolvedRoot, "reference-worktree-b");
  fs.mkdirSync(main, { recursive: true });
  writeFixtureFiles(main);
  git(main, ["init", "-b", "main"]);

  fs.writeFileSync(path.join(main, "src/history/oldLedger.ts"), REFERENCE_FILES["src/history/newLedger.ts"], "utf8");
  fs.rmSync(path.join(main, "src/history/newLedger.ts"));
  git(main, ["add", "."]);
  git(main, ["commit", "-m", "seed deterministic retrieval fixture"], 1);
  git(main, ["mv", "src/history/oldLedger.ts", "src/history/newLedger.ts"]);
  git(main, ["commit", "-m", "rename ledger fixture"], 2);

  git(main, ["worktree", "add", "-b", "fixture/worktree-a", worktreeA, "HEAD"]);
  git(main, ["worktree", "add", "-b", "fixture/worktree-b", worktreeB, "HEAD"]);
  fs.writeFileSync(path.join(worktreeA, "src/worktree/variant.ts"), "export const WORKTREE_VARIANT = 'worktree-a-reference';\n", "utf8");
  git(worktreeA, ["add", "src/worktree/variant.ts"]);
  git(worktreeA, ["commit", "-m", "set worktree A variant"], 3);
  fs.writeFileSync(path.join(worktreeB, "src/worktree/variant.ts"), "export const WORKTREE_VARIANT = 'worktree-b-reference';\n", "utf8");
  git(worktreeB, ["add", "src/worktree/variant.ts"]);
  git(worktreeB, ["commit", "-m", "set worktree B variant"], 4);

  const externalSecret = path.join(resolvedRoot, "outside-secret.ts");
  fs.writeFileSync(externalSecret, "export const SYMLINK_PRIVATE_SECRET = 'must-never-index';\n", "utf8");
  const symlinkPath = path.join(main, "src/symlinkLeak.ts");
  fs.symlinkSync("../../outside-secret.ts", symlinkPath);

  return {
    root: resolvedRoot,
    main,
    worktreeA,
    worktreeB,
    externalSecret,
    symlinkPath,
    cases: RETRIEVAL_REFERENCE_CASES.map((entry) => ({ ...entry })),
    datasetDigest: digest(JSON.stringify(RETRIEVAL_REFERENCE_CASES)),
    treeDigest: digestFixtureTree(main),
    applyIgnorePolicyChange() {
      fs.appendFileSync(path.join(main, ".gitignore"), "policy/\n", "utf8");
    },
  };
}
