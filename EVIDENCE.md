# Agent execution evidence

## Two distinct executions — do not conflate them

| | **Autonomous agent run** | Captured reliability incident |
| --- | --- | --- |
| What it proves | the agent decides and executes on its own | the provider's report diverges from the chain |
| Date | **2026-08-05** | 2026-08-04 |
| Amount | **0.1 USDC** | 1 USDC |
| KeeperHub execution id | **`no623hdfsrun2vzv3b25r`** | `1w6mru2gemgtq7wsruvaj` |
| Transaction | [`0xe7e67b3a…`](https://sepolia.etherscan.io/tx/0xe7e67b3ab83e1af1f5d130d3c33dbe945cf015da8fb082020b24c253a8eb5062) | [`0x0801289e…`](https://sepolia.etherscan.io/tx/0x0801289edfdcfd919b64b1f7e267d935674d09fa09de7a9670b8aa169bcb605e) |
| Triggered by | the agent's decision rule | a human operator |
| Lives in | this repository | the [ProofGate](https://github.com/Damso74/proofgate) fixture |

**The hackathon submission links the autonomous agent run.** The 2026-08-04 incident is
supporting evidence for the reliability argument, not the execution proof.

---

## Autonomous agent run — 2026-08-05

**2026-08-05, Ethereum Sepolia.** The operator initiated the run; the agent independently
observed, decided and executed without intervention. The decision rule, the amount and the
choice to act were the agent's, applied to state it read itself — but the run itself was
started by a human invoking `npm run agent -- --execute`, and saying otherwise would
overstate it.

|                        |                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KeeperHub execution id | `no623hdfsrun2vzv3b25r`                                                                                                                                                    |
| Transaction            | [`0xe7e67b3ab83e1af1f5d130d3c33dbe945cf015da8fb082020b24c253a8eb5062`](https://sepolia.etherscan.io/tx/0xe7e67b3ab83e1af1f5d130d3c33dbe945cf015da8fb082020b24c253a8eb5062) |
| Block                  | 11424015                                                                                                                                                                   |
| Gas used               | 119 267                                                                                                                                                                    |
| Agent outcome          | `EXECUTED_VERIFIED`                                                                                                                                                        |

**Decision taken by the agent**

```
remainingAllowance : 4 USDC      (measured by binary search over eth_call, 26 reads, 0 gas)
safeTokenBalance   : 19 USDC
decision           : DRIP, 0.1 USDC
reason             : "Allocation restante 4 USDC et solde du Safe suffisants pour verser 0.1 USDC."
idempotencyKey     : drip-w2952-100000
```

**Independently verified on-chain** (decoded from the receipt, not from the provider report)

```
from     0x8ff41a30…ed58   delegate EOA
to       0x21e92b68…acc8   Zodiac Roles Modifier      selector 0xc6fe8747
  SafeModuleTransaction   module=Roles  to=USDC  operation=0
  Transfer                from=0xf0Fe18E6…44d1 (the SAFE) → EOA   value=100000
  ExecutionFromModuleSuccess  module=Roles
  ConsumeAllowance        consumed=100000  newBalance=3900000
```

The allowance moved from 4 USDC to 3.9 USDC — exactly what the agent decided.

## KeeperHub audit trail, reconciled

After execution the agent pulls KeeperHub's own audit record and reconciles it against
independent RPC evidence. Read-only, no broadcast:

```bash
npm run audit -- no623hdfsrun2vzv3b25r
```

**KeeperHub surfaces queried**

| Surface | Result |
| --- | --- |
| `mcp:get_direct_execution_status` | audit record retrieved |
| `rest:/api/analytics/runs?source=direct` | queried with the organisation API key — see coverage below |
| `rest:/api/analytics/runs/:id/steps` | queried with the organisation API key — see coverage below |

Independent CLI cross-check, outside the agent (the CLI is **not** a runtime dependency):

```bash
kh execute status no623hdfsrun2vzv3b25r --json
```

**Verdict: `MATCH_WITH_PROVIDER_WARNINGS`** — every authoritative check agrees with the
chain; two provider-side warnings remain.

| Authoritative check | Result |
| --- | --- |
| chain id, transaction hash, receipt status, block number, gas used | MATCH |
| sender is the delegate EOA · top-level target is the Roles Modifier | MATCH |
| token, recipient, amount | MATCH |
| `Transfer` emitted **by the Safe** | MATCH |
| `ExecutionFromModuleSuccess` | MATCH |
| `ConsumeAllowance` equals the transferred amount | MATCH — `consumed=100000 remaining=3900000` |

| Provider warning | Detail |
| --- | --- |
| `SPONSORED_CONSISTENCY` | `sponsored: false` at the root, `sponsored: true` inside `executedCall` — **the same response contradicts itself** |
| `POLICY_DISCLOSED_BY_PROVIDER` | the audit record never mentions allowance consumption; it exists only in on-chain evidence |

The `sponsored` contradiction is **reproduced across both observed executions** — the
2026-08-04 incident and the agent's own run. Two observations, stated as two observations.

**Verdict rules.** `MISMATCH` if any authoritative check diverges · `EVIDENCE_MISSING` if any
is absent · `MATCH_WITH_PROVIDER_WARNINGS` if only provider signals are off · `MATCH`
otherwise. A divergence outranks an absence, and **neither is ever turned into a success**.

### Analytics REST coverage

Both endpoints were queried with the organisation API key, on 2026-08-05:

| Endpoint | HTTP | Outcome |
| --- | --- | --- |
| `GET /api/analytics/runs?source=direct&limit=50` (cursor pagination) | **401** | `{"error":"Authentication required"}` |
| `GET /api/analytics/runs/no623hdfsrun2vzv3b25r/steps` | **403** | `{"error":"Organization not found"}` |

Also tried and rejected: raw `Authorization`, `x-api-key`, and `Bearer` plus an
`x-organization-id` header — all 401. `/api/v1/analytics/runs` returns a clean 404, so the
path above is the documented one.

**The organization API key used by this agent was rejected by the documented Analytics
endpoints. The underlying cause remains unresolved.** Any `request_id` or `x-request-id`
returned by the provider is preserved in the coverage record, so the rejection can be traced
without exposing the key.

**This is provider coverage, not a verdict.** The audit records the endpoint, the status code
and the note, marks the surface unavailable, and moves on. An absent Analytics record can
never validate an execution and never turns into a false success — the authoritative checks
run entirely on RPC evidence.

## Historical balance — partial evidence, not a proof

**Scope, stated up front.** The scan below covers the **300 000 blocks preceding the
incident** — `11118272 → 11418272` — not the token's full history. It therefore shows no
balance-affecting activity in that window; it does **not** prove the delegate EOA never held
USDC before it. Treat this as supporting evidence, not proof.

Two reasons the full scan was not run:

- Public Sepolia RPCs no longer serve state at that height
  (`historical state is not available`), so the token's deployment block cannot be located
  by binary search over `eth_getCode`.
- Scanning from block 0 means ~233 range requests against a public endpoint, which did not
  complete in usable time.

`scripts/prove-historical-balance.mjs` performs the complete scan and is kept in the
repository: pointed at an archive node via `SEPOLIA_RPC_URL`, it locates the deployment
block, sums every incoming and outgoing `Transfer`, and reports the chunk count and totals.

What the partial scan does show, reproducibly:

| | |
| --- | --- |
| Token | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` (USDC, 6 decimals) |
| Address under test | `0x8FF41A30af4458E3C14C8843BDDcc37B7992ED58` (delegate EOA) |
| Method | `eth_getLogs` on the token, `Transfer(address,address,uint256)` |
| topic0 | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` |
| Incoming filter | topic2 = the EOA, left-padded to 32 bytes |
| Outgoing filter | topic1 = the EOA, left-padded to 32 bytes |
| fromBlock → toBlock | `11118272` → `11418272` (300 000 blocks), in 49 000-block chunks — the node caps ranges at 50 000 |
| Chunks | 7 windows, 2 requests each (incoming + outgoing) |

Result over that window: **1 incoming Transfer totalling 1 USDC, 0 outgoing totalling 0
USDC.** The single incoming transfer is the incident transaction itself, at block 11418272.
No other balance-affecting movement was observed during the window.

**What this does not establish.** The opening balance at block 11118272 is unknown, so the
scan cannot conclude what the EOA held immediately before the incident transaction. Any
transfer older than block 11118272 would not appear here. The exact historical EOA balance
is therefore not independently established.

What is on the record: the provider simulator reported insufficient delegate-EOA balance for
the 1 USDC direct-transfer path, while the Safe path succeeded. Run
`scripts/prove-historical-balance.mjs` against an archive node to close the gap.

## Reproducible simulation false negative

KeeperHub's simulator models a **direct ERC20 transfer from the delegate EOA**. The real
execution path is `EOA → Roles Modifier → Safe → USDC`. Whenever the amount exceeds the
EOA's own balance but stays within the Safe's policy allowance, the two disagree.

Reproduce on demand:

```bash
npm run simulate -- 2      # simulator: would revert · on-chain policy: accepts
npm run simulate -- 0.1    # both agree (the EOA happens to hold enough)
```

Measured 2026-08-05, delegate EOA holding 1.1 USDC, allowance 3.9 USDC:

| Amount     | On-chain policy | Simulator                                                      |                |
| ---------- | --------------- | -------------------------------------------------------------- | -------------- |
| 0.1 USDC   | accepts         | accepts                                                        | consistent     |
| **2 USDC** | **accepts**     | **predicts revert** — `ERC20: transfer amount exceeds balance` | **divergence** |

Two notes for anyone reproducing this:

- The revert comes back as **HTTP 400** with the useful JSON wrapped in an error string
  (`API call failed: 400 Bad Request - {"wouldRevert":true,…}`). A client that only reads
  the HTTP status, or only tries `JSON.parse` on the whole body, loses the entire diagnostic
  payload. See `extractJson` in `src/keeperhub.ts`.
- The divergence depends on the delegate EOA's own token balance, so the exact threshold
  moves as that balance changes. What stays true is the modelling gap.

The agent therefore treats the simulation as a **non-blocking signal** and reconciles
against the chain instead.
