# Lock Orchestrator

The lock orchestrator is the central gatekeeper for all skill and module actions. No skill checks or manages locks directly — everything flows through the orchestrator.

## Lock Triplets

Every lock uses a hierarchical triplet schema: `type.domain.action`.

- **Type** — `safety` or `functional`. Determines the default suppression behavior.
- **Domain** — Groups related actions (e.g. `movement`, `state`, `action`).
- **Action** — The specific activity (e.g. `pathfinding`, `sleeping`, `crafting`).

Examples: `safety.movement.pathfinding`, `functional.state.sleeping`, `safety.action.crafting`.

Trigger names (actions that need permission but don't hold locks) follow the same dot-delimited convention: `dialogue.idle`, `movement.look`.

## Suppression Rules

The lock type determines the default behavior when a lock is active:

- **Safety** — Restrictive by default. When a safety lock is active, all other actions are **blocked** unless explicitly listed in the lock's `allow` config. Whitelist model.
- **Functional** — Permissive by default. When a functional lock is active, all other actions are **allowed** unless explicitly listed in the lock's `block` config. Blacklist model.

Both `allow` and `block` support prefix matching. A pattern of `safety.movement` matches `safety.movement.pathfinding`, `safety.movement.look`, etc.

## Lock Config

The lock config file (`LOCK_CONFIG_FILE`) declares the exception rules per lock. Only locks that need non-default behavior require an entry.

A safety lock with no config blocks everything. A functional lock with no config blocks nothing. Add entries only to declare exceptions:

```json
{
  "safety.movement.pathfinding": {},
  "functional.state.sleeping": {
    "block": ["dialogue.idle", "movement", "safety.movement"]
  }
}
```

Adding new locks or adjusting rules requires no code changes — just edit the config file.

## Lock State

The orchestrator maintains the set of currently active lock triplets in memory. On every acquire and release, the state is written to the state file (`LOCK_STATE_FILE`) for observability and debugging.

## Orchestrator API

The orchestrator exposes two functions:

- **`run(triplet, fn)`** — The primary interface for locking actions. Checks if the triplet is allowed given active locks, acquires the lock, runs the function, releases the lock on completion (or error). Returns `null` if denied, otherwise returns the function's result.
- **`allowed(trigger)`** — A read-only check for actions that need permission but don't hold locks (e.g. idle dialogue, lookAt). Returns `true` or `false`.

## Skill Integration

Skills don't manage locks. They wrap their lock-worthy actions in `orchestrator.run()`:

- Pathfinding → `orchestrator.run('safety.movement.pathfinding', fn)`
- Sleeping → `orchestrator.run('functional.state.sleeping', fn)`

The orchestrator decides whether to allow the action based on what's currently active and the config rules. If denied, the skill receives `null` and handles it gracefully.

Skill-triggered dialogue (`bot.dialogue.say()`) is called from within an already-orchestrated action and does not go through the orchestrator separately.

## Non-Locking Checks

Some actions run frequently and don't need to hold locks — they just need permission. These use `orchestrator.allowed()`:

- `movement.look` — the per-tick lookAt behavior
- `dialogue.idle` — the periodic idle quote timer

## Skill Namespace

Skills follow a formal namespace that ties together their identity, lock triplets, and dialogue categories:

| Skill | Namespace | Lock examples | Dialogue categories |
|---|---|---|---|
| LazySleeper | `sleeper` | `functional.state.sleeping` | `sleeper:noBed`, `sleeper:goingToBed`, etc. |
| Outpost | `outpost` | (uses shared `safety.movement.pathfinding`) | `outpost:set`, `outpost:returning` |

## Configuration

| Variable | Purpose |
|---|---|
| `LOCK_CONFIG_FILE` | Path to the lock rules config (JSON) |
| `LOCK_STATE_FILE` | Path to the runtime lock state file (written for observability) |
