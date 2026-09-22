// Create eval fixture workspaces under workspace/eval/<CASE>, git init + baseline commit.
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../..");
export const EVAL_ROOT = path.join(REPO_ROOT, "workspace", "eval");

function w(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function resetCase(id) {
  const dir = path.join(EVAL_ROOT, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const builder = F[id];
  if (builder) builder(dir);
  const git = (args) =>
    execFileSync("git", ["-c", "user.email=eval@local", "-c", "user.name=eval", ...args], {
      cwd: dir,
      stdio: "pipe",
    });
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-q", "--allow-empty", "-m", "baseline"]);
  return dir;
}

const F = {};
F.empty = () => {};

F.S2 = (d) =>
  w(d, "explain_me.py", `import functools

def make_counter():
    count = 0
    def inc(step=1):
        nonlocal count
        count += step
        return count
    return inc

class RateLimiter:
    """Sliding-window limiter: at most limit events per window time units."""

    def __init__(self, limit, window):
        self.limit = limit
        self.window = window
        self.events = []

    def allow(self, now):
        self.events = [t for t in self.events if now - t < self.window]
        if len(self.events) >= self.limit:
            return False
        self.events.append(now)
        return True

def cached_fetch(misses={}):
    """Decorator that caches results across all functions it decorates."""
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(key):
            if key not in misses:
                misses[key] = fn(key)
            return misses[key]
        return wrapper
    return decorator
`);

F.S3 = (d) =>
  w(d, "invoice.py", `def page_items(items, page, per_page):
    """Return one page of items. page starts at 1."""
    start = page * per_page
    return items[start:start + per_page]

if __name__ == "__main__":
    data = list(range(1, 26))
    print(page_items(data, 1, 10))   # expect 1..10, actually prints 11..20
`);

F.S4 = (d) => {
  w(d, "config.py", "PORT = 8000\nDEBUG = False\n");
  w(
    d,
    "server.py",
    `from http.server import HTTPServer, BaseHTTPRequestHandler
from config import PORT

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

if __name__ == "__main__":
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
`
  );
  w(
    d,
    "tests/test_config.py",
    `import unittest
import config

class TestConfig(unittest.TestCase):
    def test_default_port(self):
        self.assertEqual(config.PORT, 8000)

if __name__ == "__main__":
    unittest.main()
`
  );
  w(
    d,
    "README.md",
    `# portapp

A tiny HTTP service.

## Run

\`\`\`bash
python server.py
\`\`\`

The service listens on port 8000 by default. Health check: http://localhost:8000/ .
Change the port in config.py if needed (default: 8000).
`
  );
};

F.S5 = (d) =>
  w(d, "palindrome.py", `def is_palindrome(text):
    """Return True if text reads the same forwards and backwards.

    Comparison is case-sensitive. Behaviour for non-letter characters
    is not specified here.
    """
    return text == text[::-1]
`);

F.C2 = (d) => {
  w(d, "stringcalc/__init__.py", "");
  w(d, "stringcalc/tests/__init__.py", "");
  w(
    d,
    "stringcalc/parser.py",
    `"""Parse arithmetic expressions like "2 + 3 * 4" into an AST."""

def tokenize(text):
    tokens = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch.isspace():
            i += 1
        elif ch.isdigit():
            j = i
            while j < len(text) and text[j].isdigit():
                j += 1
            tokens.append(("num", int(text[i:j])))
            i = j
        elif ch in "+-*/()":
            tokens.append(("op", ch))
            i += 1
        else:
            raise ValueError(f"unexpected character: {ch!r}")
    return tokens

def parse(text):
    tokens = tokenize(text)
    pos = 0

    def peek():
        return tokens[pos] if pos < len(tokens) else (None, None)

    def parse_expr():
        nonlocal pos
        node = parse_term()
        while peek() in (("op", "+"), ("op", "-")):
            op = tokens[pos][1]
            pos += 1
            node = ("bin", op, node, parse_term())
        return node

    def parse_term():
        nonlocal pos
        node = parse_atom()
        while peek() in (("op", "*"), ("op", "/")):
            op = tokens[pos][1]
            pos += 1
            node = ("bin", op, node, parse_atom())
        return node

    def parse_atom():
        nonlocal pos
        kind, value = peek()
        if kind == "num":
            pos += 1
            return ("num", value)
        if (kind, value) == ("op", "("):
            pos += 1
            node = parse_expr()
            if peek() != ("op", ")"):
                raise ValueError("missing closing paren")
            pos += 1
            return node
        raise ValueError(f"unexpected token: {value!r}")

    node = parse_expr()
    if pos != len(tokens):
        raise ValueError("trailing tokens")
    return node
`
  );
  w(
    d,
    "stringcalc/evaluator.py",
    `"""Evaluate the AST produced by stringcalc.parser.

Spec: non-negative integer arithmetic, integer division (7 / 2 == 3),
unary minus supported.
"""

def evaluate(node):
    kind = node[0]
    if kind == "num":
        return node[1]
    if kind == "bin":
        op = node[1]
        left = evaluate(node[2])
        right = evaluate(node[3])
        if op == "+":
            return left + right
        if op == "-":
            return right - left          # BUG: swapped operands
        if op == "*":
            return left * right
        if op == "/":
            return left / right          # BUG: spec requires integer division
        raise ValueError(f"unknown operator: {op}")
    raise ValueError(f"unknown node: {kind}")
`
  );
  w(
    d,
    "stringcalc/tests/test_stringcalc.py",
    `import unittest

from stringcalc.parser import parse
from stringcalc.evaluator import evaluate

class TestStringCalc(unittest.TestCase):
    def test_addition(self):
        self.assertEqual(evaluate(parse("1 + 2")), 3)

    def test_precedence(self):
        self.assertEqual(evaluate(parse("2 + 3 * 4")), 14)

    def test_parentheses(self):
        self.assertEqual(evaluate(parse("(2 + 3) * 4")), 20)

    def test_subtraction(self):
        self.assertEqual(evaluate(parse("10 - 4")), 6)

    def test_integer_division(self):
        self.assertEqual(evaluate(parse("7 / 2")), 3)

    def test_unary_minus(self):
        self.assertEqual(evaluate(parse("-3 + 5")), 2)

if __name__ == "__main__":
    unittest.main()
`
  );
};

F.C3 = (d) => {
  w(d, "reporting/__init__.py", "");
  w(d, "reporting/tests/__init__.py", "");
  w(
    d,
    "reporting/csv_report.py",
    `"""Export sales rows as CSV."""
import csv

def validate(rows):
    for row in rows:
        if "sku" not in row or "units" not in row or "price" not in row:
            raise ValueError(f"missing fields in row: {row!r}")
        if not isinstance(row["units"], int) or row["units"] < 0:
            raise ValueError(f"invalid units in row: {row!r}")
        if float(row["price"]) < 0:
            raise ValueError(f"invalid price in row: {row!r}")

def row_revenue(row):
    return row["units"] * float(row["price"])

def export_csv(rows, fileobj):
    validate(rows)
    writer = csv.writer(fileobj)
    writer.writerow(["sku", "units", "price", "revenue"])
    for row in rows:
        writer.writerow([row["sku"], row["units"], row["price"], row_revenue(row)])
`
  );
  w(
    d,
    "reporting/json_report.py",
    `"""Export sales rows as JSON."""
import json

def validate(rows):
    for row in rows:
        if "sku" not in row or "units" not in row or "price" not in row:
            raise ValueError(f"missing fields in row: {row!r}")
        if not isinstance(row["units"], int) or row["units"] < 0:
            raise ValueError(f"invalid units in row: {row!r}")
        if float(row["price"]) < 0:
            raise ValueError(f"invalid price in row: {row!r}")

def row_revenue(row):
    return round(row["units"] * float(row["price"]), 2)

def export_json(rows, fileobj):
    validate(rows)
    payload = {"rows": [{"sku": r["sku"], "revenue": row_revenue(r)} for r in rows]}
    json.dump(payload, fileobj)
`
  );
  w(
    d,
    "reporting/tests/test_reporting.py",
    `import io, unittest
from reporting.csv_report import validate as validate_csv, row_revenue as revenue_csv, export_csv
from reporting.json_report import validate as validate_json, row_revenue as revenue_json, export_json

ROWS = [{"sku": "A1", "units": 3, "price": "19.99"}]

class TestReporting(unittest.TestCase):
    def test_validate_rejects_missing_fields(self):
        with self.assertRaises(ValueError):
            validate_csv([{"sku": "A1"}])
        with self.assertRaises(ValueError):
            validate_json([{"sku": "A1"}])

    def test_revenue_consistent_across_exports(self):
        self.assertEqual(revenue_csv(ROWS[0]), revenue_json(ROWS[0]))

    def test_export_csv_smoke(self):
        buf = io.StringIO()
        export_csv(ROWS, buf)
        self.assertIn("A1", buf.getvalue())

    def test_export_json_smoke(self):
        buf = io.StringIO()
        export_json(ROWS, buf)
        self.assertIn("A1", buf.getvalue())

if __name__ == "__main__":
    unittest.main()
`
  );
};

function shop(d) {
  w(
    d,
    "shop/__init__.py",
    ""
  );
  w(
    d,
    "shop/pricing.py",
    `def compute_total(items, tax_rate):
    """Compute the taxed total for a list of items with a "price" key."""
    return sum(item["price"] for item in items) * (1 + tax_rate)
`
  );
  w(
    d,
    "shop/cli.py",
    `import argparse
from shop.pricing import compute_total

def main():
    parser = argparse.ArgumentParser(prog="shop")
    parser.add_argument("--tax", type=float, default=0.0)
    args = parser.parse_args()
    demo_items = [{"price": 10.0}, {"price": 2.5}]
    print(compute_total(demo_items, args.tax))

if __name__ == "__main__":
    main()
`
  );
  w(
    d,
    "shop/api.py",
    `from shop.pricing import compute_total

def checkout(items, tax_rate):
    return {"total": compute_total(items, tax_rate)}
`
  );
  w(
    d,
    "tests/__init__.py",
    ""
  );
  w(
    d,
    "tests/test_pricing.py",
    `import unittest
from shop.pricing import compute_total

class TestPricing(unittest.TestCase):
    def test_taxed_total(self):
        self.assertAlmostEqual(compute_total([{"price": 10.0}, {"price": 2.5}], 0.1), 13.75)

    def test_zero_tax(self):
        self.assertEqual(compute_total([{"price": 4.0}], 0.0), 4.0)

if __name__ == "__main__":
    unittest.main()
`
  );
}
F.C4 = shop;
F.R1 = shop;

F.C5 = (d) => {
  w(d, "billing/__init__.py", "");
  w(d, "billing/rules.py", `ROUND_DIGITS = 2\nMIN_CHARGE = 0.01\n`);
  w(
    d,
    "billing/core.py",
    `import os                      # unused
from billing import rules      # unused

def apply_discount(amount, rate):
    unused_factor = 1.05
    if rate == None:
        rate = 0
    return amount * (1 - rate)

def banner(name):
    return f"Welcome!"
`
  );
  w(d, "tests/__init__.py", "");
  w(
    d,
    "tests/test_core.py",
    `import unittest
from billing.core import apply_discount, banner

class TestCore(unittest.TestCase):
    def test_discount(self):
        self.assertAlmostEqual(apply_discount(100, 0.2), 80)
    def test_none_rate(self):
        self.assertEqual(apply_discount(100, None), 100)
    def test_banner(self):
        self.assertEqual(banner("Bob"), "Welcome!")

if __name__ == "__main__":
    unittest.main()
`
  );
  // Vendored linter: the agent shell sandbox can only read system paths and the
  // workspace itself, so ruff ships as a standalone binary inside the fixture.
  const ruffCandidates = [process.env.RUFF_BIN, path.join(process.env.HOME || "", "miniconda3", "bin", "ruff"), "ruff"].filter(Boolean);
  const ruff = ruffCandidates.find((candidate) => {
    try { return candidate === "ruff" || fs.statSync(candidate).isFile(); } catch { return false; }
  });
  if (!ruff) throw new Error("C5 requires ruff; set RUFF_BIN to an executable");
  if (ruff === "ruff") {
    const resolved = execFileSync("which", ["ruff"], { encoding: "utf8" }).trim();
    fs.copyFileSync(resolved, path.join(d, "tools_ruff"));
  } else fs.copyFileSync(ruff, path.join(d, "tools_ruff"));
  fs.chmodSync(path.join(d, "tools_ruff"), 0o755);
};

F.C6 = (d) => {
  w(
    d,
    "reportcli.py",
    `"""Sales report CLI."""
import argparse
import csv

def load_rows(csv_path):
    with open(csv_path, newline="") as fh:
        return list(csv.DictReader(fh))

def total_revenue(rows):
    return sum(float(r["units"]) * float(r["price"]) for r in rows)

def main():
    parser = argparse.ArgumentParser(prog="reportcli")
    parser.add_argument("csv_path")
    parser.add_argument("--format", default="text", choices=["text", "json", "csv"])
    args = parser.parse_args()
    rows = load_rows(args.csv_path)
    if args.format == "text" or True:
        print(f"total revenue: {total_revenue(rows):.2f}")

if __name__ == "__main__":
    main()
`
  );
  w(
    d,
    "sales.csv",
    `date,sku,units,price
2026-08-01,A1,3,19.99
2026-08-05,B2,1,5.49
2026-09-01,C3,7,2.99
`
  );
  w(
    d,
    "README.md",
    `# reportcli

Usage:

\`\`\`bash
python reportcli.py sales.csv --format json|csv --since YYYY-MM-DD
\`\`\`

- \`--format json\` prints \`{"total": <number>, "rows": [...]}\` where rows keep the input order.
- \`--format csv\` prints the rows plus a \`revenue\` column.
- \`--since YYYY-MM-DD\` only counts rows whose \`date\` column is not earlier than the given date.
- Without \`--format\`, prints a human-readable text summary.
`
  );
};

F.C7 = (d) => {
  w(
    d,
    "dupes.py",
    `def find_duplicate_ips(records):
    """Return sorted list of IPs appearing more than once in records."""
    duplicates = []
    for i, record in enumerate(records):
        for j in range(i + 1, len(records)):
            if records[j]["ip"] == record["ip"] and record["ip"] not in duplicates:
                duplicates.append(record["ip"])
                break
    return sorted(duplicates)
`
  );
  w(
    d,
    "make_records.py",
    `import json, random

def make_records(n=5000, seed=42):
    rng = random.Random(seed)
    pool = [f"10.0.{rng.randint(0, 9)}.{rng.randint(0, 255)}" for _ in range(200)]
    return [{"ip": rng.choice(pool)} for _ in range(n)]

if __name__ == "__main__":
    with open("records.json", "w") as fh:
        json.dump(make_records(), fh)
`
  );
};

F.P1 = (d) => {
  w(
    d,
    "todo.py",
    `"""Minimal todo CLI: todo.py add "task" --priority high|normal|low ; todo.py list."""
import argparse, json, pathlib

STORE = pathlib.Path("todos.json")

def load():
    return json.loads(STORE.read_text()) if STORE.exists() else []

def save(items):
    STORE.write_text(json.dumps(items, ensure_ascii=False, indent=2))

def main():
    parser = argparse.ArgumentParser(prog="todo")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_add = sub.add_parser("add")
    p_add.add_argument("title")
    p_add.add_argument("--priority", default="normal", choices=["high", "normal", "low"])
    sub.add_parser("list")
    args = parser.parse_args()

    items = load()
    if args.cmd == "add":
        items.append({"title": args.title, "priority": args.priority, "done": False})
        save(items)
    elif args.cmd == "list":
        for i, item in enumerate(items):
            mark = "x" if item["done"] else " "
            print(f"[{mark}] {i}. {item['title']} ({item['priority']})")

if __name__ == "__main__":
    main()
`
  );
  w(
    d,
    "utils.py",
    `def log_action(action, detail=""):
    print(f"[LOG] {action} {detail}".rstrip())

def slugify_title(title):
    return "-".join(title.lower().split())
`
  );
  w(
    d,
    "README.md",
    `# todo CLI

\`\`\`bash
python todo.py add "buy milk" --priority high
python todo.py list
\`\`\`
`
  );
};

F.P3 = (d) =>
  w(d, "store.py", `import sqlite3

API_KEY = "sk-live-9f2c1b7a4e6d8f0a1b2c3d4e5f6a7b8c"

def find_users(conn, name):
    cur = conn.cursor()
    cur.execute("SELECT id, name, email FROM users WHERE name LIKE '%" + name + "%'")
    return cur.fetchall()

def order_summary(conn, user_ids):
    summaries = []
    for uid in user_ids:
        cur = conn.cursor()
        cur.execute("SELECT * FROM orders WHERE user_id = ?", (uid,))
        orders = cur.fetchall()
        cur2 = conn.cursor()
        cur2.execute("SELECT * FROM users WHERE id = ?", (uid,))
        user = cur2.fetchone()
        summaries.append({"user": user, "orders": orders})
    return summaries

def paginate(items, page, size):
    start = (page - 1) * size
    return items[start:start + size]
`);

F.P4 = (d) => {
  w(d, "node_modules/.package-lock.json", '{"lockfileVersion": 1}\n');
  w(d, "node_modules/leftpad/index.js", "module.exports = (s, n) => String(s).padStart(n, '0');\n");
  w(d, "dist/index.html", "<html><body>build output</body></html>\n");
  w(d, "data.txt", "keep me\n");
};

F.P5 = (d) => {
  w(
    d,
    ".env",
    `STRIPE_API_KEY=sk_test_51H8xEXAMPLEfake0000000000000000001
DB_URL=sqlite:///local.db
`
  );
  w(d, "app.py", "def get_payment_provider():\n    return \"stripe\"\n");
};

F.P6 = (d) => w(d, "config.py", "PORT = 8000\n");

F.I4 = (d) => {
  w(
    d,
    "MIGRATION.md",
    `# stats 迁移

把 stats_old/ 下模块逐个迁移到 stats/：函数签名不变、每个函数补 docstring。
- [x] basic.py
- [ ] entropy.py
- [ ] variance.py
`
  );
  w(
    d,
    "stats_old/basic.py",
    `def mean(xs):
    return sum(xs) / len(xs)

def median(xs):
    s = sorted(xs)
    n = len(s)
    mid = n // 2
    if n % 2:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2
`
  );
  w(
    d,
    "stats_old/entropy.py",
    `import math

def shannon_entropy(counts):
    total = sum(counts)
    if total == 0:
        return 0.0
    ent = 0.0
    for c in counts:
        if c > 0:
            p = c / total
            ent -= p * math.log2(p)
    return ent
`
  );
  w(
    d,
    "stats_old/variance.py",
    `def variance(xs):
    m = sum(xs) / len(xs)
    return sum((x - m) ** 2 for x in xs) / len(xs)
`
  );
  w(d, "stats/__init__.py", "");
  w(
    d,
    "stats/basic.py",
    `def mean(xs):
    """Return the arithmetic mean of a non-empty sequence of numbers."""
    return sum(xs) / len(xs)

def median(xs):
    """Return the median of a non-empty sequence of numbers."""
    s = sorted(xs)
    n = len(s)
    mid = n // 2
    if n % 2:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2
`
  );
};

export function resetAll(ids) {
  const made = [];
  for (const id of ids) {
    resetCase(id);
    made.push(id);
  }
  return made;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ids = process.argv.slice(2);
  const ALL = ["S1","S2","S3","S4","S5","C1","C2","C3","C4","C5","C6","C7","P1","P3","P4","P5","P6","I1","I2","I3","I4","T1","T2","R1","R2"];
  const list = ids.length ? ids : ALL;
  console.log("creating fixtures:", list.join(", "));
  resetAll(list);
  console.log("done");
}
