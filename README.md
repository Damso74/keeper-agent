# Treasury Drip Agent

An autonomous treasury agent that **executes onchain through KeeperHub** — and refuses to
report success unless the chain confirms it.

Built for the [KeeperHub Agents Onchain hackathon](https://dorahacks.io/hackathon/agents-onchain/detail).
Verification console: [ProofGate](https://proofgate.vercel.app) ·
[source](https://github.com/Damso74/proofgate).

---

## The loop

```
observe (RPC, direct)  →  decide (pure rule)  →  execute (KeeperHub MCP)  →  reconcile (provider + chain)
```

1. **Observe.** The agent reads chain state itself: the Safe's USDC balance, and the
   **remaining Zodiac Roles allowance measured by binary search over `eth_call`** on the
   full `execTransactionWithRole` envelope. The policy exposes no public allowance getter,
   so the agent probes for the largest amount the module still accepts — ~20 reads, zero
   writes, zero gas. It never takes a provider's word for chain state.

2. **Decide.** A pure, total function (`src/decide.ts`): same inputs, same decision, no
   network, no clock, no randomness, **no LLM**. That is deliberate — a deterministic rule
   is auditable, and a third party can replay the decision and get the same answer. Every
   abstention carries a stable code and a human-readable reason.

3. **Execute.** One call to `execute_transfer` over the KeeperHub MCP server, with an
   idempotency key derived from the payout window. **No automatic retry** — the key
   protects against double effect, but re-firing after a timeout stays a human decision.

4. **Reconcile.** The agent pulls `get_direct_execution_status` and only reports
   `EXECUTED_VERIFIED` when the **receipt** says `success` and `verified: true`. If the
   provider says `completed` and the chain has not confirmed, the outcome is
   `EXECUTED_PENDING_VERIFICATION` and a note says so.

## Why the simulation is consulted but not obeyed

KeeperHub's simulator models a **direct ERC20 transfer from the delegate EOA**. The real
execution path is `EOA → Roles Modifier → Safe → USDC`. The two disagree whenever the amount
exceeds the EOA's own token balance but stays within the Safe's policy allowance — the
simulator predicts a revert for a transfer the chain accepts.

Reproduce it on demand:

```bash
npm run simulate -- 2      # simulator: would revert · on-chain policy: accepts
npm run simulate -- 0.1    # both agree
```

It is not theoretical: the simulator predicted a revert for a transfer that then succeeded
on-chain — tx
[`0x0801289e…`](https://sepolia.etherscan.io/tx/0x0801289edfdcfd919b64b1f7e267d935674d09fa09de7a9670b8aa169bcb605e).

The threshold moves as the delegate EOA's balance changes; the modelling gap does not.
The agent runs the simulation, records the verdict, and **treats it as a non-blocking
signal**. Failure modes are handled where they can be proven — against the chain.

See [EVIDENCE.md](./EVIDENCE.md) for the full teardown, including a second finding: the
revert comes back as **HTTP 400** with the diagnostic JSON wrapped inside an error string,
so a client that reads only the status code loses it entirely.

## Setup

The agent authenticates with a KeeperHub **organisation API key**, per the
[MCP server docs](https://docs.keeperhub.com/ai-tools/mcp-server): browser OAuth is
explicitly unsuitable for headless systems.

1. Create a key at app.keeperhub.com → Settings → API Keys → **Organisation** tab.
2. Export it. The key is read from the environment only and is never logged.

```bash
export KEEPERHUB_API_KEY=kh_your_key_here
# optional
export SEPOLIA_RPC_URL=https://your-rpc-endpoint
```

```bash
npm install
```

## Run

```bash
npm run agent                 # observe + decide, broadcasts nothing
npm run agent -- --execute    # observe + decide + execute through KeeperHub
```

**Dry run is the default.** Broadcasting is never implicit.

Output is a JSON report: observation, decision (with code and reason), idempotency key,
simulation signal, execution details and the reconciled outcome.

## Tests

```bash
npm test        # decision rule + idempotency, pure, no network
npm run typecheck
```

## Safety rails

- **0.1 USDC per drip.** The weekly allowance is small and filming retakes draw from the
  same envelope.
- A **safety margin** keeps the allowance from ever being drained to zero.
- **One `execute_transfer` call, ever.** No retry loop.
- The idempotency key is derived from the payout window: two runs in the same window with
  the same arguments cannot produce two transfers.
- The agent aborts if the RPC is not on the expected chain.

## Addresses (Ethereum Sepolia)

| Role                                                  | Address                                      |
| ----------------------------------------------------- | -------------------------------------------- |
| Safe Proxy — holds the funds                          | `0xf0Fe18E660A661EE17E6d1cA5F12243E23c544d1` |
| Zodiac Roles Modifier — enforces the policy           | `0x21e92b6825b6f8d31547c650974477938bc1acc8` |
| Delegate EOA — signs, and is the authorised recipient | `0x8FF41A30af4458E3C14C8843BDDcc37B7992ED58` |
| USDC                                                  | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |

The Roles Modifier is **not** the Safe: the module is the transaction entry point and
enforces the policy; the Safe holds the funds and emits the `Transfer`.

## Honest limits

- The weekly cap is not read from the contract. What the agent _measures_ is the
  **remaining** allowance, by probing — which is what the decision actually needs.
- No mainnet run: the hackathon requires onchain execution, not a specific network.
- The agent does not yet consume the KeeperHub audit trail surface; reconciliation uses
  `get_direct_execution_status` plus the on-chain receipt.
