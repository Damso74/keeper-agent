# PR 1 (code) — `fix: surface actionable dry-run revert diagnostics over MCP`

Base: `staging` · Branch: `fix/mcp-simulate-revert-diagnostics`

**Status — 2026-08-11:** open, mergeable, synced with `staging` at `32c8aa2`, and
awaiting maintainer re-review. Current head: `f20a656`.

---

## Summary

A true simulation revert answers HTTP 400 with `wouldRevert: true`,
`failureKind: "revert"` and a decoded reason. Request-validation failures may also carry
`wouldRevert: true`, so both fields are required before the MCP client may label the
result as an on-chain revert.

An MCP caller could not consume that structured result. `callApi` throws on any non-2xx,
so the body
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
API call failed: 400 Bad Request - {"success":false,"status":"simulated","from":"0x8FF41A30af4458E3C14C8843BDDcc37B7992ED58","to":"0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238","value":"0","wouldRevert":true,"failureKind":"revert","revertReason":"Error(ERC20: transfer amount exceeds balance)","error":"Error(ERC20: transfer amount exceeds balance)"}
```

## After

```text
API call failed: 400 Bad Request - {"success":false,"status":"simulated","from":"0x8FF41A30af4458E3C14C8843BDDcc37B7992ED58","to":"0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238","value":"0","wouldRevert":true,"failureKind":"revert","revertReason":"Error(ERC20: transfer amount exceeds balance)","error":"Error(ERC20: transfer amount exceeds balance)"}

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

- `callExecuteApi` wraps `callApi` for the three direct-execution tools and forwards the
  seventh `CallApiOptions` argument, preserving `NO_MCP_FETCH_TIMEOUT` on broadcasts.
- `buildSimulationRevertHint` activates only when the message starts with the exact HTTP
  400 prefix and the parsed body has both `wouldRevert === true` and
  `failureKind === "revert"`.
- The next step names the Safe-routing caveat already documented under
  [Known limitation](https://docs.keeperhub.com/api/direct-execution#known-limitation),
  because a Safe-routed org's simulated sender is not the account the broadcast spends
  from.
- Revert fields are untrusted input: control characters are neutralised and appended
  field copies are capped. The original upstream first line remains verbatim for
  compatibility.

## Compatibility

- The original message is kept as the first line, so callers that pattern-match
  `API call failed: 400` are unaffected. A test pins this.
- Only exact HTTP 400 bodies with `wouldRevert: true` and `failureKind: "revert"` are
  augmented. Route-level and simulator validation failures are rethrown verbatim and are
  never relabelled as reverts.
- Successful responses are untouched — no change to the success envelope.
- Non-400 statuses are untouched.
- No new dependency, no public type change, no change to the REST layer or the simulator.

## Tests

New file: `tests/unit/mcp-simulate-revert-diagnostics.test.ts` (16 tests). It covers the
augmented fields, preserved prefix, all three tools, the no-timeout passthrough, a
simulator validation failure with `wouldRevert: true`, a misleading embedded 400 string
inside a 500 response, unchanged successes, malformed bodies, and hostile or oversized
revert strings. The appended `Reason:` copy is capped; the original first line remains
verbatim. No network calls.

```bash
pnpm vitest run tests/unit/mcp-simulate-revert-diagnostics.test.ts
# Test Files 1 passed (1) · Tests 16 passed (16)
```

### Current validation — 2026-08-11

The branch is synced with `staging` at `32c8aa2`; its current head is `f20a656`, and
GitHub reports it as mergeable.

- dedicated diagnostics suite: **16/16**;
- targeted MCP and execution regressions: **160/160**;
- GitHub merge-ref unit suite: **521 files / 20,819 tests passed**;
- remote sandbox, lint, type-check, integration, migrations and docs: **pass**;
- [CI Pipeline](https://github.com/KeeperHub/keeperhub/actions/runs/31446014503):
  **success**.

[PR Checks](https://github.com/KeeperHub/keeperhub/actions/runs/31446014262) is marked
failed only because the fork job cannot configure AWS without `aws-region`; it stops
before build. No code or test job fails.

## Real-world context

Found while building an operator-triggered onchain agent against the live KeeperHub MCP server on
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
- [x] Dedicated suite: 16/16
- [x] Targeted MCP and execution regressions: 160/160
- [x] GitHub merge-ref unit suite: 521 files / 20,819 tests passed
- [x] Remote sandbox, lint, type-check, integration, migrations and docs pass
- [x] New tests are deterministic and use no network
- [x] No secrets, no `.env`, no generated artifacts
- [x] Backwards compatible
- [x] Synced with current `staging`; branch is mergeable
