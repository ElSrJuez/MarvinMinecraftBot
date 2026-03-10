# Mineflayer Event Inventory

Reference for narrator observation design. Source: mineflayer/docs/api.md

## Visibility / Tracking

- `bot.entities` — map of all entities in loaded chunks (server-controlled render distance, typically 4-10 chunks depending on server config)
- `bot.players` — map of usernames to player objects; `player.entity` is null if the player is too far to track
- Entity tracking range is server-side; the bot sees whatever the server sends it
- In a base scenario: the bot will see you, mobs that wander into range, and not much else

## Entity Events (single entity arg unless noted)

| Event | Signature | Notes |
|---|---|---|
| entitySpawn | (entity) | Any entity appears in tracking range |
| entityGone | (entity) | Any entity leaves tracking range or despawns |
| entityMoved | (entity) | FIREHOSE — fires on every sub-block position change |
| entityUpdate | (entity) | Generic data update |
| entitySwingArm | (entity) | Arm swing — mining or attacking |
| entityHurt | (entity) | Takes damage |
| entityDead | (entity) | Dies |
| entityCrouch | (entity) | Sneaking |
| entityUncrouch | (entity) | Stops sneaking |
| entitySleep | (entity) | Goes to bed |
| entityWake | (entity) | Wakes up |
| entityEat | (entity) | Consumes food |
| entityEquip | (entity) | Armor or held item change |
| entityElytraFlew | (entity) | Elytra flight start |
| entityAttach | (entity, vehicle) | Mounts vehicle |
| entityDetach | (entity, vehicle) | Dismounts vehicle |
| entityEffect | (entity, effect) | Status effect applied |
| entityEffectEnd | (entity, effect) | Status effect expires |
| entityCriticalEffect | (entity) | Critical hit visual |
| entityMagicCriticalEffect | (entity) | Magic crit visual |
| entityAttributes | (entity) | Attribute modifier change |
| entityHandSwap | (entity) | Swaps main/offhand |
| entityTaming | (entity) | Taming in progress |
| entityTamed | (entity) | Taming complete |
| entityShakingOffWater | (entity) | Animal shaking off water |
| entityEatingGrass | (entity) | Animal eating grass |

## Block Events

| Event | Signature | Notes |
|---|---|---|
| blockUpdate | (oldBlock, newBlock) | ANY block change — FIREHOSE in active areas |
| blockUpdate:(x,y,z) | (oldBlock, newBlock) | Scoped to specific coordinate |
| blockPlaced | (oldBlock, newBlock) | Only when THE BOT places a block |
| blockBreakProgressObserved | (block, destroyStage, entity) | Someone mining — has entity ref and stage 0-9 |
| blockBreakProgressEnd | (block, entity) | Mining stopped/completed |
| diggingCompleted | (block) | Only when THE BOT finishes mining |
| diggingAborted | (block) | Only when THE BOT stops mining |

## Player Events

| Event | Signature | Notes |
|---|---|---|
| playerJoined | (player) | Player joins server |
| playerLeft | (player) | Player leaves server |
| playerUpdated | (player) | Player data changes |
| chat | (username, message, translate, jsonMsg, matches) | Public chat |
| whisper | (username, message, translate, jsonMsg, matches) | Private message |

## Item Events

| Event | Signature | Notes |
|---|---|---|
| itemDrop | (entity) | Item dropped in world |
| playerCollect | (collector, collected) | Entity picks up item |
| heldItemChanged | (heldItem) | BOT's held item changes |

## World Events

| Event | Signature | Notes |
|---|---|---|
| time | () | Time update — check bot.time.timeOfDay |
| rain | () | Rain starts/stops — check bot.isRaining |
| weatherUpdate | () | Rain or thunder changes |
| chunkColumnLoad | (point) | Chunk loaded |
| chunkColumnUnload | (point) | Chunk unloaded |

## Sound Events

| Event | Signature | Notes |
|---|---|---|
| soundEffectHeard | (soundName, position, volume, pitch) | Named sound nearby |
| hardcodedSoundEffectHeard | (soundId, soundCategory, position, volume, pitch) | Hardcoded sound ID |
| noteHeard | (block, instrument, pitch) | Note block played |

## Mechanical Events

| Event | Signature | Notes |
|---|---|---|
| pistonMove | (block, isPulling, direction) | Piston activates |
| chestLidMove | (block, isOpen, block2) | Chest opens/closes |

## Bot-Self Events

| Event | Signature | Notes |
|---|---|---|
| spawn | () | Bot spawns/respawns |
| death | () | Bot dies |
| health | () | Health/food changes |
| breath | () | Oxygen changes |
| experience | () | XP changes |
| sleep | () | Bot enters bed |
| wake | () | Bot leaves bed |
| move | () | Bot moves |
| forcedMove | () | Bot teleported |
| mount | () | Bot enters vehicle |
| dismount | (vehicle) | Bot exits vehicle |
| physicsTick | () | Every tick — FIREHOSE |

## UI / Server Events

| Event | Signature | Notes |
|---|---|---|
| login | () | Authenticated |
| kicked | (reason, loggedIn) | Kicked |
| end | (reason) | Disconnected |
| error | (err) | Error |
| windowOpen | (window) | Container opened |
| windowClose | (window) | Container closed |
| title | (title, type) | Title notification |
| particle | () | Particle effect |
| message | (jsonMsg, position, sender, verified) | Any server message |
| messagestr | (message, messagePosition, jsonMsg, sender, verified) | Stringified message |
| actionBar | (jsonMsg, verified) | Action bar text |
| resourcePack | (url, hash) | Resource pack request |
| scoreboard/team/bossBar events | various | UI overlay stuff |

## Entity Object Properties

- position, velocity — Vec3
- name — display name
- username — player name (players only)
- type — entity type string
- mobType — specific mob type
- heldItem — current held item
- equipment — armor/equipped items array
- metadata — state metadata
