# KeeperHub First Transaction Kit — From MCP Setup to a Verified On-Chain Transaction

**Bounty:** KeeperHub — Best Onboarding UX Improvement

## One-line value proposition

We turned the exact points that blocked a real KeeperHub integration into actionable
diagnostics, a verified-transaction guide, and a reproducible onboarding path for the
next builder.

## Problem

A new builder can follow the KeeperHub quickstart to a request that is accepted, and
still not know two things that decide whether the integration works:

1. **Which account is actually being talked about.** Once Safe signer routing is on, the
   signing EOA, the Safe, the Roles modifier, the token holder and the recipient are
   different addresses. A balance error that does not name the account it checked sends
   you to fund the wrong one.
2. **Whether the transaction landed.** An accepted request is not a receipt.

Both cost us real time while shipping an autonomous agent against the live MCP server.
The information needed to resolve the first one was already in the API response — it
simply never reached the surface an agent builder reads.

## What we shipped

One open code PR and one merged documentation contribution, both targeting `staging`:

| PR | Title | Size | State (verified) |
| --- | --- | --- | --- |
| [#1976](https://github.com/KeeperHub/keeperhub/pull/1976) | `fix: surface actionable dry-run revert diagnostics over MCP` | +580 / -7, 3 files | open, mergeable, re-review requested |
| [#1977](https://github.com/KeeperHub/keeperhub/pull/1977) | `docs: add a zero-to-verified-transaction guide` | +248 / -1, 3 files | **merged** into `staging` |

PR #1977 is merged and its guide is [live in KeeperHub's official documentation](https://docs.keeperhub.com/guides/first-verified-transaction). PR #1976 is corrected, synced with `staging`, and awaiting maintainer re-review.

Plus, in this repository: a friction report separating fact from hypothesis, and the
reproduction commands.

## Before / after

The dry run of a transfer whose funds sit in the Safe, as seen by an agent over MCP.

**Before**

```text
API call failed: 400 Bad Request - {"success":false,"status":"simulated","from":"0x8FF41A30…","to":"0x1c7D4B19…","value":"0","wouldRevert":true,"failureKind":"revert","revertReason":"Error(ERC20: transfer amount exceeds balance)","error":"Error(ERC20: transfer amount exceeds balance)"}
```

One line. The JSON is present but only as a fragment of an error string, and nothing
tells you the balance being reported belongs to an account that may not be the one that
pays.

**After**

```text
API call failed: 400 Bad Request - {…}

Simulation reverted. Nothing was signed or broadcast.
Stage: simulation — this 400 describes the transaction, not your request.
Reason: Error(ERC20: transfer amount exceeds balance)
Simulated sender: 0x8FF41A30af4458E3C14C8843BDDcc37B7992ED58
Simulated target: 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
Next step:
  - The dry run resolves the sender to the organization wallet. If your org routes
    writes through a Safe, the broadcast spends from the Safe, so the sender above is
    not the account that pays — resolve the signer mode before acting on the reason.
  - Fix the cause, then re-run the same arguments with simulate: true. Broadcast only
    once the dry run returns wouldRevert: false.
```

The original message is preserved first, so anything matching on the status line keeps
working.

## Real hackathon context

The submission proof is a real operator-initiated 0.1 USDC agent execution performed
through KeeperHub. ProofGate uses a separate captured incident to demonstrate why provider
claims should be reconciled with the chain.

**Operator-initiated agent run — 0.1 USDC — 2026-08-05, Ethereum Sepolia**

| | |
| --- | --- |
| KeeperHub execution id | `no623hdfsrun2vzv3b25r` |
| Transaction | [`0xe7e67b3a…`](https://sepolia.etherscan.io/tx/0xe7e67b3ab83e1af1f5d130d3c33dbe945cf015da8fb082020b24c253a8eb5062) |
| Block | 11424015 |
| Agent outcome | `EXECUTED_VERIFIED` |

The operator initiated the run. The agent then independently observed the state, applied
its deterministic rule, chose the 0.1 USDC amount, executed once through KeeperHub, and
verified the result by decoding the receipt rather than trusting the provider report.
The execution path was `delegate EOA -> Zodiac Roles modifier -> Safe -> USDC ->
recipient`, which is precisely the topology the dry run does not model.

## Technical implementation

`callApi` in `lib/mcp/tools.ts` throws on any non-2xx, so a response body never reaches
an MCP tool handler as data. `call_workflow` already worked around this for HTTP 402
(KEEP-393); the three direct-execution tools had no equivalent for the dry-run 400.

PR #1976 extends that established pattern rather than inventing one:

- `callExecuteApi` wraps `callApi` for `execute_transfer`, `execute_contract_call` and
  `execute_check_and_execute`, while preserving the no-timeout option used for broadcasts.
- `buildSimulationRevertHint` returns `null` unless the message starts with the exact HTTP
  400 prefix and the parsed body has both `wouldRevert === true` and
  `failureKind === "revert"`. Request-validation failures therefore stay verbatim.
- The original first line remains verbatim for compatibility. Appended copies of the
  stage, reason, machine-readable `code` and simulated accounts are sanitised and capped.
- Revert strings are chosen by the contract under test, so control and invisible
  characters are neutralised in the appended fields; the original upstream line is not
  rewritten.

## Tests

16 new deterministic unit tests, no network access:

```bash
pnpm vitest run tests/unit/mcp-simulate-revert-diagnostics.test.ts
# Test Files 1 passed (1) · Tests 16 passed (16)
```

They cover the augmented output, the preserved prefix, all three tools and the no-timeout
passthrough. Negative cases include a route-level validation 400, a simulator validation
failure (`wouldRevert: true`, `failureKind: "validation"`), `wouldRevert: false`, malformed
or non-object bodies, and a non-400 response containing a misleading embedded 400 string.
Hostile revert strings cannot forge appended diagnostic lines, and the appended
`Reason:` copy is capped; the original compatibility line remains verbatim.

Across the targeted MCP and execute suites: **11 files, 160 tests, all passing.**

### Current validation — 2026-08-11

PR #1976 is synced with `staging` at `32c8aa2`; its reviewed head is `f20a656`, and
GitHub reports the branch as mergeable.

- dedicated diagnostics suite: **16/16**;
- targeted MCP and execution regressions: **160/160**;
- GitHub merge-ref unit suite: **521 files / 20,819 tests passed**;
- remote sandbox, lint, type-check, integration, migrations and docs: **pass**;
- the [CI Pipeline run](https://github.com/KeeperHub/keeperhub/actions/runs/31446014503)
  completed successfully.

One workflow remains red for a documented fork-infrastructure reason:
[PR Checks](https://github.com/KeeperHub/keeperhub/actions/runs/31446014262) stops at
`Configure AWS credentials` because `aws-region` is unavailable, before any build.
This page does not present the aggregate CI as fully green, and no code or test failure is
hidden.

## New-builder impact

- The failure names the stage, so simulation is not confused with broadcast.
- It names the account that was checked, so you do not fund the wrong address.
- It keeps the machine-readable `code`, so an agent can branch on it instead of matching
  strings.
- It ends with an action, and that action is never "retry the broadcast".
- The guide ends at a verified receipt rather than an accepted request.

We are **not** claiming a measured time saving. We did not measure one.

## Links

- Code PR: https://github.com/KeeperHub/keeperhub/pull/1976
- Docs PR: https://github.com/KeeperHub/keeperhub/pull/1977
- Merged guide: https://docs.keeperhub.com/guides/first-verified-transaction
- Friction report: `KEEPERHUB_ONBOARDING_FRICTION_REPORT.md`
- Agent evidence: `EVIDENCE.md`
- Transaction: https://sepolia.etherscan.io/tx/0xe7e67b3ab83e1af1f5d130d3c33dbe945cf015da8fb082020b24c253a8eb5062

## Reproduction

The simulation divergence, from this repository:

```bash
npm run simulate -- 2      # simulator predicts revert
npm run simulate -- 0.1    # both agree
```

The upstream fix and its tests:

```bash
git clone https://github.com/Damso74/keeperhub.git
cd keeperhub
git checkout fix/mcp-simulate-revert-diagnostics
pnpm install
pnpm vitest run tests/unit/mcp-simulate-revert-diagnostics.test.ts
```

## Limitations

- **PR #1977 is merged. PR #1976 is still open** and awaiting maintainer re-review; it is
  not described as approved or merged.
- **The aggregate CI is not labelled green.** All code-related validation passed, but the
  fork-only AWS setup job fails before build because `aws-region` is unavailable.
- The fix makes the simulator's Safe-routing limitation *visible*; it does not remove it.
  That limitation is documented upstream and changing it is a larger decision than this
  contribution should make.
- The `sponsored` field inconsistency we observed twice is reported, not diagnosed, and
  no code change is proposed for it.
- The Analytics 401/403 we hit is reported as secondary with an unresolved cause. It may
  be our own configuration error.
- No transaction was broadcast while preparing this contribution.

## Relationship to Treasury Drip Agent and ProofGate

Three artifacts, deliberately kept distinct:

| | Amount | Broadcast | Role here |
| --- | --- | --- | --- |
| Operator-initiated agent run, 2026-08-05 | 0.1 USDC | yes | **the execution proof for this submission** |
| Captured reliability incident, 2026-08-04 | 1 USDC | yes | evidence that a provider report can diverge from the chain |
| Counterfactual policy replay | 5 USDC | **no broadcast** | ProofGate scenario B, a what-if against the remaining allowance |

**Treasury Drip Agent** is the hackathon project: an agent that executes through KeeperHub and
refuses to report success unless the chain confirms it.

**ProofGate** is a separate demonstrator of reconciliation and deterministic replay. It
verifies the integrity of captured evidence locally. It does not perform a fresh RPC
query during browser verification.

This bounty submission is neither of those. It is the upstream contribution that came out
of building them: the friction we hit, turned into something the next builder does not
have to hit.
