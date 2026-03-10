# Feature Branch: skills-and-memory

## Architecture

```
MarvinMinecraftBot.js  (entry point — boots bot, loads skills)
├── modules/
│   ├── dialogue/dialogue.js   (canonical dialogue engine — see design/DIALOGUE.md)
│   ├── dialogue/quotes.json   (seed file — Marvin's situational lines)
│   ├── locks/orchestrator.js  (lock orchestrator — see design/LOCKS.md)
│   ├── locks/locks.json       (lock suppression rules)
│   ├── log/logging.js         (logging + env helpers)
│   ├── memory/memory.js       (shared memory module — DEFERRED)
│   └── skills/
│       ├── loader.js          (skill auto-discovery — NOT YET IMPLEMENTED)
│       ├── lazysleeper.js     (skill: sleep in beds at night)
│       ├── outpost.js         (skill: remember and return to a position)
│       ├── narrator.js        (skill: observe + LLM commentary — STUB)
│       └── narrator/
│           ├── polling_sink.json  (declarative polling source definitions)
│           ├── event_sink.json    (declarative event subscription definitions)
│           └── prompts.json       (LLM prompt artifacts — persona, templates, fragments)
└── state/                     (runtime state — lock state, quote cache, memory files)
```

### Implemented Systems

- **Dialogue Engine** — Canonical quote file, categorized quotes, seed + remote merge, idle timer with orchestrator gating. Full design: `design/DIALOGUE.md`.
- **Lock Orchestrator** — Hierarchical triplet schema (`type.domain.action`), safety (whitelist) vs functional (blacklist) locks, configurable suppression rules. Full design: `design/LOCKS.md`.
- **Skill Namespace** — Formal naming convention: skill name = dialogue category prefix = lock identity. e.g. `sleeper` → `sleeper:noBed` (dialogue), `functional.state.sleeping` (lock).

### Pending Infrastructure

- **Memory Module** — see below
- **Skill Loader** — see below

---

## Implemented Skills

### LazySleeper (`skills/lazysleeper.js`)

When night falls and sleep is possible, Marvin reluctantly drags himself to the nearest bed, sleeps, then trudges back to his outpost — complaining the whole time.

Three orchestrated phases:
1. `safety.movement.pathfinding` — pathfind to bed
2. `functional.state.sleeping` — sleep (blocks idle dialogue, movement, further pathfinding via lock config)
3. `safety.movement.pathfinding` — return to outpost

Dialogue categories: `sleeper:noBed`, `sleeper:goingToBed`, `sleeper:sleeping`, `sleeper:waking`, `sleeper:returning`, `sleeper:interrupted`, `sleeper:cantReach`

Config: `SLEEPER_ENABLED`, `SLEEPER_BED_SEARCH_RADIUS`, `SLEEPER_CHAT_ENABLED`

### Outpost (`skills/outpost.js`)

Players can tell Marvin to come to them via chat command. Marvin remembers the player's position as his outpost and pathfinds there. Subsequent sleep cycles return to the outpost.

Pathfinding wrapped in `orchestrator.run('safety.movement.pathfinding', fn)`. Outpost set to the commanding player's position (not bot's).

Dialogue categories: `outpost:set`, `outpost:returning`

Config: `OUTPOST_ENABLED`, `OUTPOST_CHAT_ENABLED`, `OUTPOST_TRIGGER`

---

## Deferred: Memory Module (`modules/memory/memory.js`)

Originally designed as a dependency for the narrator. Now deferred — the narrator uses an in-memory ring buffer instead of file-backed JSONL storage. If a second skill needs persistent cross-restart memory, revisit this. See original design in git history.

---

## Pending: Skill Loader (`modules/skills/loader.js`)

Currently, skills are wired manually in `MarvinMinecraftBot.js`. The loader would auto-discover and lifecycle-manage skills.

### Design
- Auto-discovers `.js` files in `modules/skills/` (excluding `loader.js` and `util.js`)
- Each skill exports `{ name, start(bot, memory), stop() }`
- Loader handles lifecycle: `loadSkills(dir)` → `startAll(skills, bot, memory)` → `stopAll(skills)`
- Each skill's require + start is individually try/caught — one broken skill doesn't crash the bot
- Skills manage their own config via `requireEnv()` (no in-code defaults)
- Adding a new skill = dropping a new file in `modules/skills/` that follows the contract

---

## Pending: Narrator (`modules/skills/narrator.js`)

Full design: `design/NARRATE.md`

Two-sink observation architecture (polling + events) feeding an in-memory ring buffer. LLM narration via Vercel AI SDK. No memory module dependency.

### Implementation Plan

- [ ] **1. Extract `playersNearby` to shared util** — DRY extraction from `dialogue.js` to `skills/util.js`
- [ ] **2. Add `dialogue.narrator` to lock config** — one line in `locks.json`
- [ ] **3. Add `narrator:error` quotes to seed file** — data only, no code
- [ ] **4. Scaffold narrator skill structure** — config, lifecycle, ring buffer, `_active` guard
- [ ] **5. Implement polling sink (time + weather)** — simplest sources, no entity tracking
- [ ] **6. Add player-aware polling sources** — nearestPlayer, playerCount
- [ ] **7. Add derived polling sources** — loneliness timer, nearbyMobs
- [ ] **8. Implement event sink** — subscribe to events from `event_sink.json`
- [ ] **9. Install AI SDK and implement LLM narration** — `generateText()`, prompt, output, fallback
- [ ] **10. Wire into bot entry point + `.env.sample`** — end-to-end testable
- [ ] **11. Tune and harden** — intervals, prompt, chat spam suppression

---

## Current Focus

Narrator implementation (steps 1-11 above). Skill loader deferred — wire manually first.
