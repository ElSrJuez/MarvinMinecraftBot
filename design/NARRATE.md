# Narrator System

The narrator skill gives Marvin the ability to perceive his surroundings and comment on them in character — not from pre-canned quotes, but through LLM-generated commentary based on what he can actually observe from his outpost.

**Status: Design complete. Implementation pending.**

## Concept

Marvin stands at his outpost. He doesn't follow players. His world is what he can see from where he is: players coming and going, time passing, weather changing, mobs lurking, the creeping loneliness of being left alone. The narrator accumulates these observations into a short-term buffer and periodically feeds them to an LLM with a Marvin persona prompt. The LLM produces a short, in-character remark that Marvin says in chat.

This is fundamentally different from the idle dialogue system. Idle dialogue picks random pre-written quotes. The narrator generates contextual, dynamic commentary about what's actually happening around Marvin.

## Design Philosophy

The narrator is a **non-blocking lazy service**. It observes passively, accumulates state, and only acts when conditions align. It never blocks the bot, never holds locks, never moves or interacts with the world. It leverages all existing constructs — orchestrator, dialogue, shared utilities — canonically to stay minimal, unobtrusive, and safe.

## Observation Model

Marvin is stationary. His observation radius is limited to what mineflayer's server-side entity tracking provides (typically 4-10 chunks depending on server config), further constrained by `NARRATOR_OBSERVE_RADIUS`. From his outpost, the realistic perception is:

- Players approaching, lingering, leaving
- Time of day shifting (dawn, dusk, night falling)
- Weather changing (rain, thunder)
- Mobs wandering into and out of range
- Being alone for extended periods
- Nearby block mining (if within range)
- Chat messages (distance-independent)
- Deaths, damage, explosions nearby

This is more existential than play-by-play — and more Marvin.

## Two-Sink Architecture

Observations come from two sources, defined declaratively in JSON:

### Polling Sink (`skills/narrator/polling_sink.json`)

A `setInterval` loop reads bot state every few seconds and diffs against the previous snapshot. Fires observations only on meaningful state transitions.

| Source | What it reads | Fires when |
|---|---|---|
| nearestPlayer | presence, distance, held item, sneaking | Player arrives/leaves, approaches/recedes, swaps tools |
| playerCount | count of nearby player entities | Headcount changes |
| timeOfDay | `bot.time.timeOfDay` mapped to bands | Band transitions (dawn/morning/midday/afternoon/dusk/night/lateNight) |
| weather | `bot.isRaining`, `bot.thunderState` | Rain starts/stops, thunder starts/stops |
| nearbyMobs | grouped count by mob name | New mob type appears, type disappears |
| botHealth | `bot.health` | Meaningful damage taken (threshold=2) |
| loneliness | derived timer from player absence | Escalating at 1min, 5min, 10min alone |

### Event Sink (`skills/narrator/event_sink.json`)

A small set of mineflayer event subscriptions for transient events that polling would miss. Each handler pushes to the same observations buffer.

| Subscription | Event | Key filter |
|---|---|---|
| blockMining | `blockBreakProgressObserved` | `destroyStage===0` only (start of mining) |
| chat | `chat` | Not Marvin's own messages |
| playerJoined | `playerJoined` | Not Marvin |
| playerLeft | `playerLeft` | Not Marvin |
| entityDeath | `entityDead` | Within radius |
| entityHurt | `entityHurt` | Players only, 5s cooldown per player |
| chestInteraction | `chestLidMove` | Within radius |
| explosion | `soundEffectHeard` | Only explosion/thunder sounds |

### Why two sinks?

Mineflayer has no "give me what happened since last query" API. `bot.entities`, `bot.players`, `bot.time` etc. are a live object model updated in real-time by server packets. Polling reads this model on an interval and diffs — good for stateful things (position, equipment, weather). But transient events (someone mined a block, something died) leave no trace in the object model — if you're not listening when the event fires, it's gone. Hence the small event sink for things polling can't catch.

## Observations Buffer

Both sinks write to the same in-memory ring buffer — a capped array of observation objects:

```js
{ time: Date.now(), source: 'polling:timeOfDay', text: "It's dusk now." }
{ time: Date.now(), source: 'event:blockMining', text: "Steve started mining oak_log." }
```

The buffer is capped at `NARRATOR_MAX_OBSERVATIONS` entries (oldest dropped). No filesystem persistence — observations are ephemeral short-term context for the LLM, not long-term memory. If Marvin restarts, the buffer is empty and he starts fresh. This eliminates the memory module as a dependency.

## Narration

On a timer (`NARRATOR_LLM_INTERVAL_MS`), the narrator:

1. Checks orchestrator permission: `orchestrator.allowed('dialogue.narrator')`
2. Checks if observations exist in the buffer
3. Constructs a prompt: Marvin persona + recent observations as context
4. Calls the LLM via Vercel AI SDK (`generateText()`)
5. Posts the response to `bot.chat()`

Only one LLM call may be in-flight at a time. If a narration cycle fires while a previous call is still pending, it skips silently (`_active` guard).

### LLM Integration

Uses the Vercel AI SDK (`ai` package) rather than raw HTTP:

- `generateText({ model, system, prompt })` — one-shot text gen, exactly our use case
- Provider-agnostic — swap OpenAI/Anthropic/Ollama by changing the provider config
- Handles retries, token limits, error surfaces
- Contained entirely within the narrator skill

### Output Path

LLM-generated text goes directly to `bot.chat()`, not through the dialogue engine's `say()` (there's no quote pool to pick from). For error fallbacks (LLM unreachable, empty response), the narrator falls back to `bot.dialogue.say('narrator:error')` — pre-canned Marvin complaints routed through the canonical dialogue system.

## Contrast with Current Architecture

### vs LazySleeper (active, event-driven, lock-holding)

LazySleeper listens for `time` events and runs multi-phase orchestrator-locked cycles. It actively moves, sleeps, and holds locks. The narrator is passive — it reads state, buffers observations, and talks on a timer. It never calls `orchestrator.run()`.

### vs Dialogue Engine (pre-canned, pooled, interval-based)

Structurally similar timers — both fire on an interval, check orchestrator permission and player proximity, skip when conditions aren't met. The narrator should reuse the player proximity check (currently `_playersNearby()` private in `dialogue.js` — needs extraction to shared util).

Key difference is output: dialogue picks from a fixed pool; narrator generates dynamic text via LLM.

### vs Orchestrator (consumer, not holder)

The narrator only uses `orchestrator.allowed('dialogue.narrator')` — read-only permission check. Never acquires locks. The lock config needs `dialogue.narrator` added to `functional.state.sleeping`'s block list.

## Skill Namespace

| Aspect | Value |
|---|---|
| Skill name | `narrator` |
| Dialogue trigger | `dialogue.narrator` |
| Dialogue categories | `narrator:error` (fallback quotes) |

## Configuration

| Variable | Purpose |
|---|---|
| `NARRATOR_ENABLED` | Master switch |
| `NARRATOR_CHAT_ENABLED` | Whether to send commentary to chat |
| `NARRATOR_OBSERVE_RADIUS` | Block radius for tracking (polling + event filter) |
| `NARRATOR_POLL_INTERVAL_MS` | Milliseconds between polling snapshots |
| `NARRATOR_LLM_INTERVAL_MS` | Milliseconds between narration attempts |
| `NARRATOR_MAX_OBSERVATIONS` | Max entries in the ring buffer |
| `NARRATOR_LLM_PROVIDER` | AI SDK provider (e.g. `openai`, `anthropic`) |
| `NARRATOR_LLM_MODEL` | Model identifier |
| `NARRATOR_LLM_API_KEY` | API key for the LLM service |

## Edge Cases

- **LLM unreachable** — Log warning, skip cycle. Optionally say a `narrator:error` fallback quote.
- **No observations** — Nothing happened since last narration. Skip silently.
- **No players nearby** — No audience. Skip silently.
- **LLM returns empty/invalid response** — Log warning, skip.
- **Overlapping LLM calls** — `_active` guard. Skip if previous call in-flight.
- **Chat spam** — Narrator and idle dialogue both want to `bot.chat()` on timers. Narrator output should suppress idle dialogue for a cooldown window via orchestrator.

## Dependencies

- Lock orchestrator — already implemented, needs config update for `dialogue.narrator`
- Shared player proximity utility — needs extraction from `dialogue.js`
- Vercel AI SDK (`ai` package) — new npm dependency
- An LLM API endpoint — external, configured via env vars

## Reference

- `design/MINEFLAYER_EVENTS.md` — full mineflayer event inventory with signatures and notes
- `skills/narrator/polling_sink.json` — declarative polling source definitions
- `skills/narrator/event_sink.json` — declarative event subscription definitions

---

## Implementation Plan

Ordered by complexity, lowest-hanging fruit first. Each step is independently testable.

- [ ] **1. Extract `playersNearby` to shared util**
  Extract `_playersNearby(bot, radius)` from `dialogue.js` into `modules/skills/util.js`. Update `dialogue.js` to call the shared version. No new functionality — just DRY extraction. Testable by running the bot and confirming idle dialogue still works.

- [ ] **2. Add `dialogue.narrator` to lock config**
  Add `"dialogue.narrator"` to `functional.state.sleeping`'s block list in `locks.json`. One line change. Testable by inspecting lock state while sleeping.

- [ ] **3. Add `narrator:error` quotes to seed file**
  Add a handful of Marvin-flavored fallback quotes under category `narrator:error` in `dialogue/quotes.json`. Pure data, no code.

- [ ] **4. Scaffold narrator skill structure**
  Replace the current `narrator.js` stub with the real module shell: config loading (all env vars via `requireEnv`), `start(bot)`/`stop()` lifecycle, logger, `_active` guard, observation ring buffer (capped array with push/shift). No observation logic yet — just the skeleton that other steps plug into.

- [ ] **5. Implement polling sink**
  Build the polling loop inside the narrator. Read `polling_sink.json` definitions, implement the snapshot-and-diff engine. Start with the simplest sources: `timeOfDay` (band transitions) and `weather` (boolean flips). These require zero entity tracking — just reading `bot.time` and `bot.isRaining`. Observations go into the ring buffer. Testable by logging observations while the bot runs through a day/night cycle.

- [ ] **6. Add player-aware polling sources**
  Add `nearestPlayer` (presence, distance, held item, sneaking) and `playerCount` to the polling loop. Uses the shared `playersNearby` util from step 1. Testable by walking up to Marvin and watching observation logs.

- [ ] **7. Add derived polling sources**
  Add `loneliness` (timer from player absence with escalating thresholds) and `nearbyMobs` (grouped entity count). These derive from other polling state. Testable by leaving Marvin alone and checking escalation timing.

- [ ] **8. Implement event sink**
  Build the event subscription engine. Read `event_sink.json`, subscribe to listed events with filters, push observations to the ring buffer. Start with `chat`, `playerJoined`, `playerLeft` — simplest filters, no radius math. Then add `blockMining`, `entityDeath`, `entityHurt`, `chestInteraction`, `explosion`. Clean teardown in `stop()` via stored handler references.

- [ ] **9. Install AI SDK and implement LLM narration**
  `npm install ai` plus the chosen provider package. Build the narration timer: read buffer, construct prompt (Marvin persona + recent observations), call `generateText()`, post to `bot.chat()`. Gate with `orchestrator.allowed('dialogue.narrator')`, `_active` guard, and `playersNearby` check. Fallback to `bot.dialogue.say('narrator:error')` on failure.

- [ ] **10. Add `.env.sample` entries and wire into bot entry point**
  Add all `NARRATOR_*` env vars to `.env.sample`. Wire narrator `start(bot)`/`stop()` into `MarvinMinecraftBot.js` alongside existing skills. End-to-end testable.

- [ ] **11. Tune and harden**
  Run the full system. Tune polling interval, LLM interval, observation buffer size, prompt wording. Address chat spam overlap between narrator and idle dialogue (cooldown suppression). Adjust event filters based on real noise levels.
