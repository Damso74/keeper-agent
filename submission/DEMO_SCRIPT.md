# Demo script — Treasury Drip Agent (2:00–2:20)

One video for the main hackathon track and the KeeperHub onboarding bounty. Screen
recording, no face required. Keep every API key, `.env` file and `kh_` string off screen.

---

## 0:00–0:15 — The claim

**On screen.** Title, then the execution path:

```text
Operator starts run
→ agent observes
→ deterministic decision
→ one KeeperHub execution
→ independent RPC verification
```

**Voiceover.**
> Provider success is not proof. Treasury Drip Agent executes from a policy-scoped Safe
> through KeeperHub, exactly once, and reports success only after the chain confirms the
> exact outcome.

## 0:15–0:45 — The agent

**On screen.** The captured 0.1 USDC agent run. Pause on the observation, decision,
`executeCalls: 1`, KeeperHub execution id `no623hdfsrun2vzv3b25r`, and outcome
`EXECUTED_VERIFIED`.

**Voiceover.**
> The operator initiated this run. From there, the agent independently read the Safe
> balance and remaining Zodiac allowance, applied a deterministic rule, chose a 0.1 USDC
> drip, and made one `execute_transfer` call through KeeperHub. There is no automatic
> retry after an ambiguous broadcast.

## 0:45–1:15 — The chain is authoritative

**On screen.** Open the
[Sepolia transaction](https://sepolia.etherscan.io/tx/0xe7e67b3ab83e1af1f5d130d3c33dbe945cf015da8fb082020b24c253a8eb5062),
then show the decoded checks from `npm run audit -- no623hdfsrun2vzv3b25r`.

**Voiceover.**
> The agent does not trust KeeperHub's success flag. It fetches the transaction and
> receipt independently by RPC. It verifies the delegate sender, the Roles modifier, the
> USDC contract, `from = Safe`, the recipient, the exact amount, the Safe module success
> event, and the consumed allowance. Only then is the run verified.

## 1:15–1:38 — ProofGate, the evidence console

**On screen.** Open [ProofGate](https://proofgate.vercel.app). Show the 1 USDC captured
incident, the provider-versus-chain comparison, and **Verify proof**.

**Voiceover.**
> ProofGate is the evidence console, not the execution engine. It replays a separate
> captured 1 USDC incident and makes provider-versus-chain divergences visible. Browser
> verification checks the captured evidence bundle; it is not presented as a fresh live
> RPC query.

## 1:38–2:05 — Upstream impact

**On screen.** Show the
[merged verified-transaction guide](https://docs.keeperhub.com/guides/first-verified-transaction),
then [PR #1976](https://github.com/KeeperHub/keeperhub/pull/1976) with the latest checks.

**Voiceover.**
> Building the agent exposed onboarding friction. We turned it into a verified-transaction
> guide now merged into KeeperHub, plus an MCP diagnostics fix under maintainer re-review.
> The fix distinguishes real simulation reverts from request-validation errors and is
> covered by 16 dedicated tests.

## 2:05–2:20 — Close

**On screen.** Return to the architecture and the three proof links: execution id,
transaction and merged guide.

**Voiceover.**
> Safe-scoped authority. Exactly-once execution through KeeperHub. Independent proof of
> the exact on-chain outcome.

---

## Recording truth rules

- Say: **"The operator initiated the run; the agent independently observed, decided,
  executed and verified."**
- Do not say the agent scheduled or initiated itself.
- Keep the autonomous **0.1 USDC** run distinct from ProofGate's captured **1 USDC**
  incident and the unbroadcast **5 USDC** counterfactual.
- The USDC contract emits `Transfer`; the Safe appears in its `from` field.
- Present PR #1977 as merged and live. Present PR #1976 as open, mergeable and under
  re-review — never as approved or merged.
- Present ProofGate as deterministic evidence replay, not live RPC verification.
- Claim no measured time saving. None was measured.
