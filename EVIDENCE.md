# Agent execution evidence

## Run 1 — first autonomous execution

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
