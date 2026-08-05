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

**2026-08-05, Ethereum Sepolia.** The agent observed chain state, decided on its own, and
executed through KeeperHub. No human chose the moment or the amount.

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
| `mcp:get_execution` | not exposed for a direct execution — attempted and recorded, not assumed |

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

The `sponsored` contradiction reproduces on the agent's own run, not just on the 2026-08-04
incident — so it is systematic rather than a one-off.

**Verdict rules.** `MISMATCH` if any authoritative check diverges · `EVIDENCE_MISSING` if any
is absent · `MATCH_WITH_PROVIDER_WARNINGS` if only provider signals are off · `MATCH`
otherwise. A divergence outranks an absence, and **neither is ever turned into a success**.

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
