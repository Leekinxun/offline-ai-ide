# Deployment verification without model calls

Use the following checks for an already authorized deployment. They do not require
an Agent prompt, changes to a user project, new accounts, or a model-provider call.
Keep application readiness, sandbox readiness and browser interaction evidence
separate: a successful `/api/health` response does not prove that Agent commands
can execute safely.

## 1. Preserve the rollback identity

Before replacement, record the currently deployed image ID/digest, Compose revision,
service security-profile filenames/digests, mounted volume identities and public
frontend `index.html` digest. Record the same identifiers for the candidate.
Do not dump container environment, application settings, users, tokens or passwords
into the evidence. Configuration/volume changes are not required for these checks.

## 2. Public HTTP and static assets

Run the credential-free checker from the operator's local checkout:

```sh
node scripts/deployment-public-smoke.mjs \
  --url https://<authorized-deployment-host> \
  --expected-index-sha256 <candidate-static-index-sha256>
```

The optional digest must come from the candidate's built `static/index.html`, not
from an old checkout. The checker uses only GET requests, refuses redirects and
credential-bearing URLs, and never reads a token. It checks:

- `/api/health` returns HTTP 200 and `status: ok`.
- `/api/auth/me` rejects an intentionally invalid session marker with HTTP 401
  and `Cache-Control: no-store`; this marker also prevents desktop auto-login.
- `/api/runtime/sandbox` rejects an unauthenticated caller with HTTP 401.
- `/login` serves HTML, and its same-origin production JavaScript/CSS entry assets
  exist with the right content types. The result includes their SHA-256 digests.

This check does not read any workspace endpoint or request model health. Its
isolated local test is `node scripts/deployment-public-smoke.mjs --self-test`.

## 3. Existing authenticated administrator session

The authorized operator can use their existing browser session to GET
`/api/auth/me` and `/api/runtime/sandbox`. Keep the token in the browser/session;
do not paste it into a command, report or screenshot. `/api/auth/me` includes a
token in its response, so retain only the status and needed account/role fields.
Do not GET `/api/admin/settings` for this deployment check.

The sandbox response must be HTTP 200, `Cache-Control: no-store`, and show
`filesystem.available`, `network.available` and `executionReady` all true.
Diagnostics are cached for 30 seconds: after a runtime-policy change, restart the
affected service or wait for a new `checkedAt` value before assessing it. The
endpoint accepts no command, path or workspace arguments. A non-admin caller
should receive HTTP 403; do not create a user solely to repeat the existing
authorization tests.

## 4. Fixed sandbox canary as the service account

Execute the shipped fixed canary in the deployed container, using its actual
service UID/GID and working directory. For the standard image these are
`10001:10001` and `/app`:

```sh
docker exec --user 10001:10001 --workdir /app <authorized-container> \
  node --input-type=module -e '
    import { runSandboxSelfTest } from "./dist/run/sandboxDiagnostics.js";
    const result = await runSandboxSelfTest();
    console.log(JSON.stringify(result));
    const expected = ["allowedRead", "allowedWrite", "outsideWriteDenied",
      "secretReadDenied", "controlWriteDenied", "nullDeviceWritable",
      "parentNetworkDenied", "condaPythonVisible", "condaRuffVisible"];
    const procMode = result.diagnostics.linux?.procMode;
    if (procMode === "none") expected.push("payloadProcAbsent");
    if (!["private", "none"].includes(procMode)) process.exitCode = 1;
    if (!result.passed || expected.some(key => result.checks?.[key] !== true))
      process.exitCode = 1;
  '
```

All nine baseline checks are required for the standard Linux image; explicit
`procMode: none` additionally requires `payloadProcAbsent: true`. The canary creates its
own temporary workspace, outside-file sentinel and local TCP listener; it cleans
them in `finally`. It never uses the active user workspace or a model. Run it with
the same security restrictions as the application, not as root or in a separate
privileged container. A host-side or macOS pass cannot replace this result.

Also confirm the running server's effective UID/GID, zero effective capabilities,
`NoNewPrivs: 1`, `Seccomp: 2`, reviewed AppArmor profile, read-only root filesystem
and unchanged workspace/config volume identities. A sandbox failure remains a
deployment blocker for Agent shell, even if the HTTP checker succeeds. Keep the
specific diagnostic; do not retry through an unsandboxed terminal or weaken the
container globally.

### Explicit no-proc compatibility mode

The default Linux mode remains a private `/proc` mount. On the affected target
kernel, that private mount was refused with `EPERM` while Docker's normal masked
paths remained enabled. An operator can explicitly select
`CROWNFORGE_SANDBOX_PROC_MODE=none` for this service. This mode omits `/proc`
inside the Agent payload; it does not bind the parent container's `/proc`, remove
Docker masks, drop namespace isolation, or fall back to unsandboxed execution.
An unset value uses `private`; an invalid value must fail closed rather than
silently select `none`.

The selected configuration for this target deployment is **explicit `none`**, not
private-proc mode with a successful mount. Keep that distinction in the deployment
result and any supported-command claims.

Verify `diagnostics.linux.procMode` equals the selected mode. In `none`, the fixed
canary must additionally show `checks.payloadProcAbsent: true`, based on the
payload observing `ENOENT` for `/proc`. Every previous filesystem, network,
device and Conda check must still pass. A zero exit code with a missing proc
check is insufficient evidence for this mode.

This has a concrete compatibility cost. In the target-container experiment,
Node version output, Conda Python, Ruff and a simple npm check worked, but
`process.memoryUsage()` and `process.memoryUsage.rss()` failed with `ENOENT`.
Tools requiring procfs for memory/process inspection, debugging or runtime
discovery can therefore fail. The successful simple npm check does not prove
that a project's test runner, development server or build pipeline supports
this mode. Report such failures as a mode limitation; validate needed commands
on disposable inputs before claiming compatibility. Do not conceal the failure
by automatically retrying with weaker isolation.

### Persisting the selected mode and security profiles with Compose

Keep the default Compose file unchanged. The reviewed optional
[`docker-compose.sandbox.yml`](../../docker-compose.sandbox.yml) sets service
`ai-ide` using this parameter shape:

```yaml
services:
  ai-ide:
    environment:
      CROWNFORGE_SANDBOX_PROC_MODE: none
    security_opt:
      - "no-new-privileges:true"
      - "seccomp=${CROWNFORGE_SECCOMP_PROFILE:?Set the absolute client-side JSON path}"
      - "apparmor=crownforge-bwrap"
```

Identify the implementation with the executable type and version output, not its
filename or installation directory. The target's executable is a Go ELF binary
reporting version `dev`, despite being named `docker-compose` under a Python
environment directory. Its actual rendered configuration must therefore be
checked on that host; the following Python v1 details are compatibility
information, not a claim about that executable.

Python `docker-compose` **1.29.2** reads the seccomp JSON file on the Compose
client, then sends its serialized content to Docker. Its parser accepts both
`seccomp=/absolute/path.json` and `seccomp:/absolute/path.json`; use the former
consistently. Supply an absolute host/client path to avoid working-directory
ambiguity. Do not provide a container path or inline JSON in place of that file.
This is verified against the versioned
[Compose v1 parser](https://github.com/docker/compose/blob/1.29.2/compose/config/types.py#L470-L491)
and [host-config construction](https://github.com/docker/compose/blob/1.29.2/compose/service.py#L1006-L1040).
If the installed Python Compose is another version, check that version's parser
before relying on the same behavior.

AppArmor uses the **loaded profile name**, not its policy-file path. Load the
reviewed service-specific policy on the Docker host before creating the
container, and preserve its host boot-time loading mechanism. Docker documents
the load step as `apparmor_parser -r -W <profile-file>` and the container option
as `apparmor=<profile-name>`. See the
[official AppArmor instructions](https://docs.docker.com/engine/security/apparmor/).

Use the same established project name and ordered file list for every validation,
create, update and rollback. For example, after setting the non-secret
seccomp profile variable in a persistent operator-owned launcher:

```sh
docker-compose -p <existing-project> \
  -f /absolute/deployment/docker-compose.yml \
  -f /absolute/deployment/docker-compose.sandbox.yml config --quiet

docker-compose -p <existing-project> \
  -f /absolute/deployment/docker-compose.yml \
  -f /absolute/deployment/docker-compose.sandbox.yml \
  up -d --no-deps --force-recreate ai-ide
```

This example updates an already initialized deployment; it does not replace the
initial mount-permissions setup. Persist the launcher/file list in the actual
deployment service or automation, not only the current interactive shell.
`COMPOSE_FILE` can also hold the ordered file list, but explicit `-f` flags take
precedence, so do not mix a launcher using both files with a later one-file
command. The [Compose CLI documentation](https://docs.docker.com/reference/cli/docker/compose/)
describes file ordering and `COMPOSE_FILE`. An ordinary container restart retains
the options of that existing container; it does not apply edited Compose
environment or security settings. Recreate the service to apply changes.

After recreation, verify the actual container has exactly one intended seccomp
profile, the expected AppArmor profile, `no-new-privileges`, unchanged Docker
masked/read-only paths, and `CROWNFORGE_SANDBOX_PROC_MODE=none`. Multiple Compose
files can merge security option lists, so do not leave an older conflicting
seccomp/AppArmor entry in an additional override. Store profile file digests and
the selected proc mode with the image rollback identity. Repeat the full canary
after a recreate and after restoring a previous image/profile pair.

## 5. Browser approval visibility without production inference

Opening an authenticated workbench normally requests `/api/chat/model-health`,
which contacts the configured provider's `/models` endpoint. For a strictly
zero-provider browser check, block that request in the operator-owned browser
context before navigation and report model availability as unverified.

Without sending a prompt, production checks can establish that the new assets
load, authenticated navigation works, and an already-pending operator-owned
approval (if one exists) remains visible with “Waiting for approval / View
approvals.” Do not approve someone else's pending action, inject synthetic
approval events, or claim the end-to-end approval path passed from static text.

For the full interaction evidence, use the same candidate frontend/backend
revision in the existing isolated loopback fixture and run:

```sh
node scripts/web-agent-fixture.mjs
# In another terminal, using that fixture's printed workspace and URL:
node scripts/web-agent-browser-smoke.mjs --launch --approval \
  --url http://127.0.0.1:<fixture-port> --workspace <fixture-workspace> \
  --artifacts <operator-owned-temporary-artifact-directory>
```

This intentionally uses the fixture's local deterministic model, not production
settings. It verifies medium-risk bulk ACK, high-risk retention after a zero-item
bulk ACK, both UI entry points, actual mouse approval at 600px height and final
success with only its expected temporary-file change. The recorded local result
for this change is 8/8; this proves UI behavior for the tested revision, while the
deployed-container canary proves the target host's sandbox behavior.

## 6. Rollback verification

If the candidate fails, restore the recorded application image/static artifact
and service-specific runtime-profile revision while preserving existing data
volumes. Do not roll back user project contents or overwrite newer persistent
settings as an incidental part of application rollback. In-memory login sessions
may be invalid after restart; HTTP 401 then requires normal operator re-login,
not a configuration reset.

Repeat the public checker against the recorded previous HTML digest, the
authenticated diagnostic and fixed canary. Confirm the restored image/profile
identity and existing volume identities, and inspect previously running tasks for
an explicit interrupted/stopped state rather than assuming they survived restart.
If the former runtime already failed its sandbox canary, rollback restores
availability only; it does not resolve that pre-existing execution blocker.
