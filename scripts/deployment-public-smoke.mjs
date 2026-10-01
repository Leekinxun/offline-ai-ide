#!/usr/bin/env node
// Public GET-only deployment checks. No credentials, login, Agent requests or project API reads.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

const hash = (content) => crypto.createHash('sha256').update(content).digest('hex');
function originFor(value) {
  const url = new URL(value);
  assert.ok(['http:', 'https:'].includes(url.protocol), 'Use an HTTP(S) deployment origin');
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Use only an origin, without credentials, paths or query parameters');
  return url.origin;
}

async function publicChecks(address, expectedIndexHash) {
  const origin = originFor(address);
  async function get(route, expectedStatus, contentType, extraHeaders = {}) {
    const response = await fetch(new URL(route, origin), {
      method: 'GET', redirect: 'manual', credentials: 'omit',
      headers: { Accept: contentType, ...extraHeaders }, signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, expectedStatus, `${route}: expected HTTP ${expectedStatus}, received ${response.status}`);
    assert.ok(contentType.split('|').some((value) => response.headers.get('content-type')?.includes(value)), `${route}: unexpected Content-Type`);
    if (Number(response.headers.get('content-length')) > 4 * 1024 * 1024) throw new Error(`${route}: oversized response`);
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 4 * 1024 * 1024) throw new Error(`${route}: oversized response`);
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks), cacheControl: response.headers.get('cache-control') };
  }
  const health = await get('/api/health', 200, 'application/json');
  assert.equal(JSON.parse(health.bytes.toString()).status, 'ok', 'Health payload is not ready');
  // An explicit invalid marker prevents desktop loopback auto-session bootstrap.
  const auth = await get('/api/auth/me', 401, 'application/json', { Authorization: 'Bearer deployment-negative-test-not-a-session' });
  assert.match(auth.cacheControl || '', /no-store/i, 'Auth response must not be cached');
  await get('/api/runtime/sandbox', 401, 'application/json');
  const page = await get('/login', 200, 'text/html');
  const html = page.bytes.toString();
  const indexSha256 = hash(page.bytes);
  if (expectedIndexHash) assert.equal(indexSha256, expectedIndexHash, 'Served HTML differs from the expected deployment artifact');
  const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map(([tag]) => tag)
    .filter((tag) => attribute(tag, 'type') === 'module').map((tag) => attribute(tag, 'src')).filter(Boolean);
  const styles = [...html.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => tag)
    .filter((tag) => attribute(tag, 'rel') === 'stylesheet').map((tag) => attribute(tag, 'href')).filter(Boolean);
  assert.ok(scripts.length > 0 && scripts.length + styles.length <= 12, 'Expected bounded production entry assets');
  const assets = [];
  for (const [kind, paths] of [['module', scripts], ['stylesheet', styles]]) {
    for (const source of paths) {
      const url = new URL(source, origin);
      assert.ok(url.origin === origin && url.pathname.startsWith('/assets/') && !url.search && !url.hash, 'Only same-origin production assets are checked');
      const result = await get(url.pathname, 200, kind === 'module' ? 'javascript' : 'text/css');
      assets.push({ kind, path: url.pathname, bytes: result.bytes.length, sha256: hash(result.bytes) });
    }
  }
  return { passed: true, checks: ['http_ready', 'invalid_session_rejected', 'sandbox_requires_auth', 'frontend_entry_assets'], indexSha256, assets,
    unverified: ['authenticated_admin_diagnostics', 'sandbox_canary', 'browser_approval_interactions', 'provider_or_model_availability'] };
}

async function selfTest() {
  const requests = [];
  let publicSandbox = false;
  const html = '<!doctype html><script type="module" crossorigin src="/assets/test.js"></script><link rel="stylesheet" href="/assets/test.css">';
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.url === '/api/health') { res.setHeader('Content-Type', 'application/json'); res.end('{"status":"ok"}'); }
    else if (req.url === '/api/auth/me') {
      assert.equal(req.headers.authorization, 'Bearer deployment-negative-test-not-a-session');
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"error":"Unauthorized"}');
    } else if (req.url === '/api/runtime/sandbox') { res.writeHead(publicSandbox ? 200 : 401, { 'Content-Type': 'application/json' }); res.end('{}'); }
    else if (req.url === '/login') { res.setHeader('Content-Type', 'text/html'); res.end(html); }
    else if (req.url === '/assets/test.js') { res.setHeader('Content-Type', 'text/javascript'); res.end('export const fixture = true;'); }
    else if (req.url === '/assets/test.css') { res.setHeader('Content-Type', 'text/css'); res.end('body { color: black; }'); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const result = await publicChecks(origin, hash(html));
    assert.equal(result.passed, true); assert.equal(result.assets.length, 2);
    await assert.rejects(publicChecks(origin, '0'.repeat(64)), /differs from the expected/);
    publicSandbox = true;
    await assert.rejects(publicChecks(origin), /expected HTTP 401, received 200/);
    assert.ok(requests.every((request) => request.method === 'GET'));
    assert.ok(requests.every((request) => ['/api/health', '/api/auth/me', '/api/runtime/sandbox', '/login', '/assets/test.js', '/assets/test.css'].includes(request.url)));
    assert.throws(() => originFor('https://username:password@example.test'), /without credentials/);
    return { passed: true, selfTest: 'public endpoints, asset digest, auth boundary, GET-only allowlist' };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') console.log(JSON.stringify(await selfTest()));
  else {
    let url, expectedIndexHash;
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--url') url = args[++index];
      else if (args[index] === '--expected-index-sha256') expectedIndexHash = args[++index];
      else throw new Error('Usage: node scripts/deployment-public-smoke.mjs --url https://host [--expected-index-sha256 HASH] | --self-test');
    }
    assert.ok(url, '--url is required');
    if (expectedIndexHash !== undefined) assert.match(expectedIndexHash, /^[a-f0-9]{64}$/i, 'Expected an SHA-256 digest');
    console.log(JSON.stringify(await publicChecks(url, expectedIndexHash?.toLowerCase())));
  }
} catch (error) {
  // Never include response bodies, headers, supplied URLs or credentials.
  console.error(JSON.stringify({ passed: false, error: error instanceof Error ? error.message.split('\n')[0] : 'Public deployment check failed' }));
  process.exitCode = 1;
}
