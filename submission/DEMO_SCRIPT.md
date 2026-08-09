# Demo script — KeeperHub First Transaction Kit (60–90s)

Onboarding bounty. Screen recording, no face, no music needed. Keep the API key off
screen at all times.

---

## 0:00–0:15 — The friction

**On screen.** A terminal with an agent calling `execute_transfer` with `simulate: true`.
The result is a single wrapped line:

```text
API call failed: 400 Bad Request - {"success":false,"status":"simulated","from":"0x8FF41A30…","wouldRevert":true,"revertReason":"Error(ERC20: transfer amount exceeds balance)"}
```

**Voiceover.**
> This is what an agent saw when a transfer dry run failed. There is a real diagnostic in
> there, but it arrives as a fragment of an error string. And the balance it is talking
> about belongs to an account that, in our setup, was not the account that pays.

## 0:15–0:35 — The fix

**On screen.** The same call after PR #1976. Let the new lines land one at a time.

```text
Simulation reverted. Nothing was signed or broadcast.
Stage: simulation — this 400 describes the transaction, not your request.
Reason: Error(ERC20: transfer amount exceeds balance)
Simulated sender: 0x8FF41A30…
Next step:
  - The dry run resolves the sender to the organization wallet. If your org routes
    writes through a Safe, the broadcast spends from the Safe…
```

**Voiceover.**
> Same response, same request. Now it names the stage, so you know nothing was
> broadcast. It names the decoded reason. It names the account it actually checked. And
> it ends with an action — which is never "retry and see what happens".
>
> The original message is still the first line, so anything that matched on it keeps
> working.

**Cut to** the test run:

```text
Test Files  1 passed (1)
      Tests  15 passed (15)
```

## 0:35–1:00 — The guide

**On screen.** Scroll the new guide page: the execution-path table, then the signal
table.

**Voiceover.**
> The second PR is the guide we wanted on day one. Setup, preflight, simulate, execute,
> verify.
>
> It starts by separating the accounts — the EOA that signs, the Safe that holds the
> funds, the Roles modifier that authorises — because almost every confusing error later
> is really a question about which one you are looking at.
>
> And it ends at a receipt, not at an accepted request. Each signal maps to exactly what
> it lets you claim.

**Pause briefly** on the row: `202 Accepted` -> "the request was queued".

## 1:00–1:20 — This came from a real integration

**On screen.** The Sepolia transaction on Etherscan, then the decoded logs.

**Voiceover.**
> None of this is hypothetical. It came out of an autonomous agent that executed a real
> 0.1 USDC transfer through KeeperHub on Sepolia, and then verified it by decoding the
> receipt instead of trusting the provider's report.
>
> The execution path was EOA, to Roles modifier, to Safe, to USDC — exactly the topology
> the dry run does not model.

## Close

**On screen.** The two draft PRs side by side.

**Voiceover.**
> The next builder should spend time building an agent, not reverse-engineering an HTTP
> 400 or guessing whether a transaction actually landed.

---

## Rules for the recording

- Say "open as a draft". Do not imply either PR is merged.
- Do not show ProofGate. It is a different artifact and a different argument.
- Do not mention the 1 USDC incident or the 5 USDC counterfactual replay — this video is
  about the 0.1 USDC autonomous run only.
- Keep the API key, `.env`, and any `kh_` string off screen.
- Claim no measured speed-up. None was measured.
