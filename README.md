# DSH GitHub Copilot adapter

A host-side DeepSeek Harness plugin that registers the `github-copilot` LLM route through the **official** [`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk) and GitHub Copilot CLI.

It is intended for a GitHub account with an active Copilot entitlement, including a personal Copilot Pro subscription. It does not scrape tokens, call an external proxy, activate model policies, or bypass GitHub entitlement checks.

## Architecture and security boundary

The official SDK deliberately keeps OAuth credentials inside the GitHub Copilot CLI authentication store. This package never receives an access or refresh token.

- GitHub Copilot CLI owns login, secure token persistence, renewal, and logout.
- DSH `ctx.credentials` stores only a non-secret `grant` payload: provider, state, account login, GitHub host, timestamp, and a redacted diagnostic when needed.
- The record key is `llm-github-copilot/github-copilot`.
- The route obtains its model list from `CopilotClient.listModels()` and advertises only models whose account policy is enabled.
- Every requested model is checked against that authorized list before a session starts.
- The SDK session uses `mode: "empty"`; no Copilot CLI built-in, MCP, filesystem, shell, Git, extension, instruction-discovery, or telemetry capability is enabled by this plugin.
- DSH tools are declaration-only external SDK tools. DSH remains responsible for permission and execution; the plugin sends the resulting text back to the pending official SDK call.
- The SDK `clientName` sets the provider User-Agent attribution to DeepSeek Harness.
- Child processes receive a small environment allowlist. Token-shaped variables such as `GH_TOKEN`, `GITHUB_TOKEN`, and API-key variables are not inherited.

Never commit `auth.json`, `.credentials.json`, `.credentials.yaml`, `.env`, `.copilot`, logs, or a copied keychain/token. The supplied `.gitignore` blocks the common local forms.

## Prerequisites

- Node.js 22.19 or newer
- pnpm 11
- DSH `0.1.1-rc.2`
- GitHub Copilot CLI on `PATH` (`copilot --version`)
- A GitHub account with an active Copilot entitlement
- A local desktop/browser session for `/login github-copilot`

The package pins `@github/copilot-sdk` 1.0.8, which brings the matching official CLI package. The login command intentionally invokes the `copilot` executable on `PATH` so the SDK and normal CLI share the official authentication store.

## Develop and verify

```bash
pnpm install
pnpm check
```

`pnpm check` runs strict TypeScript checking for source and tests, 21 mocked tests, then the production build. The real-account integration test is skipped by default.

The workspace records `koffi` as an explicitly denied dependency build in `pnpm-workspace.yaml`; the packaged GitHub CLI artifact does not require this optional native build for this adapter's stdio mode.

## Install in DSH Web

From this checkout:

```bash
dsh plugin --profile web add .
```

Or with an absolute/local package path:

```bash
dsh plugin --profile web add /path/to/dsh-llm-github-copilot
```

The package declares `dsh.bundle.patch`, so DSH appends its `cordis.patch.yml` layer to the `web` profile. Restart the existing DSH Web process and refresh `http://127.0.0.1:3080`; starting another Vite server does not update that GUI.

To remove it:

```bash
dsh plugin --profile web remove @vincent-raffin/dsh-llm-github-copilot
```

Plugin unload unregisters the route, commands, and the optional native authorization flow when that DSH service exists; it also aborts retained tool-call sessions, disconnects SDK sessions, and stops the SDK child process.

## Route names and compatibility

The canonical provider route is `github-copilot-sdk`, not `github-copilot`. DSH 0.1.1-rc.2 already registers a native `github-copilot` route from the bundled `@earendil-works/pi-ai` provider through `dsh-base`, so the two implementations are in conflict at boot if they share the same route name. This adapter keeps the official `@github/copilot-sdk` CLI transport under its own route to coexist with the native pi-ai implementation.

The deprecated `/login github-copilot` alias remains accepted for compatibility, but the canonical command is `/login github-copilot-sdk`. Existing credentials and historical usage remain valid because the plugin intentionally keeps the persisted credential key and usage metadata under the legacy provider identity while the registered runtime route is renamed.

## Login

In the DSH composer, run:

```text
/login github-copilot-sdk
```

The command starts the official CLI web flow directly. When a DSH `authorization` service is present, the same operation is additionally exposed through its native flow registry; the stock Web profile does not provide that optional service, so plugin activation never waits for it. Complete authorization in the browser that opens. On success, DSH writes only the non-secret account-state record.

For a headless machine, perform the official device flow in a terminal first:

```bash
copilot login --device-code
```

Then restart DSH and run:

```text
/copilot-status
```

The status command asks the official SDK for current auth state and refreshes only the non-secret DSH metadata.

## Select a model

After login, open the DSH model selector:

1. Choose provider `github-copilot`.
2. Choose one of the models returned for the authenticated account.

No client plugin or page customization is required. DSH observes the registered adapter and calls `listModels()`. Disabled or unconfigured policy entries are filtered. An arbitrary or stale model ID is rejected locally with `MODEL_NOT_AUTHORIZED` before generation.

The SDK caches a successful model list for the life of its child process. Restart DSH after an account, organization policy, or entitlement change.

## Streaming and tool calls

Text and reasoning deltas map to DSH streaming blocks. External SDK tool requests map to DSH `tool-call` blocks. The official SDK session remains alive while DSH approves and executes the tool; the next DSH turn returns the correlated tool result to `handlePendingToolCall()` and continues the same stream.

The SDK session uses an empty tool mode and an exact allowlist of DSH declarations. `skipPermission` only suppresses a duplicate SDK prompt: it does not execute the tool or bypass DSH's own permission stack.

## Consumption tracking

The plugin tracks GitHub Copilot consumption from the SDK's own session events (`assistant.usage`, `session.model_change`). Since 2026-06, Copilot is billed in **AI credits** (1 credit = $0.01), priced per token and per model — input, cached input, cache write where applicable, and output — with a long-context tier on some models beyond an input-token threshold. The legacy premium-request multiplier is never shown.

**Per response** (automatic, no configuration): DSH renders the real token counts natively from the adapter's `usage` chunk, and the adapter attaches adapter-private metadata to the response (real model used — including the model Auto mode actually picked — per-call tokens, latency, request ids, raw billed quantity, local estimate). A response that aggregated several model calls lists **every** model with its call count and cost; models are never collapsed into one. Run `/copilot-usage` to see the last response in text form.

**Sources are strictly separated.** Every amount carries its source:

1. `github-billed` / CAPI `copilot_usage`: the per-request billed quantity (`totalNanoAiu`). This is a **raw nano-AIU value**; the nano→credit divisor is not publicly documented, so it is displayed raw with an "uncalibrated conversion" notice until you calibrate it (below). No credit or USD figure derived from it is shown before calibration.
2. `local-estimate`: computed from the dated, versioned pricing table (`src/pricing-table.ts`, captured 2026-09-01 from the official GitHub Docs). Always marked **ESTIMATED**. A model missing from the table is reported as "unknown pricing" — no rate is ever invented. When the SDK reports no usage for a response, no token counts are invented either; the response is counted as "without SDK usage data".
3. Nothing, with the reason.

**Monthly cumulative**: `/copilot-usage` shows the current month per model (local aggregates), the billed total when a billing token is configured, the allocation percentage (only when explicitly configured), and the approximate reset date.

```text
/copilot-usage            # report; fetches the billing report if configured and cache is stale
/copilot-usage refresh    # force a billing refresh (a hard 1-minute floor still applies)
```

### Billing reconciliation (optional, official endpoint)

To replace estimates with GitHub-billed monthly figures, the plugin reads the official `GET /users/{username}/settings/billing/ai_credit/usage` endpoint. This needs a **dedicated fine-grained PAT** — never your Copilot OAuth token, which the plugin neither accesses nor widens:

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate.
2. Resource owner: yourself. No repository access. Under **Permissions → Account permissions**, set **Plan: Read-only** (if the endpoint answers 403, the plugin logs GitHub's `X-Accepted-GitHub-Permissions` header once to document what is actually required).
3. Store it alone in a file outside this repository, mode 0600:

```bash
install -m 600 /dev/null ~/.config/dsh-copilot-billing-token   # then paste the token into it
```

4. Point the plugin at it via your profile's `cordis.patch.yml` config (see Configuration below): `billingTokenPath`.

Without this token the plugin runs in **estimate-only mode** and says so. Billing fetches happen only from the `/copilot-usage` commands — never per message — and are cached (default and minimum 60 minutes).

### Calibrating the nano-AIU conversion

```text
/copilot-usage-calibrate            # or: /copilot-usage-calibrate 2026-09
/copilot-usage-calibrate apply      # applies the proposal only after this explicit confirmation
```

The command compares the locally observed nano-AIU total of the period with the billed credits of the same period, proposes the measured divisor (default assumption 1 credit = 10⁹ nano-AIU), and warns when the measurement is implausible (billing lag can skew short periods). The applied divisor and its date are persisted (when storage is enabled) and shown in `/copilot-usage`.

Manual observation recorded on 2026-09-01: a prior local comparison reported that `copilot_usage.tokenDetails` per-category batch prices in nano-AIU matched the official dollar pricing table under a 10⁹ divisor, and that one observed `totalNanoAiu` matched this plugin's local estimate. This observation was not produced by an automated test or a retained live probe and is not independently reproducible from this repository. The calibration command remains necessary because GitHub can change the divisor without notice.

### Local storage (opt-in)

Disabled by default: `/copilot-usage` then covers only the **current session** plus any fetched billing data. With `usagePersist: true`, monthly counters persist to a documented file (default `$XDG_STATE_HOME/dsh-llm-github-copilot/usage.json`, override with `usageStorePath`). The file contains only counters, model ids, costs, timestamps and calibration — never prompts or code — and is kept at mode 0600 (verified and repaired on load). Purge everything:

```text
/copilot-usage-reset          # shows what will be deleted
/copilot-usage-reset confirm  # deletes the store file and clears in-memory aggregates
```

### Configuration

Add a `config` object to the plugin row in your profile's `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: llm-github-copilot
      name: '@vincent-raffin/dsh-llm-github-copilot'
      config:
        usageTracking: true              # false disables every tracking feature
        usagePersist: true               # opt-in local storage (default false)
        billingTokenPath: ~/.config/dsh-copilot-billing-token
        billingAllocationCredits: 1500   # Copilot Pro; only an explicit value shows a percentage
```

| Key | Default | Meaning |
| --- | --- | --- |
| `usageTracking` | `true` | `false` disables all consumption tracking and display |
| `tokenInputConvention` | `auto` | `auto` detects by observation; `disjoint`/`inclusive` force whether `inputTokens` excludes cache reads |
| `usagePersist` | `false` | Persist monthly counters to a local 0600 JSON file |
| `usageStorePath` | `$XDG_STATE_HOME/dsh-llm-github-copilot/usage.json` | Store file location (outside the repo) |
| `billingTokenPath` | — | File containing only the fine-grained billing PAT (0600) |
| `billingRefreshMinutes` | `60` | Billing report cache TTL; lower values are clamped to 60 |
| `billingAllocationCredits` | — | Monthly allocation; unset = no percentage shown (Pro default 1 500 is only stated as an assumption) |
| `billingResetDay` | `1` | Billing-cycle reset day (1–28); always displayed as approximate |

### Limits

- **Estimate ≠ invoice.** The local estimate uses published list prices; the billed amount can differ (discounts, promos, plan-specific pricing, rounding, billing lag). The monthly billed figure from the endpoint is authoritative.
- **nano-AIU calibration** is measured against one billing period; GitHub may change the divisor without notice. Recalibrate after a Copilot platform update.
- **Token convention bias**: if the provider folds cache reads into `inputTokens` and no observation proves otherwise, billed input is over-reported (nothing is subtracted on ambiguity). Set `tokenInputConvention` when you know the semantics.
- **Usage events are not stable across all Copilot models**: responses without an `assistant.usage` event contribute no token counts and are counted as such.
- **Long-context thresholds** are read as "K = 1000 tokens" from the official table; the threshold compares total prompt-side tokens.
- The **reset date is derived** (1st of next month, or `billingResetDay`) — the billing endpoint does not expose the cycle anchor — and always labelled approximate.
- The billing endpoint serves the **past 24 months** only.
- Tracking errors never affect responses: they are isolated, counted, and surfaced in `/copilot-usage`.

### Web UI visibility limitation

The stock DSH Web UI renders output tokens, TTFT, and tokens per second from the native `usage` chunk. It does not render adapter `replayState`, so the model actually used (including Auto resolution), request identifiers, cost, and a multi-model breakdown are only available through `/copilot-usage`.

## Logout and revocation

In DSH:

```text
/logout github-copilot
```

The plugin asks the official CLI to execute `/logout` non-interactively. It deletes the non-secret DSH record only after the SDK confirms that authentication is gone.

If the installed CLI version refuses non-interactive logout, run `copilot` in a terminal, enter `/logout`, exit, then restart DSH. Removing the DSH metadata alone does **not** revoke or erase CLI credentials.

For server-side account/session revocation, use GitHub account settings. DSH authorization has no generic provider revocation protocol.

## Errors and troubleshooting

| DSH code | Typical cause | Action |
| --- | --- | --- |
| `AUTH_REQUIRED` | CLI is not logged in, or GitHub returned 401 | Run `/login github-copilot` or `copilot login --device-code`. |
| `ACCOUNT_NOT_ENTITLED` | GitHub returned 403 for the account | Confirm Copilot Pro/Business entitlement and organization policy. |
| `MODEL_NOT_AUTHORIZED` | Model policy is disabled, stale, or not in `listModels()` | Choose an advertised model and restart DSH after policy changes. |
| `RATE_LIMIT` | GitHub returned 429 | Wait for the provider limit to reset. |
| `STREAM_ERROR` | CLI/SDK transport ended unexpectedly | Retry once, then restart DSH and run `/copilot-status`. |
| `COPILOT_RUNTIME_ERROR` | CLI missing, incompatible, or failed | Check `copilot --version` and the redacted host diagnostic. |

Diagnostics pass through a central redactor for bearer credentials, GitHub token families, OAuth query values, secret-named fields, and nested errors. Do not enable SDK/CLI debug logging when reporting an issue; logs are ignored but can still contain provider diagnostics.

## Current protocol limitations

- Input is intentionally declared text-only. DSH image references are not copied or converted into SDK attachments.
- The official SDK does not expose every stateless LLM option directly; DSH `temperature`, `maxTokens`, and `stop` are currently not forwarded.
- Token usage comes from the SDK's `assistant.usage` events, which are not stable across all Copilot models. When a response carries no usage event, the adapter emits no usage chunk rather than inventing counts; `/copilot-usage` reports how many responses lacked usage. Cost figures are either raw provider quantities (nano-AIU, shown unconverted until calibrated) or local estimates from the dated pricing table — see the consumption tracking section.
- Tool results are returned as text. Binary/image tool results are represented by DSH's textual projection.
- `@github/copilot-sdk` is in technical preview and may require an adapter update when its RPC schema changes.

## Optional real-account integration test

The test performs auth status and account-authorized model discovery only. It is disabled by default and never logs a token:

```bash
COPILOT_INTEGRATION=1 pnpm test
```

Run it only after an explicit `copilot login`. Unit tests otherwise use mocked CLI/SDK/auth/credential boundaries and do not contact GitHub.
