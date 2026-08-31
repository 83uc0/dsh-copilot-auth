# DSH GitHub Copilot Adapter

## Start Here

- Read [README.md](README.md) before changing authentication, runtime, tool calls, or packaging. It defines provider and security contract.
- Source lives in `src/`; `lib/` is generated output. Never hand-edit `lib/`.
- Tests in `test/` mirror source modules. Add or update focused Vitest coverage with behavior changes.

## Commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm check
```

`pnpm check` runs source/test typechecking, tests, then production build. Real Copilot test requires explicit opt-in: `COPILOT_INTEGRATION=1 pnpm test`.

## TypeScript

- Node 22.19+, pnpm 11, ESM, strict `NodeNext` TypeScript.
- Use `.js` suffixes in relative TypeScript imports.
- Preserve `readonly`, private `#` fields, discriminated unions, and conditional object spreads for optional properties. Compiler enables `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.

## Architecture

- `src/index.ts`: Cordis plugin lifecycle and route registration.
- `src/adapter.ts`: DSH request, streaming, and tool-call bridge.
- `src/copilot-runtime.ts`: Copilot SDK/CLI transport and child processes.
- `src/auth.ts` and `src/auth-state.ts`: non-secret auth metadata.
- `src/redaction.ts` and `src/errors.ts`: diagnostic safety and provider error mapping.

## Security Boundaries

- Never read, store, log, commit, or expose tokens, credentials, auth stores, environment secrets, or debug logs.
- Keep DSH credential records non-secret. Pass diagnostics through `src/redaction.ts`.
- Child environments stay allowlisted. Never inherit `GH_TOKEN`, `GITHUB_TOKEN`, API keys, or broad `process.env`.
- Preserve SDK isolation: `mode: 'empty'`, `enableConfigDiscovery: false`, declaration-only external tools, and DSH-owned permission execution.
- Authorize model IDs from `listModels()` before creating sessions.
- Retained tool-call sessions require correlated results and cleanup on error or plugin disposal.

## Generated And Packaging Files

- `lib/` changes only via `pnpm build`.
- Keep `cordis.patch.yml`, package metadata, and README aligned when public plugin behavior changes.
- `pnpm-workspace.yaml` intentionally denies `koffi` native builds. Do not enable it without verifying CLI transport requirements.