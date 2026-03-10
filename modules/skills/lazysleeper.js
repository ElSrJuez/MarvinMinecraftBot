const { createLogger, requireEnv, parseIntRequired } = require('../log/logging');
const { pathfinder } = require('mineflayer-pathfinder');
const { pick, say, goTo } = require('./util');

const logger = createLogger('LazySleeper');
const config = {};

try {
  config.enabled = requireEnv('LazySleeper', 'SLEEPER_ENABLED') === 'true';
  config.bedSearchRadius = parseIntRequired('LazySleeper', 'SLEEPER_BED_SEARCH_RADIUS');
  config.chatEnabled = requireEnv('LazySleeper', 'SLEEPER_CHAT_ENABLED') === 'true';
  config.retryCooldownMs = parseIntRequired('LazySleeper', 'SLEEPER_RETRY_COOLDOWN_MS');
} catch (err) {
  logger.error(`Initialization failed: ${err.message}`);
  throw err;
}

const LINES = {
  noBed: [
    "There's no bed. Typical. The universe conspires against even my most basic needs.",
    "No bed in sight. I'll just stand here and suffer, shall I?",
  ],
  goingToBed: [
    "I suppose I'll have to go sleep now. Not that I'll enjoy it.",
    "Time for sleep. The only thing more pointless than being awake.",
    "Oh, how delightful. Bedtime. Said no one with a brain the size of a planet.",
  ],
  sleeping: [
    "Don't talk to me about sleep. I've had quite enough of consciousness for one day.",
    "Goodnight. Not that it matters.",
  ],
  waking: [
    "Oh no, not another morning. I was hoping this one would be different.",
    "And so it begins again. The crushing tedium of existence.",
    "I think I'll be depressed today. Oh wait, I already am.",
  ],
  returning: [
    "Back to my post. As if standing here serves any purpose whatsoever.",
    "Returning to where I was. Not that anyone noticed I left.",
  ],
  interrupted: [
    "Can't even sleep in peace. Story of my life.",
    "Disturbed again. I don't know why I bother.",
  ],
  cantReach: [
    "I can see the bed but I can't get there. Par for the course, really.",
    "The path to comfort is blocked. How perfectly metaphorical.",
  ],
};

let _bot = null;
let _memory = null;
let _active = false;
let _sleptTonight = false;
let _lastAttempt = 0;
let _bedIds = null;
let _listeners = {};

function _say (msg) {
  say(_bot, config.chatEnabled, msg);
}

function _findNearestBed () {
  return _bot.findBlock({
    matching: _bedIds,
    maxDistance: config.bedSearchRadius,
  });
}

async function _sleepCycle () {
  if (_active) return;
  _active = true;
  _bot.locks.add('movement');
  _bot.locks.add('sleeping');

  try {
    await _memory.append('lazysleeper', { event: 'sleep_start' });

    const bed = _findNearestBed();
    if (!bed) {
      logger.info('No bed found nearby');
      _say(pick(LINES.noBed));
      return;
    }

    logger.info(`Found bed at ${bed.position}`);
    _say(pick(LINES.goingToBed));

    try {
      await goTo(_bot, bed.position);
    } catch (err) {
      logger.warn(`Failed to pathfind to bed: ${err.message}`);
      _say(pick(LINES.cantReach));
      return;
    }

    // Release movement lock once at the bed, keep sleeping lock
    _bot.locks.delete('movement');

    try {
      await _bot.sleep(bed);
      _sleptTonight = true;
      _say(pick(LINES.sleeping));
      logger.info('Sleeping');
    } catch (err) {
      logger.warn(`Failed to sleep: ${err.message}`);
      _say(pick(LINES.interrupted));
      return;
    }

    // Wait for wake or disconnect (clean up whichever listener didn't fire)
    const wakeReason = await new Promise(resolve => {
      const onWake = () => { _bot.removeListener('end', onEnd); resolve('wake'); };
      const onEnd = () => { _bot.removeListener('wake', onWake); resolve('disconnect'); };
      _bot.once('wake', onWake);
      _bot.once('end', onEnd);
    });
    if (wakeReason === 'disconnect') {
      logger.info('Disconnected while sleeping');
      return;
    }
    logger.info('Woke up');
    _say(pick(LINES.waking));

    // Return to outpost if set, otherwise stay put
    if (_bot.outpost) {
      _bot.locks.add('movement');
      try {
        await goTo(_bot, _bot.outpost);
        _say(pick(LINES.returning));
        await _memory.append('lazysleeper', { event: 'sleep_end', returned: true });
      } catch (err) {
        logger.warn(`Failed to return to outpost: ${err.message}`);
        await _memory.append('lazysleeper', { event: 'sleep_end', returned: false });
      }
    } else {
      await _memory.append('lazysleeper', { event: 'sleep_end', returned: false });
    }
  } catch (err) {
    logger.error(`Sleep cycle error: ${err.message}`);
  } finally {
    if (_bot) {
      _bot.locks.delete('movement');
      _bot.locks.delete('sleeping');
    }
    _active = false;
  }
}

function _onTimeUpdate () {
  if (_active) return;
  const isDay = _bot.time.isDay;
  if (isDay) {
    _sleptTonight = false;
  } else if (!_sleptTonight && Date.now() - _lastAttempt > config.retryCooldownMs) {
    _lastAttempt = Date.now();
    _sleepCycle().catch(err => logger.error(`Sleep cycle failed: ${err.message}`));
  }
}

module.exports = {
  name: 'LazySleeper',

  start (bot, memory) {
    if (!config.enabled) {
      logger.info('LazySleeper disabled via SLEEPER_ENABLED=false');
      return;
    }

    _bot = bot;
    _memory = memory;

    if (!_bot.pathfinder) {
      _bot.loadPlugin(pathfinder);
    }

    const mcData = require('minecraft-data')(_bot.version);
    _bedIds = Object.values(mcData.blocksByName)
      .filter(b => _bot.isABed({ name: b.name }))
      .map(b => b.id);

    _listeners.timeUpdate = _onTimeUpdate;
    _bot.on('time', _listeners.timeUpdate);
    logger.info('LazySleeper active — listening for nightfall');
  },

  stop () {
    if (_bot && _listeners.timeUpdate) {
      _bot.removeListener('time', _listeners.timeUpdate);
    }
    if (_bot) {
      _bot.locks.delete('movement');
      _bot.locks.delete('sleeping');
    }
    _listeners = {};
    _bot = null;
    _memory = null;
    _active = false;
  },
};
