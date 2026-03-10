# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**MarvinMinecraftBot** is a Minecraft bot built on [Mineflayer](https://github.com/PrismarineJS/mineflayer) that connects to a Minecraft server and:
- Looks at the nearest player at all times (on each physics tick)
- Periodically sends quotes from a remote URL to the chat when idle and players are nearby
- Logs all activity to console and `.log` files in the `LOG_DIR` directory

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

## Architecture

### Core Files

**MarvinMinecraftBot.js** (Entry point)
- Loads configuration from environment variables (MC_HOST, MC_PORT, MC_USERNAME)
- Creates the Mineflayer bot instance
- Loads skills via the skill loader, initializes Dialogue module
- On spawn: starts dialogue and all skills; on end: stops all skills
- Attaches event handlers and the `lookAtNearestPlayer` behavior

**modules/skills/loader.js** (Skill framework)
- Auto-discovers `.js` files in `modules/skills/` (excluding `loader.js`)
- Each skill must export `{ name, start(bot, memory), stop() }`
- Individually try/catches each skill load and start — one broken skill doesn't crash the bot
- Adding a new skill = dropping a file in `modules/skills/` that follows the contract

**modules/memory/memory.js** (Shared memory module)
- Canonical module for all persistent memory needs — all skills use this
- File-backed JSONL storage: one file per skill in `MEMORY_DIR` (`state/`)
- API: `append(skill, entry)`, `read(skill, n)`, `clear(skill)`
- Auto-trims to `MEMORY_MAX_ENTRIES` per skill on append
- Config: MEMORY_DIR, MEMORY_MAX_ENTRIES

**modules/dialogue/dialogue.js** (Quote system)
- Implements the Dialogue class that manages periodic quote sending
- Fetches quotes from one or more URLs (configured via QUOTE_URL)
- Caches quotes locally to `QUOTE_CACHE_FILE` to avoid repeated network requests
- Only sends quotes if players are nearby (within QUOTE_RADIUS)
- Configuration: QUOTE_ENABLED, QUOTE_URL, QUOTE_INTERVAL_MS, QUOTE_PROBABILITY, QUOTE_CACHE_FILE, QUOTE_RADIUS

**modules/log/logging.js** (Logging system)
- Provides a `createLogger(moduleName)` factory for creating module-specific loggers
- Exports helper functions: `requireEnv()`, `parseIntRequired()`, `parseFloatRequired()`
- Logs to both console and files (one file per module in LOG_DIR)
- Log level controlled by LOG_LEVEL env var (debug, info, warn, error)

### Data Flow

1. Bot starts → loads config → creates Mineflayer bot → loads skills from `modules/skills/` → waits for spawn event
2. On spawn → Dialogue starts → all skills start (each receives bot + memory) → behaviors are active
3. Each tick → `lookAtNearestPlayer()` executes and positions the bot's head toward nearest player
4. Skills operate independently via their own event listeners and timers
5. On disconnect → all skills are stopped via `stopAll()`

### Configuration

All configuration is environment-variable driven via `.env` file. See `.env.sample` for all available options:
- **Bot connection**: MC_HOST, MC_PORT, MC_USERNAME
- **Memory**: MEMORY_DIR, MEMORY_MAX_ENTRIES
- **Dialogue**: QUOTE_ENABLED, QUOTE_URL, QUOTE_INTERVAL_MS, QUOTE_PROBABILITY, QUOTE_CACHE_FILE, QUOTE_RADIUS
- **Skills**: Each skill has its own env vars (e.g. SLEEPER_ENABLED, NARRATOR_ENABLED)
- **Logging**: LOG_DIR, LOG_LEVEL

### Important Implementation Details

- **Locks**: `bot.locks` is a `Set` of named strings. Skills add/delete/check locks to coordinate. Current lock names:
  - `'movement'` — physical control in use (pathfinding); `lookAtNearestPlayer` yields when set
  - `'sleeping'` — bot is in bed; chat still works, but movement skills should yield
  - New lock types are just new strings — no registration needed
- **Player detection**: The dialogue module uses `this.bot.players` (which tracks players in sight) and calculates Euclidean distance to check if players are nearby.
- **Cache format**: Quotes are stored as JSON arrays. The loader normalizes both string quotes and `{ quote: "..." }` objects.
- **Quote sources**: The QUOTE_URL can be a comma-separated list of URLs. Both array and `{ quotes: [...] }` response formats are supported.
- **Errors are non-fatal**: The bot continues running even if dialogue fails to load quotes, fetch from URLs, or send messages.

## Dependencies

- `mineflayer@^4.35.0` - Minecraft bot protocol library
- `mineflayer-pathfinder` - Pathfinding for bot navigation (used by skills)
- `dotenv@^16.0.0` - Environment variable loading
