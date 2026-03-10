const { createLogger, requireEnv, parseIntRequired } = require('../log/logging');
const { pathfinder } = require('mineflayer-pathfinder');
const { say, goTo } = require('./util');
const orchestrator = require('../locks/orchestrator');

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

let _bot = null;
let _memory = null;
let _active = false;
let _sleptTonight = false;
let _lastAttempt = 0;
let _bedIds = null;
let _listeners = {};

function _say (category) {
  say(_bot, config.chatEnabled, category);
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

  try {
    await _memory.append('lazysleeper', { event: 'sleep_start' });

    const bed = _findNearestBed();
    if (!bed) {
      logger.info('No bed found nearby');
      _say('sleeper:noBed');
      return;
    }

    logger.info(`Found bed at ${bed.position}`);
    _say('sleeper:goingToBed');

    // Phase 1: pathfind to bed
    try {
      const reached = await orchestrator.run('safety.movement.pathfinding', () =>
        goTo(_bot, bed.position)
      );
      if (reached === null) {
        logger.debug('Pathfinding to bed denied by orchestrator');
        return;
      }
    } catch (err) {
      logger.warn(`Failed to pathfind to bed: ${err.message}`);
      _say('sleeper:cantReach');
      return;
    }

    // Phase 2: sleep
    const wakeReason = await orchestrator.run('functional.state.sleeping', async () => {
      try {
        await _bot.sleep(bed);
      } catch (err) {
        logger.warn(`Failed to sleep: ${err.message}`);
        _say('sleeper:interrupted');
        return null;
      }
      _sleptTonight = true;
      _say('sleeper:sleeping');
      logger.info('Sleeping');

      return new Promise(resolve => {
        const onWake = () => { _bot.removeListener('end', onEnd); resolve('wake'); };
        const onEnd = () => { _bot.removeListener('wake', onWake); resolve('disconnect'); };
        _bot.once('wake', onWake);
        _bot.once('end', onEnd);
      });
    });

    if (!wakeReason || wakeReason === 'disconnect') {
      if (wakeReason === 'disconnect') logger.info('Disconnected while sleeping');
      return;
    }

    logger.info('Woke up');
    _say('sleeper:waking');

    // Phase 3: return to outpost
    if (_bot && _bot.outpost) {
      try {
        const returned = await orchestrator.run('safety.movement.pathfinding', () =>
          goTo(_bot, _bot.outpost)
        );
        if (returned !== null) {
          _say('sleeper:returning');
          await _memory.append('lazysleeper', { event: 'sleep_end', returned: true });
        } else {
          await _memory.append('lazysleeper', { event: 'sleep_end', returned: false });
        }
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
    _listeners = {};
    _bot = null;
    _memory = null;
    _active = false;
  },
};
