const fs = require('fs').promises;
const path = require('path');
const { createLogger, requireEnv, parseIntRequired } = require('../log/logging');
const orchestrator = require('../locks/orchestrator');

const logger = createLogger('Coordinator');
const config = {};

try {
  config.commentaryCadenceMs = parseIntRequired('Coordinator', 'DIALOGUE_COMMENTARY_CADENCE_MS');
  config.sourcesFile = requireEnv('Coordinator', 'DIALOGUE_COMMENTARY_SOURCES_FILE');
} catch (err) {
  logger.error(`Initialization failed: ${err.message}`);
  throw err;
}

class DialogueCoordinator {
  constructor(bot, dialogue, narrator) {
    this.bot = bot;
    this.dialogue = dialogue;
    this.narrator = narrator;
    this.lastCommentaryTime = -Infinity;  // Allow first message immediately, then enforce cadence
    this.timer = null;
    this.sources = [];
  }

  async _loadSources() {
    try {
      const sourcesPath = path.resolve(config.sourcesFile);
      const txt = await fs.readFile(sourcesPath, 'utf8');
      this.sources = JSON.parse(txt).sources;
      logger.debug(`loaded ${this.sources.length} commentary sources from ${sourcesPath}`);
    } catch (err) {
      logger.error(`failed to load sources file: ${err.message}`);
      throw err;
    }
  }

  async _getSourceMessage(source) {
    try {
      if (source.type === 'narrator') {
        return await this.narrator.getCommentary();
      } else if (source.type === 'dialogue') {
        return this.dialogue.getCommentaryForCategory(source.category);
      }
      return null;
    } catch (err) {
      logger.warn(`source ${source.name} failed: ${err.message}`);
      return null;
    }
  }

  async _maybeSpeak() {
    const now = Date.now();
    if (now - this.lastCommentaryTime < config.commentaryCadenceMs) return;

    if (!orchestrator.allowed('dialogue.idle')) return;

    // Try each source in priority order
    for (const source of this.sources) {
      const message = await this._getSourceMessage(source);
      if (message && message.trim()) {
        this.bot.chat(message);
        logger.info(`[${source.name}] ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);
        this.lastCommentaryTime = now;
        return;
      }
    }
  }

  async start() {
    await this._loadSources();
    this.timer = setInterval(() => this._maybeSpeak(), config.commentaryCadenceMs);
    logger.info(`Dialogue coordinator active (cadence: ${config.commentaryCadenceMs}ms)`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    logger.info('Coordinator stopped');
  }
}

module.exports = DialogueCoordinator;
