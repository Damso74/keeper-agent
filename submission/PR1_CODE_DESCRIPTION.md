# PR 1 (code) — `fix: surface actionable dry-run revert diagnostics over MCP`

Base: `staging` · Branch: `fix/mcp-simulate-revert-diagnostics`

---

## Summary

A dry run that would revert answers HTTP 400 with `wouldRevert: true` and a decoded
reason. `docs/api/direct-execution.md` tells REST callers to read `wouldRevert` before
classifying that 400, because the status describes the transaction rather than the
request.

An MCP caller cannot follow that advice. `callApi` throws on any non-2xx, so the body
never reaches the tool handler as data, and the diagnostic survives only as a fragment of
`API call failed: 400 Bad Request - {...}`. The agent-native surface loses exactly the
information the dry run exists to produce.

This augments that one case on `execute_transfer`, `execute_contract_call`, and
`execute_check_and_execute`, mirroring the KEEP-393 treatment of HTTP 402 on
`call_workflow`.

## New-builder impact

We hit this while building an agent against the live MCP server. The reason string names
a balance problem but not the account it checked, and the MCP reference's error table
listed `400` as "Invalid parameters" — pointing away from the real cause. The information
needed to resolve it was already in the response and simply never surfaced.

## Before

```text
API call failed: 400 Bad Request - {"success":false,"status":"simulated","from":"0x8FF41A30af4458E3C14C8843BDDcc37B7992ED58","to":"0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238","value":"0","wouldRevert":true,"revertReason":"Error(ERC20: transfer amount exceeds balance)","error":"Error(ERC20: transfer amount exceeds balance)"}
```

## After

```text
API call failed: 400 Bad Request - {"success":false,"status":"simulated","from":"0x8FF41A30af4458E3C14C8843BDDcc37B7992ED58","to":"0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238","value":"0","wouldRevert":true,"revertReason":"Error(ERC20: transfer amount exceeds balance)","error":"Error(ERC20: transfer amount exceeds balance)"}

Simulation reverted. Nothing was signed or broadcast.
Stage: simulation — this 400 describes the transaction, not your request.
Reason: Error(ERC20: transfer amount exceeds balance)
Simulated sender: 0x8FF41A30af4458E3C14C8843BDDcc37B7992ED58
Simulated target: 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
Next step:
  - The dry run resolves the sender to the organization wallet. If your org routes writes through a Safe, the broadcast spends from the Safe, so the sender above is not the account that pays — resolve the signer mode before acting on the reason.
  - Fix the cause, then re-run the same arguments with simulate: true. Broadcast only once the dry run returns wouldRevert: false.
```

`Reason code: <code>` is added when the simulator attributed one (for example
`insufficient_balance`).

## Implementation

- `callExecuteApi` wraps `callApi` for the three direct-execution tools. Everything
  except a dry-run revert is rethrown untouched.
- `buildSimulationRevertHint` parses the body out of the error message using the same
  prefix-anchored `" - "` search as `buildPaymentRequiredHint`, and returns `null` unless
  the body is an object with `wouldRevert === true`.
- The next step names the Safe-routing caveat already documented under
  [Known limitation](https://docs.keeperhub.com/api/direct-execution#known-limitation),
  because a Safe-routed org's simulated sender is not the account the broadcast spends
  from.
- `sanitiseAcceptField` now delegates to a shared `sanitiseUpstreamField` rather than
  duplicating the control-character and length defences. A revert string is chosen by the
  contract under test, so it is untrusted input and gets the same treatment as an x402
  challenge field.

## Compatibility

- The original message is kept as the first line, so callers that pattern-match
  `API call failed: 400` are unaffected. A test pins this.
- Only `wouldRevert: true` bodies are augmented. Ordinary validation 400s (bad address,
  non-boolean `simulate`) are rethrown verbatim and are never relabelled as reverts.
- Successful responses are untouched — no change to the success envelope.
- Non-400 statuses are untouched.
- No new dependency, no public type change, no change to the REST layer or the simulator.

## Tests

New file: `tests/unit/mcp-simulate-revert-diagnostics.test.ts` (15 tests). Covers the
augmented fields, the preserved prefix, all three tools, and the cases that must **not**
change: validation 400, `wouldRevert: false`, non-JSON body, empty body, non-object JSON
(`null`, `[]`, string, number), HTTP 500, and an unchanged success. Two untrusted-input
tests assert a revert string cannot forge diagnostic lines and that oversized strings are
capped. One test asserts the auth header never appears in the message. No network calls.

```bash
pnpm vitest run tests/unit/mcp-simulate-revert-diagnostics.test.ts
# Test Files 1 passed (1) · Tests 15 passed (15) · 5.38s

pnpm vitest run tests/unit/mcp-meta-tools.test.ts
# Test Files 1 passed (1) · Tests 46 passed (46) · 4.12s
```

### Full CI-equivalent run

Validated on Linux with the toolchain the shared CI action pins
(`actions/setup-node@v6` node-version `22`, `pnpm/action-setup@v4` version `9`):
**Node 22.22.0, pnpm 9.15.9**. Pristine `staging` was measured first so every number
below is a delta against a known baseline rather than an isolated claim.

| Command | `staging` (a0138f9) | this branch |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 0 |
| `pnpm discover-plugins` | 0 | 0 |
| `pnpm check` | 0 | 0 |
| `pnpm check:api-docs` | 0 | 0 |
| `pnpm type-check` | 0 | 0 |
| `pnpm test:unit __tests__ keeperhub-metrics-collector` | 0 | 0 |

Unit totals: `staging` **504 files / 20613 tests passed**; this branch **505 files /
20628 tests passed**. Exactly +1 file and +15 tests, which is this PR's new suite, with
no change to any existing test.

Targeted MCP + execute suites:

```bash
pnpm vitest run tests/unit/mcp-simulate-revert-diagnostics.test.ts \
  tests/unit/mcp-meta-tools.test.ts tests/unit/mcp-execute-simulation.test.ts \
  tests/unit/mcp-simulate-scope.test.ts tests/unit/execute-simulate-scope.test.ts \
  tests/unit/mcp-execute-arg-coercion.test.ts tests/unit/mcp-execute-field-naming.test.ts \
  tests/unit/mcp-catalog.test.ts tests/unit/mcp-calldata.test.ts \
  tests/unit/mcp-curator-tools.test.ts tests/unit/execute-simulate-flag.test.ts
# Test Files 11 passed (11) · Tests 159 passed (159)
```

### Checked against the current `staging` tip

Because `845adf4` also touched `lib/mcp/tools.ts`, this branch was merged locally with
`staging` at `0fd8e6e` and re-validated. `lib/mcp/tools.ts` auto-merges with no conflict,
and on the merged tree `pnpm check`, `pnpm type-check` and the 11 targeted suites
(159 tests) all pass. The two changes do not overlap: `845adf4` edits the workflow-guidance
string and the `get_direct_execution_status` description, this PR adds a helper and swaps
the three `callApi` call sites.

### Not run

- `pnpm test:integration` needs the Postgres service container CI provides.
- `pnpm build` is OOM-killed in our 7.4 GiB validation VM
  (`Out of memory: Killed process ... anon-rss:5632340kB`, exit 137). It fails identically
  on pristine `staging` with no changes applied, so this is a limit of our environment and
  not attributable to this branch. `pnpm build` is not part of `pr-checks.yml`.

## Real-world context

Found while building an autonomous agent against the live KeeperHub MCP server on
Ethereum Sepolia. The execution path was
`delegate EOA -> Zodiac Roles modifier -> Safe -> USDC -> recipient`. A 2 USDC dry run
predicted a revert while the real path accepted it, because the EOA's own balance is
smaller than the Safe's — the documented modelling gap. The agent had to carry a
workaround that pulls the JSON back out of the error string.

## Scope

Not addressed here, deliberately:

- The simulator's Safe-routing limitation itself. It is documented upstream; changing it
  is a larger decision than this PR should make. This PR only makes the limitation
  visible at the moment a builder trips on it.
- Other status codes, other tools, and the REST layer.
- The `sponsored` field inconsistency we also observed. We have not diagnosed it and are
  not proposing a change for it.

## Checklist

- [x] Targets `staging`
- [x] Conventional-commit title
- [x] `pnpm check` and `pnpm type-check` pass (Node 22 + pnpm 9)
- [x] `pnpm test:unit` passes: 505 files / 20628 tests, +15 over baseline, 0 failures
- [x] New tests, deterministic, no network
- [x] No secrets, no `.env`, no generated artifacts
- [x] Backwards compatible
- [x] Re-validated after merging the current `staging` tip
