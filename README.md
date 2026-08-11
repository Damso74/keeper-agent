# Treasury Drip Agent

An operator-triggered treasury agent that autonomously **observes, decides, executes
onchain through KeeperHub, and verifies** within each run — refusing to report success
unless the chain confirms it.

Built for the [KeeperHub Agents Onchain hackathon](https://dorahacks.io/hackathon/agents-onchain/detail).
Verification console: [ProofGate](https://proofgate.vercel.app) ·
[source](https://github.com/Damso74/proofgate).
The **0.1 USDC** run is the hackathon execution proof; ProofGate visualises a separate
captured **1 USDC** reliability incident.
Upstream impact: [verified-transaction guide merged into KeeperHub](https://docs.keeperhub.com/guides/first-verified-transaction) ·
[MCP diagnostics PR under re-review](https://github.com/KeeperHub/keeperhub/pull/1976).

---

## The loop

```
observe (RPC, direct)  →  decide (pure rule)  →  execute (KeeperHub MCP)  →  reconcile (provider + chain)
```

The operator starts a run. From that point, the agent independently observes, decides,
executes at most once, and verifies the exact on-chain outcome.

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

4. **Wait.** `get_direct_execution_status` is polled until a terminal status or a
   deadline. `queued`, `pending`, `running` and `unconfirmed` are all treated as
   non-terminal — `unconfirmed` in particular means the transaction was broadcast but its
   receipt is not yet readable, which is not a failure. The wait never re-sends
   `execute_transfer`: the report carries `executeCalls`, and it is always `1`.

5. **Verify independently.** The agent then fetches the transaction and its receipt
   **directly by RPC** and decodes them itself. `EXECUTED_VERIFIED` requires every one of
   these to hold on-chain: receipt status `success`, the expected chain id, the hash the
   provider announced, sender = delegate EOA, top-level target = Roles Modifier, an ERC-20
   `Transfer` emitted by the **USDC token contract**, with `from = Safe` and the
   expected recipient, token and amount,
   `ExecutionFromModuleSuccess`, and a `ConsumeAllowance` equal to the amount transferred.

   The provider's own `receipts[0].verified` is recorded as `providerVerified` for
   comparison and **never** decides the outcome. If the two disagree, the report follows
   the chain and says so. Anything short of full verification is
   `EXECUTED_PENDING_VERIFICATION`; only a receipt the chain shows as reverted is `FAILED`.
   An absent proof is never turned into either a success or a failure.

## Audit trail

A read-only command reconciles a **Treasury Drip execution** — one matching the Safe,
Roles Modifier, token and recipient in `src/config.ts` — against independent RPC evidence.
It is not a generic auditor: an execution from another configuration will legitimately
report divergences.

```bash
npm --silent run audit -- no623hdfsrun2vzv3b25r | jq
```

JSON goes to **stdout**, diagnostics to **stderr**, so the output stays pipeable. Exit code
is 0 for `MATCH` and `MATCH_WITH_PROVIDER_WARNINGS`, non-zero for `MISMATCH` and
`EVIDENCE_MISSING`.

Four parts come back: `keeperHubAudit` (the provider record, normalised), `analytics`
(REST coverage), `chainEvidence` (read straight from RPC) and `reconciliation` (per-check
results and a verdict). No broadcast, no state change, and the API key never reaches the
output.

**Surfaces queried**

| Surface | Purpose |
| --- | --- |
| `mcp:execute_transfer` | execution (agent run) |
| `mcp:get_direct_execution_status` | provider audit record |
| `rest:/api/analytics/runs?source=direct` | run metadata, paginated lookup by execution id |
| `rest:/api/analytics/runs/:id/steps` | step logs |

**Verdict rules** — a divergence outranks an absence, and neither is ever turned into a
success:

| Verdict | When |
| --- | --- |
| `MISMATCH` | an authoritative check diverges from the chain |
| `EVIDENCE_MISSING` | an authoritative check has no evidence to compare |
| `MATCH_WITH_PROVIDER_WARNINGS` | the chain agrees; only provider-side signals are off |
| `MATCH` | everything agrees |

Only the chain is authoritative. Provider signals — `sponsored` consistency, simulation
outcome, policy disclosure, idempotent replay — can raise warnings but can never validate.

The current run returns `MATCH_WITH_PROVIDER_WARNINGS`: every authoritative check agrees,
while `sponsored` contradicts itself between two levels of the same response and the audit
record never mentions allowance consumption. See [EVIDENCE.md](./EVIDENCE.md).

An independent cross-check outside the agent, using KeeperHub's CLI — **not a runtime
dependency**:

```bash
kh execute status no623hdfsrun2vzv3b25r --json
```

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
[MCP server docs](https://docs.keeperhub.com/agent/mcp-server): browser OAuth is
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

The JSON report goes to **stdout** and nothing else does, so it pipes into `jq` cleanly;
diagnostics go to stderr. It carries the observation, the decision (with code and reason),
the idempotency key, the simulation signal, the execution details and the independent
verification.

Exit codes distinguish the three outcomes that matter, because "not yet known" must never
be read as success:

| Code | Meaning |
| --- | --- |
| `0` | verified on-chain, or no action taken, or dry run |
| `1` | failure established — the chain shows a reverted receipt, or no execution id came back |
| `2` | **indeterminate** — broadcast, but not yet verified. Poll again; do not re-send |

## Tests

```bash
npm test          # 84 tests, no network
npm run typecheck
```

Covered: the decision rule and its abstention codes; the idempotency window; audit
normalisation; reconciliation across every verdict path (full match, wrong transaction hash,
unverified receipt, missing or incomplete audit, provider timeout, `sponsored` contradiction,
idempotent replay); Analytics coverage (run found, run absent, steps present, steps empty,
steps unavailable); stdout JSON parseability; and an assertion that no API key ever appears
in the output.

The execution engine itself is covered too, with the KeeperHub client and the RPC reads
injected so the flow runs without a network:

- exactly one non-simulated `execute_transfer`, and no re-send during a long non-terminal
  wait — every call after it is a status read;
- `unconfirmed` treated as non-terminal, then verified once the chain confirms;
- deadline reached without proof produces the indeterminate outcome, never a retry;
- a transaction that diverges on-chain, a missing proof, and an unreadable RPC each fail
  closed;
- **event provenance**: `Transfer` must be emitted by the USDC contract with
  `from = Safe`; `ExecutionFromModuleSuccess` must come from the Safe; and
  `ConsumeAllowance` must come from the Roles Modifier — a matching log emitted by an
  unrelated contract in the same transaction cannot validate an execution;
- `extractJson` against a body followed by trailing diagnostics, nested objects, braces
  inside strings and escaped quotes;
- every `eth_call` of one observation carries the same pinned block tag, never `latest`.

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
enforces the policy. The Safe holds the funds and appears as `from` in the transfer;
the USDC token contract emits the `Transfer` log.

## Honest limits

- The weekly cap is not read from the contract. What the agent _measures_ is the
  **remaining** allowance, by probing — which is what the decision actually needs.
- No mainnet run: the hackathon requires onchain execution, not a specific network.
- The organisation API key used for this run was rejected by the documented Analytics
  endpoints; the underlying cause remains unresolved. Run metadata and step logs are
  therefore recorded as unavailable rather than retrieved — provider coverage, not a verdict.
