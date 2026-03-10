# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**MarvinMinecraftBot** is a Minecraft bot built on [Mineflayer](https://github.com/PrismarineJS/mineflayer) that roleplays as Marvin the Paranoid Android. It connects to a Minecraft server, looks at the nearest player, performs skills (sleeping, returning to outpost), and delivers in-character dialogue — all coordinated through a lock orchestrator and canonical dialogue engine.

## Coding Principles

- **Simplicity over bloat**: Keep code minimal. Don't add abstractions, helpers, or features that aren't immediately needed. Less code is better code.
- **DRY (Don't Repeat Yourself)**: Extract shared logic rather than duplicating it. If you see the same pattern twice, it should be a function.
- **Canonical code**: One way to do things. Follow the patterns already established in the codebase — don't introduce alternative styles or competing approaches.
- **No in-code defaults**: All configuration lives in `.env`. Code must never fall back to hardcoded default values — if a required env var is missing, fail loudly via `requireEnv()` / `parseIntRequired()` / `parseFloatRequired()`. This keeps `.env.sample` as the single source of truth for configuration.
- **No silent fallbacks**: If something is wrong, surface it. Don't swallow errors or silently degrade. Code should fail fast and visibly so problems are caught early, not masked.

## Development Commands

```bash
# Start the bot
npm start

# Audit and fix npm security vulnerabilities
npm run audit:fix
```

## Project Structure

```
MarvinMinecraftBot.js          Entry point — boots bot, wires skills, starts dialogue
modules/
  dialogue/dialogue.js         Canonical dialogue engine
  dialogue/quotes.json         Seed file — Marvin's situational lines
  locks/orchestrator.js        Lock orchestrator — central gatekeeper for all actions
  locks/locks.json             Lock suppression rules
  log/logging.js               Logging + env helpers
  skills/lazysleeper.js        Skill: sleep in beds at night
  skills/outpost.js            Skill: remember and return to a position
  skills/narrator.js           Skill: observe + LLM commentary (stub)
  skills/narrator/             Narrator data definitions
    polling_sink.json          Declarative polling source definitions
    event_sink.json            Declarative event subscription definitions
    prompts.json               LLM prompt artifacts (persona, templates, fragments)
  skills/util.js               Shared skill utilities
design/                        System design documents
  DIALOGUE.md                  Dialogue engine design
  LOCKS.md                     Lock orchestrator design
  NARRATE.md                   Narrator system design + implementation plan
  MINEFLAYER_EVENTS.md         Mineflayer event inventory reference
scratchpad/objectives.md       Roadmap and pending feature plans
state/                         Runtime state (lock state, quote cache)
```

## Key Design Documents

- **`design/DIALOGUE.md`** — Canonical quote file, categories, seed/remote merge, idle behaviour, skill integration
- **`design/LOCKS.md`** — Triplet schema, safety vs functional locks, suppression rules, orchestrator API, skill namespace
- **`design/NARRATE.md`** — Narrator two-sink architecture, observation model, LLM integration, implementation plan
- **`scratchpad/objectives.md`** — Full plans for pending features (narrator, skill loader)

## Configuration

All configuration is environment-variable driven via `.env` file. See `.env.sample` for all available options. No in-code defaults — missing required vars fail loudly.

## Dependencies

- `mineflayer@^4.35.0` - Minecraft bot protocol library
- `mineflayer-pathfinder` - Pathfinding for bot navigation
- `dotenv@^16.0.0` - Environment variable loading
