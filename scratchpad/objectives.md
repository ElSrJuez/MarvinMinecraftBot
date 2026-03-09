# Feature Branch: skills-and-memory

## Meta-Objectives

Marvin needs to *do things* beyond staring and quoting. Skills are self-contained behaviors that plug into the bot. A shared **memory module** gives skills persistent, file-backed short-term memory — one canonical way to remember things.

## Architecture

```
MarvinMinecraftBot.js  (entry point — boots bot, loads skills)
├── memory/memory.js   (shared memory module — read/write/append to memory files)
├── skills/
│   ├── lazysleeper.js (skill: sleep in beds when night falls)
│   └── narrator.js    (skill: observe nearest player, summarize via LLM)
├── dialogue/          (existing quote system)
└── log/               (existing logging)
```

### Locks (`bot.locks`)
- A `Set` of named strings on the bot instance, initialized in `MarvinMinecraftBot.js`
- Two types of lock:
  - **Safety** (`'movement'`): physical control in use — lookAt and other movement code yields
  - **Functional** (`'sleeping'`): bot is in a state where some actions don't make sense (but chat is fine)
- Skills `add`/`delete`/`has` by name — no module, no class, just a Set and a convention
- New lock types = new strings, no registration needed

### Memory Module (`memory/memory.js`)
- Canonical module for all persistent memory needs
- Reads/writes/appends timestamped entries to files in `MEMORY_DIR`
- Each skill gets its own memory file (e.g. `memory/narrator.jsonl`)
- Config: MEMORY_DIR, MEMORY_MAX_ENTRIES (env vars, no in-code defaults)
- Simple API: `append(skill, entry)`, `read(skill, n)`, `clear(skill)`

### Skill Framework (`skills/loader.js`)
- Auto-discovers `.js` files in `skills/` (excluding `loader.js`)
- Each skill exports `{ name, start(bot, memory), stop() }`
- Loader handles lifecycle: `loadSkills(dir)` → `startAll(skills, bot, memory)` → `stopAll(skills)`
- Each skill require + start is individually try/caught — one broken skill doesn't crash the bot
- Skills manage their own config via `requireEnv()` (no in-code defaults)
- Adding a new skill = dropping a new file in `skills/` that follows the contract

---

## Skill 1: LazySleeper (`skills/lazysleeper.js`)

### Objective
When night falls and sleep is possible, Marvin reluctantly drags himself to the nearest bed, sleeps, then trudges back to where he was — complaining the whole time.

### Behavior
1. Listen for `time` updates — detect when it's night and sleep is possible
2. Remember current position (via memory module)
3. Find nearest bed (block search)
4. Pathfind to the bed (requires `mineflayer-pathfinder`)
5. Sleep in the bed (`bot.sleep(bedBlock)`)
6. On wake, pathfind back to the remembered position
7. Throughout: send Marvin-style complaints to chat

### Marvin Chat Lines (examples)
- *Going to bed*: "I suppose I'll have to go sleep now. Not that I'll enjoy it."
- *Walking to bed*: "Here I am, brain the size of a planet, and they ask me to walk to a bed."
- *Sleeping*: "Don't talk to me about sleep. I've had quite enough of consciousness for one day."
- *Waking up*: "Oh no, not another morning. I was hoping this one would be different."
- *Returning*: "Back to my post. As if standing here serves any purpose whatsoever."

### Config (env vars)
- `SLEEPER_ENABLED` — enable/disable skill
- `SLEEPER_BED_SEARCH_RADIUS` — how far to look for beds (blocks)
- `SLEEPER_CHAT_ENABLED` — whether to send the complaint messages

### Dependencies
- `mineflayer-pathfinder` — for navigating to bed and back
- `memory/memory.js` — to store pre-sleep position

### Edge Cases
- No bed found → complain, do nothing
- Already in a bed → skip
- Interrupted sleep (attacked) → complain, try again or give up
- Can't pathfind → complain, stay put

---

## Skill 2: Narrator (`skills/narrator.js`) — *deferred, plan only*

### Objective
Observe the nearest player's actions, store simplified observations to memory, and periodically send recent memory to an LLM to generate Marvin-style commentary.

### Behavior (high-level)
1. Watch nearest player — track position changes, block breaks/places, combat, etc.
2. Append simplified observations to memory (via memory module)
3. On a timer, read recent memory entries and send to LLM with a Marvin persona prompt
4. Post LLM response to chat

### Config (env vars)
- `NARRATOR_ENABLED`
- `NARRATOR_OBSERVE_RADIUS`
- `NARRATOR_LLM_INTERVAL_MS`
- `NARRATOR_LLM_API_KEY`, `NARRATOR_LLM_MODEL`, `NARRATOR_LLM_URL`

---

## Current Focus

**Skill 1: LazySleeper** — implement end-to-end, including:
1. Memory module (needed by sleeper and later by narrator)
2. The skill itself
3. Wiring into `MarvinMinecraftBot.js`
4. New dependencies (`mineflayer-pathfinder`)
5. Config in `.env.sample` and `.env`
