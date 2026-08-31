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

## Login

In the DSH composer, run:

```text
/login github-copilot
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
- Token usage events are not stable across all Copilot models, so the adapter currently emits zero-valued usage rather than estimating or misreporting billing.
- Tool results are returned as text. Binary/image tool results are represented by DSH's textual projection.
- `@github/copilot-sdk` is in technical preview and may require an adapter update when its RPC schema changes.

## Optional real-account integration test

The test performs auth status and account-authorized model discovery only. It is disabled by default and never logs a token:

```bash
COPILOT_INTEGRATION=1 pnpm test
```

Run it only after an explicit `copilot login`. Unit tests otherwise use mocked CLI/SDK/auth/credential boundaries and do not contact GitHub.
