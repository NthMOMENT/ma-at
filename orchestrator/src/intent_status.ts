// Side-effect-free copy of IntentManager v2's IntentStatus enum (mirrors
// arbitrum_settlement.ts's own INTENT_STATUS_* constants exactly — see that
// file's comment: "Mirrors IntentManager.sol's IntentStatus enum order
// exactly (append-only)"). Deliberately a SEPARATE module with zero imports
// and zero side effects: anything that only needs these numeric values
// (solver_stats.ts) must not be forced to also import arbitrum_settlement.ts
// — which loads private keys and constructs the RPC transport at module load
// — just to read a status constant. arbitrum_settlement.ts is NOT edited to
// import from here (its own copies stay authoritative and untouched);
// solver_stats.gate.test.ts's drift-guard test proves the two never diverge.
export const INTENT_STATUS_PENDING = 0;
export const INTENT_STATUS_SETTLED = 1;
export const INTENT_STATUS_EXPIRED = 2;
export const INTENT_STATUS_SLASHED = 3;
export const INTENT_STATUS_REFUNDED = 4;
