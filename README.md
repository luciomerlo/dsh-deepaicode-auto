# dsh-deepaicode-auto

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that registers the
**DeepAI Code** model catalog as an LLM provider and adds a single virtual model,
**`Auto (DeepAiCode)`**, which routes every request through a Frontier → Unmetered ladder and
fails over transparently instead of dropping a turn.

- Provider route: `deepaicode`
- Virtual model id: `auto` (displayed as `Auto (DeepAiCode)`)
- Settings page: **Settings → DeepAI Code**, for connecting and inspecting the account
- API: the `deepaicode_free_models` tool reports and re-verifies the free tier
- Runtime: pure ESM JavaScript, no build step, no runtime dependencies on any `@deepseek-ai/*`
  package
- Licence: MIT

---

## Why this exists

DeepAI Code is a desktop coding agent with a generous daily credit allowance ("Theos") and a set
of models that cost nothing per request. Its upstream is an OpenAI-compatible surface gated on
looking like the official desktop client. This bundle speaks that protocol directly from the
Harness Host process — no desktop app, no local gateway, no proxy process — and adds the routing
layer the desktop app does not have: strict capability ordering with automatic, per-turn
failover.

---

## Architecture

### Request path

```
composer / /model
      │
      ▼
DeepSeek Harness llm service ──── ctx.llm.registerAdapter(['deepaicode'], adapter)
      │
      ▼
DeepAiAdapter.stream(options)          src/adapter.js
      │
      ├── model === "auto"  ──► AutoRouter.plan()      src/router.js
      └── any other model   ──► a single rung of the ladder
      │
      ▼
DeepAiClient.openStream()              src/client.js
      │   Api-Key · X-DeepAI-Code-Theos · X-DeepAI-Code-Instance
      │   X-DeepAI-Code-Machine · User-Agent: node · X-Session-Affinity
      ▼
POST /deepai_code/chat/completions     (or /responses for openai-responses models)
      │
      ▼
toStreamChunks()  ── SSE watchdog ──►  StreamChunk[]
      │                                src/stream.js + src/sse.js
      ▼
DeepSeek Harness BlockAssembler → assistant message + tool calls
```

### The routing ladder

`buildLadder()` (`src/models.js`) merges two sources into two ordered rungs:

| Rung | Source of truth | Cost |
|---|---|---|
| **Frontier** | Configured order (capability, highest first), then catalog-discovered models sorted by price | Theos per request |
| **Unmetered** | Configured order | `0` |

The live catalog always wins on price: if `/models` reports a different `theosPerRequest` than a
configured row, the catalog value is used. Models the catalog adds that the configuration does
not mention are appended, so a model DeepAI ships tomorrow is routable today without a release
here.

`AutoRouter.plan()` then produces the attempt order:

1. Every Frontier rung that is neither cooling down nor retired **and** whose published cost still
   fits inside the reported balance.
2. Every Unmetered rung, in configured priority order.

Unmetered models never consume allowance, so they are ordered by usefulness rather than price.
An unknown balance is treated as sufficient — the router prefers a Frontier model rather than
guessing conservatively.

### Failover pipeline

`runChain()` (`src/adapter.js`) walks the plan and reacts to the class the router assigns to each
failure (`classifyFailure()`):

| Class | Trigger | Reaction |
|---|---|---|
| `auth` | `401`, `auth_required`, `invalid_api_key`, `email_unverified` | Abort the chain. A credential problem is not the model's fault, so no model is cooled and no Theos are wasted on more attempts. |
| `quota` | `403` `theos_exhausted` / `network_bound` / `check_in_refused`, `429` | Retire the model for the day. The Frontier balance is treated as spent. |
| `busy` | `409 session_busy` | 15 s cooldown, next model. |
| `rejected` | `400`, `413`, `422`, `MALFORMED_RESPONSE`, `EMPTY_RESPONSE` | 10 min cooldown, next model. |
| `transient` | `5xx`, timeout, transport reset, mid-stream cut | 60 s cooldown, next model. |
| `lane` | `426 lane_version_unsupported` | Re-probe the lane header (cooldown-limited) and retry the same model once. |

Each failure also triggers a background catalog refresh, so a model that broke because DeepAI
changed something is re-read rather than assumed dead.

**No-replay guarantee.** Failover happens only while nothing has been shown to the user. Once the
first text, reasoning or tool-call block is emitted, a later failure is reported as an error
finish instead of being replayed against another model — silently replacing visible output would
be worse than an honest error.

### SSE watchdog

A stream that opens successfully and then goes quiet is indistinguishable from a slow model.
`src/sse.js` races every body read against `streamIdleTimeoutMs` (default 90 s). When the deadline
wins, the body iterator is released (which cancels the upstream request) and a `StreamIdleError`
carrying `code: 'TIMEOUT'` is raised, so the stall is classified as `transient` and fails over to
the next model. Without the watchdog a stalled connection would hang the turn indefinitely.

### Catalog and allowance lifecycle

- **On start:** resolve the machine fingerprint, resolve the credential, probe the accepted lane,
  verify the free tier against `/models`, then run one `/theos` check-in and publish the reported
  balance.
- **On failure:** background `/models` refresh and a tier rebuild.
- **Every day:** the free tier is verified again (see below).
- **Periodically:** `/theos` at most once a minute, and the `/theos` check-in cycle on its own
  schedule (minimum 30 s between attempts, `check_in` TTL/2 refresh, 6 h silence after a
  `check_in_refused`).
- **Daily reset:** the router clears retired models at the next UTC midnight, or as soon as a
  positive balance is reported again.

### Free tier verification

The unmetered tier is only useful while its members really cost nothing, so membership is
re-established rather than remembered.

- **The live catalog is the authority.** It decides which models exist and what each one costs. A
  model configured as free that upstream now charges for **moves to the Frontier tier** instead of
  being spent as if it were free; a configured model the catalog no longer lists leaves the ladder;
  a Frontier model the catalog now prices at zero is advertised as free.
- **Cadence:** once every `verifyFreeModelsEveryMs` (24 h), at start, and on any manual refresh.
  The schedule is a chained timer, never an interval, so a slow check cannot overlap the next one,
  and it is clamped to at least one minute.
- **Report:** the check records which models are free now, which newly became free, which became
  paid, which vanished from the catalog, and when the next check runs. It is persisted at
  `$DSH_HOME/deepaicode/free-models.json`, so "last verified" survives a restart and the first
  check of a new session compares against the last real one instead of reporting everything as
  new.
- **Unverified state is explicit.** Without a credential the catalog cannot be read, so the tier
  falls back to the published table and both surfaces say *not verified* rather than pretending
  the list is current.

Read it from either surface:

| Surface | How |
|---|---|
| **Web** | **Settings → DeepAI Code → Free models**: the count, the free ids, what changed at the last check, and when the next one runs. *Refresh* verifies immediately. |
| **API** | The `deepaicode_free_models` tool. Call it with no arguments for the last report, or `verify: true` to re-read the catalog and rebuild the tiers now. |

### Allowance accounting is deliberately conservative about guessing

Upstream bills a Frontier request **per token**, not per request: a model published as "~15
Theos" costs a fraction of that for a short answer. The plugin therefore never decrements a local
counter — the balance reported by `/theos` is the only authority. The published cost is used only
as the threshold that decides whether starting a Frontier model is worth the attempt.

---

## Routing modes

| Mode | How to select | Behaviour |
|---|---|---|
| **Auto (DeepAiCode)** | Pick `Auto (DeepAiCode)` in the model picker or with `/model` | Frontier first, unmetered when the allowance or a failure demands it, failover on every classified failure. |
| **Explicit model** | Pick any listed model | That model only. A failure is reported rather than silently spending Theos on another model. |
| **Explicit + failover** | Set `failoverExplicitModels: true` | The chosen model first, then the rest of the ladder, with the same no-replay guarantee. |

Every model is also listed individually with its price (`15 Theos`) or `Unmetered · 0 Theos`, so a
specific model is always one click away.

---

## Requirements

- DeepSeek Harness `0.2.2-rc.5` or newer (no `engines.dsh` constraint is declared, so the market
  shows it as compatible everywhere).
- A DeepAI account with access to DeepAI Code: Google or Apple sign-in, or DeepAI Pro with a
  verified email. A free account includes the daily Theos allowance.
- Network access to `https://api.deepai.org`.
- Git and `pnpm` on the machine that installs the bundle (the Plugin Manager supplies both).

---

## Installation

### Option A — DeepSeek Harness Plugin Market (custom index)

The repository ships a format-1 plugin market index at
[`index.json`](./index.json):

```
https://raw.githubusercontent.com/luciomerlo/dsh-deepaicode-auto/main/index.json
```

1. Open **Plugins** in the DeepSeek Harness sidebar.
2. Add the URL above as a plugin index source (**Add source** / **Discover**).
3. Find **DeepAI Code router**, install it, and enable it.

The index pins an exact commit, so an install is reproducible. Removing the source does not
uninstall an already-installed copy.

### Option B — Manual install from a local checkout

```bash
git clone https://github.com/luciomerlo/dsh-deepaicode-auto.git
cd dsh-deepaicode-auto
npm run build   # manifest/locale/icon/market checks + the full test suite
```

Then, in the DeepSeek Harness GUI, open **Plugins** → **Add plugin** and select the cloned
directory. The bundle is linked, not copied, so edits take effect on reload.

If you drive the Host programmatically, the same step is the `plugin_manager` tool with
`action: install_bundle` and the absolute directory as `target`.

### Option C — Install into a specific profile with the CLI

```bash
dsh --profile <profile> plugin add /absolute/path/to/dsh-deepaicode-auto
```

The Desktop application manages its own `desktop` profile exclusively; use the GUI for that one.

### After installing

Open the composer model picker (or type `/model`) and select the **DeepAI Code** group. The first
model in the group is **Auto (DeepAiCode)**. The first start may open a browser tab for sign-in.

---

## Authentication

The plugin needs the account's `Api-Key` (a UUID). It resolves one from the first available
source:

1. `config.apiKey` on the loader row.
2. `DEEPAI_CODE_API_KEY` or `DEEPAI_API_KEY` in the process environment (see `.env.example`).
3. `$DSH_HOME/deepaicode/account.json` — written by this plugin, mode `0600`.
4. The credential the **DeepAI Code desktop app** already stored, so an installed app needs no
   second sign-in.
5. A browser sign-in started from the settings page: an RFC 8252 loopback flow. The plugin binds
   `127.0.0.1` on a free port, opens `GET /deepai_code/desktop_auth/?state=…&port=…`, receives the
   authorization code on `127.0.0.1/auth-callback`, and exchanges it at
   `POST /deepai_code/desktop_auth/exchange/`.

### Connect from Settings

**Settings → DeepAI Code** is the supported way to connect, re-check, or disconnect an account:

- **Connection** — whether a credential is live and which of the five sources supplied it.
  *Connect with browser* starts the loopback sign-in and opens the DeepAI page; the page polls the
  Host and flips to *Connected* when the browser callback lands. *Disconnect* forgets the stored
  key. When a key comes from configuration or the environment, disconnecting says so instead of
  pretending to succeed.
- **Daily allowance** — the Theos balance and daily grant `/theos` reported, with the refresh
  time.
- **Paste an account key** — for machines where the browser flow cannot run. The key is proven
  against `/theos` before it is stored, and refused with the upstream message when it does not
  work.
- **Routing** — the accepted lane, catalog size and freshness, how many Frontier and unmetered
  models are ready right now, and the last fallbacks Auto performed.

The page talks to the plugin's own Host routes under `/deepaicode/*`; those routes sit behind the
composition's connection trust fence (Host/Origin check plus browser authentication), so nothing
is reachable without the GUI's own session.

Set `autoSignIn: true` only for a profile with no Web GUI, where there is no page to sign in
from; it opens the browser during startup instead.

**Machine fingerprint.** Upstream grants the daily allowance per account *and* machine. The plugin
reads the hardware UUID (`MachineGuid` then `Win32_ComputerSystemProduct.UUID` on Windows,
`IOPlatformUUID` on macOS, `/etc/machine-id` on Linux), hashes it, and sends only the digest —
the raw identifier never leaves the machine. The digest is cached at
`$DSH_HOME/deepaicode/machine.json`. `DEEPAI_MACHINE_ID` overrides the detected value.

---

## Configuration

Override any key in the profile's `cordis.patch.yml` by targeting the row id `llm-deepaicode`.
A Config mapping replaces the whole default block, so copy the keys you want to keep.

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `https://api.deepai.org` | Upstream origin. |
| `modelBase` | `/deepai_code` | Endpoint prefix. |
| `lane` | `7` | `X-DeepAI-Code-Theos` value. Re-probed automatically on `426`. |
| `appVersion` | `0.3.42` | Version reported in the check-in beacon. |
| `userAgent` | `node` | User agent. Upstream expects the Node default. |
| `apiKey` | `''` | Explicit credential, ahead of every other source. |
| `autoModelId` | `auto` | Id of the virtual routing model. |
| `autoModelName` | `Auto (DeepAiCode)` | Display name of the virtual routing model. |
| `dailyTheosBudget` | `250` | Allowance ceiling used until upstream reports a real one. |
| `maxFailovers` | `8` | Maximum models tried for one request. |
| `refreshCatalogOnError` | `true` | Re-read `/models` after a model failure. |
| `autoSignIn` | `false` | Start the browser sign-in during startup, for profiles with no settings page. |
| `failoverExplicitModels` | `false` | Let an explicitly chosen model continue on the ladder. |
| `requestTimeoutMs` | `180000` | Deadline for opening a stream connection. |
| `streamIdleTimeoutMs` | `90000` | Frame-gap deadline of the SSE watchdog; `0` disables it. |
| `verifyFreeModelsEveryMs` | `86400000` | Cadence of the free-tier verification (clamped to at least 60000). |
| `machineId` | `''` | Override for the hardware identity (also `DEEPAI_MACHINE_ID`). |
| `frontier` | 16 rows | Ordered Frontier ladder: `{ id, theos, label }`. |
| `unmetered` | 11 ids | Ordered unmetered ladder. |

Example: prefer a cheaper Frontier ladder and a tolerant watchdog.

```yaml
- id: llm-deepaicode
  name: dsh-deepaicode-auto
  config:
    dailyTheosBudget: 250
    streamIdleTimeoutMs: 180000
    frontier:
      - id: claude-sonnet-5-5
        theos: 10
        label: Claude Sonnet 5.5
      - id: minimax-m3
        theos: 2
        label: MiniMax M3
    unmetered:
      - deepseek-v4.1-flash
      - glm-5.3-flash
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No **DeepAI Code** group in the model picker | The bundle is installed but not enabled, or the row failed to activate | **Plugins** → enable the bundle; check the row is `active`. Installing a new JavaScript generation needs a Harness restart. |
| No **DeepAI Code** entry in Settings | The browser still holds the boot graph from before the bundle was enabled | Refresh the page; if it is still missing, restart DeepSeek Harness so both halves load. |
| Every request ends with `auth_required` | No valid credential | Sign in again (delete `$DSH_HOME/deepaicode/account.json` and restart), or set `DEEPAI_CODE_API_KEY`. |
| `social_login_required` / `email_unverified` | The account may not use DeepAI Code | Use a Google or Apple account, or verify the email on a Pro plan. |
| `426` on every call, then recovery | DeepAI raised the lane version | The plugin re-probes automatically; a persistent failure means the new lane exceeds the probe window — raise `lane` or open an issue. |
| `409 session_busy` | Upstream concurrency limit | Handled: short cooldown and the next model. Repeated occurrences mean you are running many turns in parallel. |
| `check_in_refused` | Too many check-in attempts that day | Handled: 6 h silence, then inference continues on the degraded path. |
| Answers stop mid-stream | Connection cut or watchdog expiry | Reported as a transport error; Auto retries on the next model only if nothing was shown yet. |
| `theos_exhausted` earlier than expected | The allowance is shared with the desktop app and any other client on the same account and machine | Expected; Auto continues on the unmetered tier. |
| Model list looks stale | `/models` requires a credential, so a signed-out start uses the published table | Sign in; the next request or start refreshes it. |
| Images or files are ignored | Not forwarded upstream | Expected limitation, see below. |

Diagnostics go to the Host log. Look for lines prefixed `deepaicode:`; the startup line reports the
accepted lane, the number of models, and whether the catalog is live.

---

## Privacy and data flow

- The plugin sends your conversation, tool schemas and the request controls DeepAI Code accepts to
  `https://api.deepai.org`. Nothing else leaves the machine.
- The credential and the machine digest are written only under `$DSH_HOME/deepaicode/`, with mode
  `0600`. No credential is ever logged.
- Reasoning traces and tool calls are passed through unchanged; the assembled assistant message is
  recorded by DeepSeek Harness as usual, with `auto` as the model id and the model that actually
  answered named in the plugin log.

---

## Limitations

- **Undocumented private endpoint.** This speaks the DeepAI Code desktop client's protocol, not a
  published API. DeepAI changes it without notice — the lane version moved three times in ten days
  during development. The lane is re-probed automatically, but a protocol change can still break
  the plugin.
- **Shared allowance.** Requests are billed to your own account's daily allowance and share it
  with the desktop app and any other client on the same account and machine.
- **No images or file attachments.** Content blocks of those types are not forwarded upstream;
  the Harness projects images to text for text-only models, and attachments are otherwise dropped.
- **Explicit choices are honoured.** An explicitly chosen model does not silently switch unless
  `failoverExplicitModels` is enabled.
- **Terms of service.** Automating an account through a reverse-engineered client is your
  responsibility under DeepAI's terms. Use it with your own account at your own risk.

---

## Development

```bash
npm run build   # node scripts/check.mjs && node --test
npm test        # the suite alone
```

`scripts/check.mjs` validates the manifest, the loader patch, the locale resources, the icon
bounds, the plugin market index, that every runtime module imports, that the browser artifact
registers under the package name into `settings.section` with route paths matching the Host, that
no `@deepseek-ai/*` package is imported at runtime, and that no local path or credential pattern
reached the repository.

The 86-test suite covers the routing policy directly — Frontier-before-Unmetered priority,
affordability filtering, quota retirement, cooldown expiry, daily reset, authentication abort,
mid-stream no-replay, empty-response failover, the SSE watchdog, the selector catalog, and the
plugin entry point — plus the settings connection controller (status shape, key verification,
sign-out precedence, polling that costs no upstream request), the free-tier verifier (baseline
handling, daily re-arming, price reclassification, persisted report, cadence clamping), the
`deepaicode_free_models` tool's output contract, and the browser artifact, which is executed in a
sandbox to prove its registration and dictionary keys.

### Layout

```
index.js              plugin entry: apply(), credential chain, startup sequence
client.js             browser half: the Settings → DeepAI Code page
cordis.patch.yml      loader row with the default config
index.json            plugin market index (format 1)
src/adapter.js        llm adapter + Auto routing chain
src/router.js         routing policy, cooldowns, allowance state
src/models.js         ladder construction and tier classification
src/catalog.js        live catalog cache + published fallback table
src/client.js         upstream client: headers, lane, check-in, streams
src/stream.js         SSE → StreamChunk translation
src/sse.js            SSE frame reader + idle watchdog
src/body.js           request body construction and desktop shape fallback
src/auth.js           RFC 8252 sign-in and credential storage
src/identity.js       instance id and hashed machine fingerprint
src/verify.js         daily free-tier verification, change report and its schedule
src/tools.js          the model-facing deepaicode_free_models tool
src/connection.js     connect / disconnect / status controller behind the settings page
src/routes.js         the /deepaicode/* Host routes and their trust fence
```

---

## Acknowledgements

The upstream header shape, check-in cycle, request-body whitelist and error taxonomy were derived
from published reverse-engineering work on the DeepAI Code desktop client —
[`REALOIYO/dsh-deepai-connector`](https://github.com/REALOIYO/dsh-deepai-connector) and
[`2951461586/DeepAICode2API`](https://github.com/2951461586/DeepAICode2API). This bundle shares no
code with either; it is an independent implementation with its own routing and failover layer.

## Licence

MIT — see [LICENSE](./LICENSE).
