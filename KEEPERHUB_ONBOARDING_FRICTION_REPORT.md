# From MCP Setup to a Verified Transaction: KeeperHub Onboarding Friction Report

While shipping a real KeeperHub agent, we found reproducible integration gaps and
documented concrete improvements for the next builder. Everything below comes from
building Treasury Drip Agent against the live KeeperHub MCP server on Ethereum Sepolia.

**Upstream status — 2026-08-11:** the verified-transaction guide is
[merged and live](https://docs.keeperhub.com/guides/first-verified-transaction). The MCP
diagnostics fix is [open, mergeable and under re-review](https://github.com/KeeperHub/keeperhub/pull/1976).

## How to read this document

Each observation separates what we saw from what we can prove. The labels are used
strictly:

| Label | Meaning |
| --- | --- |
| **Observed** | we saw it happen, with evidence |
| **Confirmed in code** | we read the upstream source and the mechanism is unambiguous |
| **Hypothesis** | consistent with the evidence, not established |

Upstream source was read at `KeeperHub/keeperhub@a0138f9` (branch `staging`).

## The three executions referenced here

These are distinct and are never merged into a single claim:

| | Autonomous agent run | Captured reliability incident | Counterfactual policy replay |
| --- | --- | --- | --- |
| Amount | 0.1 USDC | 1 USDC | 5 USDC |
| Date | 2026-08-05 | 2026-08-04 | n/a |
| Broadcast | yes | yes | **no broadcast** |
| Lives in | this repository | ProofGate fixture | ProofGate scenario B |

The bounty submission's execution proof is the **operator-initiated 0.1 USDC agent run**.

---

## Observation 1 — Transfer simulation and asset-holder ambiguity

**1. Observation.** A dry run of a 2 USDC transfer reported
`ERC20: transfer amount exceeds balance`, while the same transfer succeeded through the
real execution path.

**2. Reproduction context.** Ethereum Sepolia. Execution path
`delegate EOA -> Zodiac Roles modifier -> Safe -> USDC -> recipient`. Measured
2026-08-05 with the delegate EOA holding 1.1 USDC and a remaining policy allowance of
3.9 USDC. Reproducible in this repository:

```bash
npm run simulate -- 2      # simulator predicts revert
npm run simulate -- 0.1    # both agree
```

**3. Expected behavior.** A dry run of the path the broadcast will take, or a clear
statement of which account it modelled.

**4. Actual behavior.** The simulator modelled a direct ERC20 transfer from the delegate
EOA. Because the EOA's own balance is smaller than the Safe's, the two disagree whenever
the amount exceeds the EOA balance but stays within the Safe's policy allowance.

**5. New-builder impact.** The message names a balance problem without naming the
account it checked. The obvious reaction is to fund the wrong address. We spent real
time on that path before reading the source.

**6. Evidence.** `EVIDENCE.md` in this repository, section "Reproducible simulation false
negative". The divergence threshold moves with the EOA's balance; the modelling gap does
not.

**7. Confirmed mechanism.** **Confirmed in code, and already documented upstream.**
`lib/execute/simulate.ts` resolves the sender via `getOrganizationWalletAddress` and its
docblock states the limitation explicitly; `docs/api/direct-execution.md` documents it
under "Known limitation", including the fact that `balanceWei` and `shortfallWei`
describe the EOA rather than the paying account for a Safe-routed org.

This is therefore **not an undiscovered bug**. It is a known, documented limitation that
was invisible from where we were standing — the MCP surface, which did not carry the
caveat or the checked account into the failure.

**8. Proposed improvement.** Do not change the simulation engine. Carry the account it
checked into the message the builder actually reads, and say plainly that a Safe-routed
org pays from a different address.

**9. Implemented change.** PR 1 adds the simulated sender and the Safe-routing caveat to
the MCP error. PR 2 adds an execution-path model so the roles are distinguished before
the first failure.

**10. Verification.** Unit tests assert the sender appears and that the next step names
the Safe caveat. No change to the simulator.

---

## Observation 2 — Structured diagnostics hidden behind HTTP 400

**1. Observation.** A dry-run revert surfaced over MCP as a single line of the form
`API call failed: 400 Bad Request - {"wouldRevert":true,"failureKind":"revert",...}`,
with the useful JSON
embedded in an error string.

**2. Reproduction context.** Same run as Observation 1, over the KeeperHub MCP server.

**3. Expected behavior.** The decoded reason and the machine-readable fields reaching the
caller as data.

**4. Actual behavior.** They reached the caller only as a substring of an error message.
A client that reads the HTTP status, or calls `JSON.parse` on the whole body, loses the
entire diagnostic payload. This repository carries a workaround for exactly that:
`extractJson` in `src/keeperhub.ts`.

**5. New-builder impact.** This is the highest-friction item we hit. The REST reference
exposes structured simulation fields. A true simulated revert is distinguished by
`wouldRevert: true` together with `failureKind: "revert"`; request-validation failures use
a different `failureKind`. An MCP caller could not reliably act on those fields because
they were embedded in the error string, and the MCP reference's error table listed `400`
as "Invalid parameters" — pointing away from the real cause.


**6. Evidence.** `EVIDENCE.md`, and the workaround in `src/keeperhub.ts` written before
we had read upstream source.

**7. Confirmed mechanism.** **Confirmed in code.** `callApi` in `lib/mcp/tools.ts`
throws `API call failed: ${status} ${statusText} - ${errorText}` on any non-2xx, so the
body never reaches the tool handler as data. `call_workflow` already catches this for
HTTP 402 and augments it (KEEP-393); the three direct-execution tools had no equivalent
for 400.

**8. Proposed improvement.** Extend the existing 402 pattern to the dry-run 400 case.

**9. Implemented change.** PR 1. The original message is kept first so callers that
pattern-match the status line are unaffected; the stage, decoded reason, machine-readable
`code`, and simulated sender are appended. A hint is added only when the message starts
with the exact HTTP 400 prefix and the body carries both `wouldRevert: true` and
`failureKind: "revert"`. Simulator validation failures and other errors stay verbatim.

**10. Verification.** 16 unit tests, including route-level and simulator validation
failures, non-JSON and non-object bodies, an embedded 400 string inside a 500, success,
no-timeout passthrough, and untrusted-input cases. A revert string cannot forge appended
diagnostic lines, and the appended `Reason:` copy is capped while the original line stays
verbatim for compatibility.

---

## Observation 3 — Conflicting sponsorship indicators

**1. Observation.** A single execution-status response reported `sponsored: false` at the
root and `sponsored: true` inside `executedCall`.

**2. Reproduction context.** Observed on both broadcast executions: the 2026-08-04
incident and the 2026-08-05 operator-initiated agent run.

**3. Expected behavior.** One answer, or two fields whose different meanings are
documented.

**4. Actual behavior.** The same response carries both values.

**5. New-builder impact.** Low for correctness — we never used the field to decide
anything — but it is the kind of inconsistency that costs time when reconciling a
provider report against the chain, because you cannot tell which field is authoritative.

**6. Evidence.** `EVIDENCE.md`, "KeeperHub audit trail, reconciled", recorded as the
`SPONSORED_CONSISTENCY` provider warning. Two observations, stated as two observations.

**7. Current hypothesis.** **Hypothesis, not confirmed.** `docs/api/direct-execution.md`
defines root-level `sponsored` as "the write was gas-sponsored and broadcast through a
relayer or smart-account path rather than your org's EOA wallet", and
`docs/wallet-management/safe.md` states that ERC-4337 sponsorship is only available when
Safe signer routing is off. The two fields may therefore describe different scopes — the
execution as a whole versus an inner call — rather than contradicting each other. We did
not confirm this, and we did not read the code that populates `executedCall`.

**8. Proposed improvement.** Document the scope of each field, or reconcile them. We are
not proposing a code change for something we have not diagnosed.

**9. Implemented change.** None. Reported only.

**10. Verification.** Not applicable.

---

## Secondary — Analytics endpoints rejected the organization API key

**Cause not confirmed.** Reported for completeness, not as a defect claim.

On 2026-08-05, both documented Analytics endpoints rejected the organization API key that
the same agent used successfully against the MCP server:

| Endpoint | HTTP | Body |
| --- | --- | --- |
| `GET /api/analytics/runs?source=direct&limit=50` | 401 | `{"error":"Authentication required"}` |
| `GET /api/analytics/runs/<id>/steps` | 403 | `{"error":"Organization not found"}` |

Raw `Authorization`, `x-api-key`, and Bearer plus `x-organization-id` were also rejected.
`/api/v1/analytics/runs` returns a clean 404, which is why we believe the path above is
the documented one.

We did not isolate the cause. Plausible explanations we could not distinguish include a
different auth model for Analytics than for MCP, an org-scoping requirement we did not
satisfy, or a key-type restriction. **This may well be our own configuration error.**

What matters for reliability is what the agent did with it: the audit records the
endpoint, the status code and the note, marks the surface unavailable, and moves on. An
absent Analytics record never validates an execution and never becomes a false success.

---

## What we did not do

- We did not modify the simulation engine. The cause is known and documented upstream;
  changing it is a larger decision than this contribution should make.
- We did not claim a measured time saving. We did not measure one.
- We did not treat the `sponsored` inconsistency as a bug.
- We did not broadcast any transaction while preparing this contribution.
