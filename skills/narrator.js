const { createLogger, requireEnv } = require('../log/logging');

const logger = createLogger('Narrator');
const config = {};

try {
  config.enabled = requireEnv('Narrator', 'NARRATOR_ENABLED') === 'true';
} catch (err) {
  logger.error(`Initialization failed: ${err.message}`);
  throw err;
}

module.exports = {
  name: 'Narrator',

  start (bot, memory) {
    if (!config.enabled) {
      logger.info('Narrator disabled via NARRATOR_ENABLED=false');
      return;
    }
    // TODO: implement observation + LLM narration
    logger.info('Narrator active (not yet implemented)');
  },

  stop () {
    // TODO: cleanup
  },
};
