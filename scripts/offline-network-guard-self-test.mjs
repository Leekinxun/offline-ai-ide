import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";

assert.equal(process.env.WS15_OFFLINE_GUARD, "1", "offline guard must be enabled");
const externalHost = "ws15-external-network.invalid";
function expectSynchronousDenial(kind, operation) {
  let denied; let resource;
  try { resource = operation(); resource?.on?.("error", () => {}); resource?.destroy?.(); }
  catch (error) { denied = error; }
  assert.equal(denied?.code, "WS15_EXTERNAL_NETWORK_DENIED", `external ${kind} was not rejected by the Node guard: ${denied || "no error"}`);
}
expectSynchronousDenial("tcp", () => net.connect({ host: externalHost, port: 443 }));
expectSynchronousDenial("http", () => http.get(`http://${externalHost}/probe`));
expectSynchronousDenial("https", () => https.get(`https://${externalHost}/probe`));
let fetchDenied;
try { await fetch(`https://${externalHost}/probe`); }
catch (error) { fetchDenied = error; }
assert.equal(fetchDenied?.code, "WS15_EXTERNAL_NETWORK_DENIED", `external fetch was not rejected by the Node guard: ${fetchDenied || "no error"}`);

const response = await new Promise((resolve, reject) => {
  const server = http.createServer((_request, result) => { result.end("loopback-ok"); });
  server.listen(0, "127.0.0.1", async () => {
    try {
      const address = server.address();
      const value = await fetch(`http://127.0.0.1:${address.port}`).then((item) => item.text());
      server.close(() => resolve(value));
    } catch (error) { server.close(() => reject(error)); }
  });
});
assert.equal(response, "loopback-ok");
process.stdout.write("WS-15 Node egress guard passed (TCP, HTTP, HTTPS, and fetch denied externally; loopback allowed).\n");
