const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const mineflayer = require('mineflayer');
const { createLogger, requireEnv, parseIntRequired } = require('./log/logging');

// #region Configuration Loading
const logger = createLogger('Bot');
const config = {};

try {
  config.host = requireEnv('Bot', 'MC_HOST');
  config.port = parseIntRequired('Bot', 'MC_PORT');
  config.username = requireEnv('Bot', 'MC_USERNAME');
} catch (err) {
  logger.error(`Initialization failed: ${err.message}`);
  process.exit(1);
}
// #endregion

const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: config.username
});

bot.on('login', () => logger.info(`Bot logged in as ${config.username}`));
bot.on('kicked', (reason) => logger.warn(`Bot kicked: ${reason}`));
bot.on('error', (err) => logger.error(`Bot error: ${err.message}`));
bot.on('end', () => logger.info('Bot disconnected'));
bot.on('message', (jsonMsg) => logger.info(`Chat message: ${jsonMsg.toString()}`));

// modules and skills
const { loadSkills, startAll, stopAll } = require('./skills/loader');
const memory = require('./memory/memory');
const skills = loadSkills(path.join(__dirname, 'skills'));

let dialogue = null;
try {
  const Dialogue = require('./dialogue/dialogue');
  dialogue = new Dialogue(bot);
} catch (err) {
  logger.error(`Dialogue module could not be initialized: ${err.message}`);
}

bot.once('spawn', async () => {
  logger.info('Bot spawned');
  if (dialogue) {
    dialogue.start().catch(err => logger.error(`Dialogue failed to start: ${err.message}`));
  }
  await startAll(skills, bot, memory);
});

bot.on('end', () => stopAll(skills));

function lookAtNearestPlayer () {
  const playerFilter = (entity) => entity.type === 'player'
  const playerEntity = bot.nearestEntity(playerFilter)
  
  if (!playerEntity) return
  
  const pos = playerEntity.position.offset(0, playerEntity.height, 0)
  bot.lookAt(pos)
}

bot.on('physicTick', lookAtNearestPlayer)