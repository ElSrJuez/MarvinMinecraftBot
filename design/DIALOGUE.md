# Dialogue System

The dialogue module is the single canonical path for all bot chat output. No skill or module calls `bot.chat()` directly — everything flows through Dialogue.

## The Canonical Quote File

All quotes live in a single canonical JSON file (`QUOTE_CACHE_FILE`). This file is the source of truth for the dialogue engine. It ships with the repository pre-populated with hand-crafted Marvin lines and accumulates remote quotes over time.

Every entry in the canonical file has four fields:

| Field | Purpose |
|---|---|
| `quote` | The text to send to chat |
| `person` | Attribution (e.g. "Douglas Adams", "Marvin") |
| `source` | Origin tag — tracks where the entry came from for cache management |
| `category` | Routing tag — determines when the quote is used by the dialogue engine |

The `source` field is for bookkeeping: it lets the merge logic identify which entries came from which remote URL or were hand-crafted locally, so it can refresh remote entries without touching local ones.

The `category` field is for routing: it determines which pool a quote belongs to. The idle timer draws from the `idle` category. Skills request specific categories like `sleeper:noBed` or `outpost:set`.

## Quote Sources

Quotes enter the canonical file from two paths:

- **Pre-populated** — Marvin's situational lines ship with the repo in the canonical file, each with a `category` and a `source` identifying them as local.
- **Remote** (`QUOTE_URL`) — One or more comma-separated URLs pointing to JSON quote lists. On startup, remote quotes are fetched and merged into the canonical file. New entries are added; existing entries (matched by `quote` text and `source` tag) are left alone.

Remote sources use the standard schema: arrays of objects with `quote`, `person`, and `source` fields. Quotes that arrive without a `category` are automatically tagged as `idle`. Quotes that arrive with a `category` keep it as-is. This means remote sources can contribute to any category without code changes.

Multiple sources can feed into the same category. For example, two different URLs can both provide `idle` quotes, or a remote source could provide categorized skill lines alongside hand-crafted local ones.

## Categories

Every quote has a category. There is no special "uncategorized" pool — `idle` is simply the default category assigned to quotes that don't declare one.

- **`idle`** — General-purpose quotes sent on the periodic timer when players are nearby. This is where remote Adams quotes land by default.
- **`sleeper:noBed`**, **`sleeper:goingToBed`**, **`sleeper:sleeping`**, etc. — Situational lines spoken by skills at specific moments.
- **`outpost:set`**, **`outpost:returning`** — Outpost skill lines.

New categories require no code changes to the dialogue module. Add entries with a new category string to the canonical file, and call `bot.dialogue.say('newcategory')` from the skill.

## Idle Behaviour

The idle timer fires at a fixed interval (`QUOTE_INTERVAL_MS`). On each tick, it checks three conditions in order:

1. **Probability** — Rolls against `QUOTE_PROBABILITY`. Skips if the roll fails.
2. **Lock orchestrator** — Checks `orchestrator.allowed('dialogue.idle')`. Skips if any active lock suppresses idle dialogue (see `design/LOCKS.md`).
3. **Player proximity** — Checks if any player is within `QUOTE_RADIUS` blocks. Skips if no players are nearby.

If all three pass, a random quote from the `idle` category is sent to chat. This ensures Marvin stays quiet when busy (sleeping, pathfinding) and only speaks idle chatter when genuinely idle with an audience.

## Skill Integration

Skills access the dialogue module through `bot.dialogue`, which is set on the bot instance at startup. To speak, a skill calls `bot.dialogue.say(category)`, which picks a random quote from that category and sends it to chat. If the category has no quotes or dialogue failed to initialize, nothing is sent.

Each skill also has its own `chatEnabled` config flag. When disabled, the skill skips the `say()` call entirely — the skill stays functional but silent.

## Adding New Dialogue

To add situational lines for a new skill:

1. Add entries to the canonical quote file with the appropriate `category` and `source` tags.
2. Call `bot.dialogue.say('skillname:situation')` from the skill at the appropriate moment.

To add a new remote idle source:

1. Append the URL to `QUOTE_URL` (comma-separated).
2. On next startup, its quotes are fetched, tagged as `idle` (unless they declare their own category), and merged into the canonical file.

No code changes to the dialogue module are needed in either case.

## Configuration

| Variable | Purpose |
|---|---|
| `QUOTE_ENABLED` | Master switch for the entire dialogue system |
| `QUOTE_URL` | Comma-separated remote quote source URLs |
| `QUOTE_SEED_FILE` | Path to the seed file (ships with repo, used on first run) |
| `QUOTE_INTERVAL_MS` | Milliseconds between idle quote attempts |
| `QUOTE_PROBABILITY` | Chance (0–1) of sending on each interval tick |
| `QUOTE_RADIUS` | Block radius — idle quotes only sent when players are within range |
| `QUOTE_CACHE_FILE` | Path to the canonical quote file (the single source of truth) |
