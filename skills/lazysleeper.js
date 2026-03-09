const { createLogger, requireEnv, parseIntRequired } = require('../log/logging');
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');

const logger = createLogger('LazySleeper');
const config = {};

try {
  config.enabled = requireEnv('LazySleeper', 'SLEEPER_ENABLED') === 'true';
  config.bedSearchRadius = parseIntRequired('LazySleeper', 'SLEEPER_BED_SEARCH_RADIUS');
  config.chatEnabled = requireEnv('LazySleeper', 'SLEEPER_CHAT_ENABLED') === 'true';
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

function _pick (arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

let _bot = null;
let _memory = null;
let _sleeping = false;
let _listeners = {};

function _say (msg) {
  if (config.chatEnabled && _bot) _bot.chat(msg);
}

function _findNearestBed () {
  const bedNames = ['bed', '_bed'];
  const bedBlock = _bot.findBlock({
    matching: (block) => bedNames.some(n => block.name.includes(n)),
    maxDistance: config.bedSearchRadius,
  });
  return bedBlock;
}

async function _goTo (pos) {
  const mcData = require('minecraft-data')(_bot.version);
  const movements = new Movements(_bot, mcData);
  _bot.pathfinder.setMovements(movements);
  await _bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 2));
}

async function _onSleepNeeded () {
  if (_sleeping) return;
  _sleeping = true;

  try {
    const returnPos = _bot.entity.position.clone();
    await _memory.append('lazysleeper', { event: 'sleep_start', pos: { x: returnPos.x, y: returnPos.y, z: returnPos.z } });

    const bed = _findNearestBed();
    if (!bed) {
      logger.info('No bed found nearby');
      _say(_pick(LINES.noBed));
      _sleeping = false;
      return;
    }

    logger.info(`Found bed at ${bed.position}`);
    _say(_pick(LINES.goingToBed));

    try {
      await _goTo(bed.position);
    } catch (err) {
      logger.warn(`Failed to pathfind to bed: ${err.message}`);
      _say(_pick(LINES.cantReach));
      _sleeping = false;
      return;
    }

    try {
      await _bot.sleep(bed);
      _say(_pick(LINES.sleeping));
      logger.info('Sleeping');
    } catch (err) {
      logger.warn(`Failed to sleep: ${err.message}`);
      _say(_pick(LINES.interrupted));
      _sleeping = false;
      return;
    }

    // wait for wake
    await new Promise(resolve => _bot.once('wake', resolve));
    logger.info('Woke up');
    _say(_pick(LINES.waking));

    // return to previous position
    try {
      await _goTo(returnPos);
      _say(_pick(LINES.returning));
      await _memory.append('lazysleeper', { event: 'sleep_end', returned: true });
    } catch (err) {
      logger.warn(`Failed to return to previous position: ${err.message}`);
      await _memory.append('lazysleeper', { event: 'sleep_end', returned: false });
    }
  } catch (err) {
    logger.error(`Sleep cycle error: ${err.message}`);
  } finally {
    _sleeping = false;
  }
}

function _onTimeUpdate () {
  if (_sleeping) return;
  // Minecraft day is 24000 ticks; sleep is possible from 12541 to 23458
  const time = _bot.time.timeOfDay;
  if (time >= 12541 && time <= 13000) {
    _onSleepNeeded().catch(err => logger.error(`Sleep cycle failed: ${err.message}`));
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
    _sleeping = false;
  },
};
