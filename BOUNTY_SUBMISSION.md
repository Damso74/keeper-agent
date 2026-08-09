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

Two small, independent, upstream pull requests, both targeting `staging`:

| PR | Title | Size | State (verified) |
| --- | --- | --- | --- |
| [#1976](https://github.com/KeeperHub/keeperhub/pull/1976) | `fix: surface actionable dry-run revert diagnostics over MCP` | +516 / -7, 3 files | open, ready for review, mergeable |
| [#1977](https://github.com/KeeperHub/keeperhub/pull/1977) | `docs: add a zero-to-verified-transaction guide` | +248 / -1, 3 files | open, ready for review, mergeable |

Neither is merged. Both target `staging`.

Plus, in this repository: a friction report separating fact from hypothesis, and the
reproduction commands.

## Before / after

The dry run of a transfer whose funds sit in the Safe, as seen by an agent over MCP.

**Before**

```text
API call failed: 400 Bad Request - {"success":false,"status":"simulated","from":"0x8FF41A30…","to":"0x1c7D4B19…","value":"0","wouldRevert":true,"revertReason":"Error(ERC20: transfer amount exceeds balance)","error":"Error(ERC20: transfer amount exceeds balance)"}
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

The submission proof is a real autonomous 0.1 USDC execution performed through
KeeperHub. ProofGate uses a separate captured incident to demonstrate why provider
claims should be reconciled with the chain.

**Autonomous agent run — 0.1 USDC — 2026-08-05, Ethereum Sepolia**

| | |
| --- | --- |
| KeeperHub execution id | `no623hdfsrun2vzv3b25r` |
| Transaction | [`0xe7e67b3a…`](https://sepolia.etherscan.io/tx/0xe7e67b3ab83e1af1f5d130d3c33dbe945cf015da8fb082020b24c253a8eb5062) |
| Block | 11424015 |
| Agent outcome | `EXECUTED_VERIFIED` |

The agent chose the moment and the amount itself, executed through KeeperHub, then
verified the result by decoding the receipt rather than trusting the provider report.
The execution path was `delegate EOA -> Zodiac Roles modifier -> Safe -> USDC ->
recipient`, which is precisely the topology the dry run does not model.

## Technical implementation

`callApi` in `lib/mcp/tools.ts` throws on any non-2xx, so a response body never reaches
an MCP tool handler as data. `call_workflow` already worked around this for HTTP 402
(KEEP-393); the three direct-execution tools had no equivalent for the dry-run 400.

PR #1976 extends that established pattern rather than inventing one:

- `callExecuteApi` wraps `callApi` for `execute_transfer`, `execute_contract_call` and
  `execute_check_and_execute`.
- `buildSimulationRevertHint` returns `null` unless the body is an object with
  `wouldRevert === true`, so ordinary validation 400s stay verbatim and are never
  relabelled as reverts.
- The original message is kept first; the stage, decoded reason, machine-readable `code`
  and simulated sender are appended.
- Revert strings are chosen by the contract under test, so they are sanitised with the
  same control-character and length defences already used for x402 challenge fields.

## Tests

15 new deterministic unit tests, no network access:

```bash
pnpm vitest run tests/unit/mcp-simulate-revert-diagnostics.test.ts
# Test Files 1 passed (1) · Tests 15 passed (15)
```

They cover the augmented output, the preserved prefix, all three tools, and — just as
importantly — the cases that must not change: validation 400, `wouldRevert: false`,
non-JSON body, empty body, non-object JSON, HTTP 500, unchanged success. Two tests treat
the revert string as hostile input (it cannot forge diagnostic lines; it is capped), and
one asserts the auth header never appears in the message.

Across every MCP and execute suite: **11 files, 159 tests, all passing.**

### Full CI-equivalent validation

Run on Linux with the toolchain the shared CI action pins — Node **22.22.0**, pnpm
**9.15.9** — measuring pristine `staging` first so every number is a delta:

| Command | `staging` (a0138f9) | #1976 | #1977 |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 0 | 0 |
| `pnpm discover-plugins` | 0 | 0 | 0 |
| `pnpm check` | 0 | 0 | 0 |
| `pnpm check:api-docs` | 0 | 0 | 0 |
| `pnpm type-check` | 0 | 0 | 0 |
| `pnpm test:unit __tests__ keeperhub-metrics-collector` | 0 | 0 | 0 |

Unit totals: `staging` **504 files / 20613 tests**; #1976 **505 files / 20628 tests**
(+1 file, +15 tests — exactly the new suite, no existing test altered); #1977 **504 files
/ 20613 tests**, identical to baseline as a docs-only change should be.

Both branches were also merged locally with the current `staging` tip (`0fd8e6e`) and
re-validated: no conflicts, lint and type-check pass, targeted suites pass. `.node-version`
declares Node 24, so #1976 was re-checked on **v24.19.0** as well — install,
`discover-plugins`, lint, type-check and the 11 targeted suites (159 tests) all pass.

Not run, and not claimed: `pnpm test:integration` needs the Postgres service container CI
provides, and `pnpm build` is OOM-killed in our 7.4 GiB validation VM — it fails
identically on pristine `staging`, so that is an environment limit, not a signal about
either branch. `pnpm build` is not part of `pr-checks.yml`.

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

- **Both PRs are open and ready for review, and neither is merged.** We cannot claim
  otherwise, and merging is the maintainers' decision.
- **We cannot claim green CI.** GitHub created the workflow runs but no jobs: every run
  sits at `conclusion: action_required`, the standard gate for a fork contribution, so CI
  awaits a maintainer's approval. Everything reported above is our own local
  CI-equivalent run, not GitHub's.
- The fix makes the simulator's Safe-routing limitation *visible*; it does not remove it.
  That limitation is documented upstream and changing it is a larger decision than this
  contribution should make.
- The `sponsored` field inconsistency we observed twice is reported, not diagnosed, and
  no code change is proposed for it.
- The Analytics 401/403 we hit is reported as secondary with an unresolved cause. It may
  be our own configuration error.
- No transaction was broadcast while preparing this contribution.

## Relationship to Keeper Agent and ProofGate

Three artifacts, deliberately kept distinct:

| | Amount | Broadcast | Role here |
| --- | --- | --- | --- |
| Autonomous agent run, 2026-08-05 | 0.1 USDC | yes | **the execution proof for this submission** |
| Captured reliability incident, 2026-08-04 | 1 USDC | yes | evidence that a provider report can diverge from the chain |
| Counterfactual policy replay | 5 USDC | **no broadcast** | ProofGate scenario B, a what-if against the remaining allowance |

**Keeper Agent** is the hackathon project: an agent that executes through KeeperHub and
refuses to report success unless the chain confirms it.

**ProofGate** is a separate demonstrator of reconciliation and deterministic replay. It
verifies the integrity of captured evidence locally. It does not perform a fresh RPC
query during browser verification.

This bounty submission is neither of those. It is the upstream contribution that came out
of building them: the friction we hit, turned into something the next builder does not
have to hit.
