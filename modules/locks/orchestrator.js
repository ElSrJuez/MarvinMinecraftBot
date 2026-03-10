const fs = require('fs').promises;
const path = require('path');
const { createLogger, requireEnv } = require('../log/logging');

const logger = createLogger('Orchestrator');

const config = {};
try {
  config.rulesFile = requireEnv('Orchestrator', 'LOCK_CONFIG_FILE');
  config.stateFile = requireEnv('Orchestrator', 'LOCK_STATE_FILE');
} catch (err) {
  logger.error(`Initialization failed: ${err.message}`);
  throw err;
}

const rules = JSON.parse(require('fs').readFileSync(path.resolve(config.rulesFile), 'utf8'));
logger.info(`loaded lock rules from ${config.rulesFile}`);

const _active = new Set();

function _writeState () {
  const state = [..._active];
  fs.writeFile(path.resolve(config.stateFile), JSON.stringify(state, null, 2), 'utf8')
    .catch(err => logger.warn(`failed to write lock state: ${err.message}`));
}

function _matchesAny (trigger, patterns) {
  if (!patterns || !patterns.length) return false;
  return patterns.some(p => trigger === p || trigger.startsWith(p + '.'));
}

function allowed (trigger) {
  for (const lock of _active) {
    const type = lock.split('.')[0];
    const rule = rules[lock] || {};

    if (type === 'safety') {
      if (!_matchesAny(trigger, rule.allow)) return false;
    } else if (type === 'functional') {
      if (_matchesAny(trigger, rule.block)) return false;
    }
  }
  return true;
}

async function run (triplet, fn) {
  if (_active.has(triplet)) {
    logger.debug(`${triplet} already active`);
    return null;
  }
  if (!allowed(triplet)) {
    return null;
  }

  _active.add(triplet);
  _writeState();
  logger.debug(`lock acquired: ${triplet}`);
  try {
    return await fn();
  } finally {
    _active.delete(triplet);
    _writeState();
    logger.debug(`lock released: ${triplet}`);
  }
}

module.exports = { allowed, run };
