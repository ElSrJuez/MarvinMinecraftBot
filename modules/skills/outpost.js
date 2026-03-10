const { createLogger, requireEnv, parseIntRequired, parseFloatRequired } = require('../log/logging');
const { pathfinder } = require('mineflayer-pathfinder');
const { pick, say, goTo } = require('./util');

const logger = createLogger('Outpost');
const config = {};

try {
  config.enabled = requireEnv('Outpost', 'OUTPOST_ENABLED') === 'true';
  config.command = requireEnv('Outpost', 'OUTPOST_COMMAND');
  config.returnIntervalMs = parseIntRequired('Outpost', 'OUTPOST_RETURN_INTERVAL_MS');
  config.returnRadius = parseFloatRequired('Outpost', 'OUTPOST_RETURN_RADIUS');
  config.chatEnabled = requireEnv('Outpost', 'OUTPOST_CHAT_ENABLED') === 'true';
} catch (err) {
  logger.error(`Initialization failed: ${err.message}`);
  throw err;
}

const LINES = {
  set: [
    "Fine. I'll stand here. It's not like I had anywhere better to be.",
    "Another pointless location to call home. Acknowledged.",
  ],
  returning: [
    "Trudging back to my designated spot. Joy.",
    "I suppose I should return to my post. Not that it matters.",
    "Back I go. The universe's most overqualified sentry.",
  ],
};

let _bot = null;
let _memory = null;
let _timer = null;
let _listeners = {};

function _say (msg) {
  say(_bot, config.chatEnabled, msg);
}

function _distanceToOutpost () {
  if (!_bot.outpost || !_bot.entity) return 0;
  const pos = _bot.entity.position;
  const dx = pos.x - _bot.outpost.x;
  const dy = pos.y - _bot.outpost.y;
  const dz = pos.z - _bot.outpost.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

async function _returnToOutpost () {
  if (!_bot.outpost) return;
  if (_bot.locks.has('movement') || _bot.locks.has('sleeping')) return;
  if (_distanceToOutpost() <= config.returnRadius) return;

  _bot.locks.add('movement');
  try {
    logger.info(`Returning to outpost (${_distanceToOutpost().toFixed(1)} blocks away)`);
    _say(pick(LINES.returning));
    await goTo(_bot, _bot.outpost);
  } catch (err) {
    logger.warn(`Failed to return to outpost: ${err.message}`);
  } finally {
    if (_bot) _bot.locks.delete('movement');
  }
}

function _onChat (username, message) {
  if (username === _bot.username) return;
  if (message.trim().toLowerCase() !== config.command.toLowerCase()) return;

  const player = _bot.players[username];
  if (!player || !player.entity) {
    logger.warn(`Cannot set outpost: player ${username} not visible`);
    return;
  }

  const pos = player.entity.position;
  _bot.outpost = { x: pos.x, y: pos.y, z: pos.z };
  _memory.append('outpost', { event: 'set', pos: _bot.outpost })
    .catch(err => logger.warn(`Failed to save outpost: ${err.message}`));

  logger.info(`Outpost set to (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) by ${username}`);
  _say(pick(LINES.set));
  _returnToOutpost().catch(err => logger.error(`Failed to go to new outpost: ${err.message}`));
}

module.exports = {
  name: 'Outpost',

  async start (bot, memory) {
    if (!config.enabled) {
      logger.info('Outpost disabled via OUTPOST_ENABLED=false');
      return;
    }

    _bot = bot;
    _memory = memory;

    if (!_bot.pathfinder) {
      _bot.loadPlugin(pathfinder);
    }

    // Load saved outpost from memory
    const entries = await _memory.read('outpost', 1);
    if (entries.length > 0 && entries[0].pos) {
      _bot.outpost = entries[0].pos;
      logger.info(`Loaded outpost from memory: (${_bot.outpost.x.toFixed(1)}, ${_bot.outpost.y.toFixed(1)}, ${_bot.outpost.z.toFixed(1)})`);
    } else {
      _bot.outpost = null;
      logger.info('No saved outpost found');
    }

    _listeners.chat = _onChat;
    _bot.on('chat', _listeners.chat);

    _timer = setInterval(() => {
      _returnToOutpost().catch(err => logger.error(`Return to outpost failed: ${err.message}`));
    }, config.returnIntervalMs);

    logger.info(`Outpost active — command: "${config.command}"`);
  },

  stop () {
    if (_timer) clearInterval(_timer);
    _timer = null;
    if (_bot && _listeners.chat) {
      _bot.removeListener('chat', _listeners.chat);
    }
    if (_bot) _bot.locks.delete('movement');
    _listeners = {};
    _bot = null;
    _memory = null;
  },
};
