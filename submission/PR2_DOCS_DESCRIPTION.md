# PR 2 (docs) — `docs: add a zero-to-verified-transaction guide`

Base: `staging` · Branch: `docs/first-verified-transaction`

**Status — 2026-08-11:** merged as
[KeeperHub PR #1977](https://github.com/KeeperHub/keeperhub/pull/1977); the guide is
[live in the official documentation](https://docs.keeperhub.com/guides/first-verified-transaction).

Independent of PR 1 — no shared files were required for the merge.

---

## Summary

Adds `docs/guides/first-verified-transaction.md`, a guide that takes a new integration
from MCP setup to a transaction the builder has independently confirmed landed. Registered
in `docs/guides/_meta.ts` and linked from `docs/guides/index.md`.

## Problem

The quickstart and the Direct Execution reference already take a builder to a request
that is accepted, and the reference already documents receipts, idempotency, the
structured dry-run failure semantics, including the simulator's Safe caveat.

What is missing is a single path that ends at "this transaction landed, and I checked" —
and, in particular, an explanation of which account plays which role once Safe signer
routing is on. That distinction is currently a caveat deep inside the API reference. A
first-time integrator meets its consequences before meeting the caveat.

## Added

- **Execution-path model** — Turnkey EOA, Safe, Zodiac Roles modifier, token holder,
  recipient, and what changes when the Safe **Sender** toggle is on. Grounded in
  `/wallet-management/safe`.
- **Preflight checklist** — chain, token, units, and the balance of the account that
  actually pays.
- **Reading a dry-run 400** — only `failureKind: "revert"` together with
  `wouldRevert: true` describes a simulated transaction revert; validation failures still
  describe the request, and a successful dry run is not a guarantee of execution.
- **Execution** — re-send the simulated body with `simulate` removed and an
  `Idempotency-Key` added.
- **Receipt verification** — `verified`, `receiptStatus` (including
  `safe_inner_failure`), `blockNumber`, `gasUsed`, plus decoding the expected log against
  your own RPC. A table maps each signal to what it actually licenses you to say.
- **Ambiguous-result handling** — argues explicitly against blind retries: look for a
  hash you already hold, ask the chain, re-send only with the same idempotency key, and
  treat a missing receipt as unknown rather than as failure.
- **Troubleshooting** in `Symptom -> Likely cause -> How to inspect -> Safe next step`
  form.
- **Ten-item checklist.**

## On `unconfirmed`

The second commit describes the `unconfirmed` execution status. Sourcing it explicitly,
because the reference docs have not caught up yet:

`845adf4` ("hold a broadcast we cannot verify in a non-terminal state") added
`unconfirmed` as a non-terminal status, so a broadcast whose receipt cannot be read
conclusively no longer settles as `failed`. That is the behaviour on `staging` today —
see `app/api/execute/_lib/types.ts`, `execution-service.ts` (`isInconclusive(receipts) ?
"unconfirmed" : "failed"`) and `lib/db/schema.ts`.

`docs/api/direct-execution.md` still lists only `pending`, `running`, `completed` and
`failed` under **Status Values**. This guide follows the code rather than that list. The
reference page is left alone here — flagging it rather than widening this PR.

Without this, the guide's ambiguous-result section would have described the pre-`845adf4`
behaviour and contradicted the branch it targets. The section's conclusion is unchanged:
an unreadable receipt is not a failure, and re-sending is the one thing not to do.

## Validation

Linux, Node **22.22.0** + pnpm **9.15.9**, matching the shared CI action. Pristine
`staging` (a0138f9) was measured first as a baseline.

| Command | `staging` | this branch (`ddff845`) |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 0 |
| `pnpm discover-plugins` | 0 | 0 |
| `pnpm check` | 0 | 0 |
| `pnpm check:api-docs` | 0 | 0 |
| `pnpm type-check` | 0 | 0 |
| `pnpm test:unit __tests__ keeperhub-metrics-collector` | 0 | 0 |

Unit totals are identical to baseline — **504 files / 20613 tests passed** on both — which
is what a docs-only change should produce.

Merged locally with `staging` at `0fd8e6e`: no conflicts, and `pnpm check` passes on the
merged tree.

Not run: `pnpm test:integration` (needs the Postgres service container CI provides) and
`pnpm build` (OOM-killed in our 7.4 GiB validation VM on pristine `staging` too, so it is
an environment limit rather than a signal about this branch; it is also not part of
`pr-checks.yml`).

### Content checks

- Every internal link resolves against `staging`: `/api/api-keys`,
  `/api/direct-execution#known-limitation`, `/api/direct-execution#choosing-a-stable-key`,
  `/agent/mcp-server`, `/wallet-management/safe`, `/wallet-management/turnkey`. The two
  anchors were checked against the actual headings in `docs/api/direct-execution.md`.
- Field names and `receiptStatus` values are taken from `docs/api/direct-execution.md` and
  `app/api/execute/[executionId]/status/route.ts`, not invented.
- `list_integrations`, `execute_transfer` and `get_direct_execution_status` were checked
  against `lib/mcp/tools.ts`.
- The Safe routing description matches `docs/wallet-management/safe.md`, including that
  the EOA always signs the outer transaction and pays gas.
- No private key appears in any command. The example uses a testnet chain id
  (`11155111`) and an environment variable for the API key.

## Scope

Documentation only. No change to the protocol, the execution engine, the simulator, or
any API surface. It documents behaviour that exists on `staging` today and does not
depend on PR 1.

If you would like the MCP reference to link here as well, say so and I will add the
one-line cross-link — it was deliberately left out so the two PRs share no files.
