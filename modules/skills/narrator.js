const fs = require('fs').promises;
const path = require('path');
const { generateText } = require('ai');
const { createLogger, requireEnv, parseIntRequired, parseFloatRequired } = require('../log/logging');
const orchestrator = require('../locks/orchestrator');
const { playersNearby } = require('./util');

// #region Configuration Loading
const logger = createLogger('Narrator');
const config = {};

try {
  config.enabled = requireEnv('Narrator', 'NARRATOR_ENABLED') === 'true';
  config.chatEnabled = requireEnv('Narrator', 'NARRATOR_CHAT_ENABLED') === 'true';
  config.observeRadius = parseFloatRequired('Narrator', 'NARRATOR_OBSERVE_RADIUS');
  config.pollIntervalMs = parseIntRequired('Narrator', 'NARRATOR_POLL_INTERVAL_MS');
  config.llmIntervalMs = parseIntRequired('Narrator', 'NARRATOR_LLM_INTERVAL_MS');
  config.maxObservations = parseIntRequired('Narrator', 'NARRATOR_MAX_OBSERVATIONS');
  config.llmProvider = requireEnv('Narrator', 'NARRATOR_LLM_PROVIDER');
  config.llmModel = requireEnv('Narrator', 'NARRATOR_LLM_MODEL');
  config.llmApiKey = requireEnv('Narrator', 'NARRATOR_LLM_API_KEY');
  config.llmTemperature = parseFloatRequired('Narrator', 'NARRATOR_LLM_TEMPERATURE');
  config.llmMaxTokens = parseIntRequired('Narrator', 'NARRATOR_LLM_MAX_TOKENS');
  config.promptsFile = requireEnv('Narrator', 'NARRATOR_PROMPTS_FILE');
} catch (err) {
  logger.error(`Initialization failed: ${err.message}`);
  throw err;
}
// #endregion

class Narrator {
  constructor (bot) {
    this.bot = bot;
    this._observations = [];
    this._active = false;
    this._timers = [];
    this._eventHandlers = [];
    this._prompts = {};
    this._lastSnapshotTime = 0;
    this._lastLlmTime = 0;
    this._snapshot = {
      nearestPlayer: null,
      playerCount: 0,
      timeOfDay: null,
      timeOfDayBand: null,
      weather: { raining: false, thundering: false },
      nearbyMobs: {},
      botHealth: bot.health,
      playerPresentSince: null
    };
  }

  async _loadPrompts () {
    try {
      const promptsPath = path.resolve(config.promptsFile);
      const txt = await fs.readFile(promptsPath, 'utf8');
      this._prompts = JSON.parse(txt);
      logger.info(`loaded prompts from ${promptsPath}`);
    } catch (err) {
      logger.error(`failed to load prompts file: ${err.message}`);
      throw err;
    }
  }

  _pushObservation (source, text) {
    const obs = {
      time: Date.now(),
      source,
      text
    };
    this._observations.push(obs);
    if (this._observations.length > config.maxObservations) {
      this._observations.shift();
    }
    logger.debug(`[${source}] ${text}`);
  }

  _getTimeOfDayBand (timeOfDay) {
    // timeOfDay is 0-23999
    if (timeOfDay < 2000) return 'dawn';
    if (timeOfDay < 6000) return 'morning';
    if (timeOfDay < 9000) return 'midday';
    if (timeOfDay < 12000) return 'afternoon';
    if (timeOfDay < 13500) return 'dusk';
    if (timeOfDay < 22500) return 'night';
    return 'lateNight';
  }

  _pollSnapshot () {
    const now = Date.now();
    if (now - this._lastSnapshotTime < config.pollIntervalMs) return;
    this._lastSnapshotTime = now;

    const prevSnapshot = { ...this._snapshot };

    // nearestPlayer
    const nearest = this.bot.nearestEntity(
      e => e.type === 'player' && e !== this.bot.entity
    );
    this._snapshot.nearestPlayer = nearest;

    if (!nearest && prevSnapshot.nearestPlayer) {
      this._pushObservation('polling:nearestPlayer', 'Player walked away. Alone again.');
      this._snapshot.playerPresentSince = null;
    } else if (nearest && !prevSnapshot.nearestPlayer) {
      this._pushObservation('polling:nearestPlayer', `${nearest.username} showed up.`);
      this._snapshot.playerPresentSince = now;
    }

    // playerCount
    const playerCount = Object.values(this.bot.players).filter(
      p => p.entity && p.entity !== this.bot.entity
    ).length;
    if (playerCount !== prevSnapshot.playerCount) {
      if (playerCount > prevSnapshot.playerCount) {
        this._pushObservation('polling:playerCount', 'More people nearby now.');
      } else if (playerCount < prevSnapshot.playerCount) {
        this._pushObservation('polling:playerCount', 'Someone left.');
      }
    }
    this._snapshot.playerCount = playerCount;

    // timeOfDay
    const timeOfDay = this.bot.time.timeOfDay;
    const band = this._getTimeOfDayBand(timeOfDay);
    if (band !== prevSnapshot.timeOfDayBand) {
      this._pushObservation('polling:timeOfDay', `It's ${band} now.`);
    }
    this._snapshot.timeOfDay = timeOfDay;
    this._snapshot.timeOfDayBand = band;

    // weather
    const raining = this.bot.isRaining;
    const thundering = this.bot.thunderState > 0.5;
    if (raining && !prevSnapshot.weather.raining) {
      this._pushObservation('polling:weather', 'It started raining.');
    } else if (!raining && prevSnapshot.weather.raining) {
      this._pushObservation('polling:weather', 'Rain stopped.');
    }
    if (thundering && !prevSnapshot.weather.thundering) {
      this._pushObservation('polling:weather', 'Thunder rolling in.');
    } else if (!thundering && prevSnapshot.weather.thundering) {
      this._pushObservation('polling:weather', 'Thunder subsided.');
    }
    this._snapshot.weather = { raining, thundering };

    // nearbyMobs
    const nearbyMobs = {};
    for (const entityId in this.bot.entities) {
      const entity = this.bot.entities[entityId];
      if (entity.type !== 'mob') continue;
      const dist = entity.position.distanceTo(this.bot.entity.position);
      if (dist > config.observeRadius) continue;
      const mobType = entity.mobType || entity.name || 'unknown';
      nearbyMobs[mobType] = (nearbyMobs[mobType] || 0) + 1;
    }
    for (const mobType in nearbyMobs) {
      if (!(mobType in prevSnapshot.nearbyMobs)) {
        this._pushObservation(
          'polling:nearbyMobs',
          `${nearbyMobs[mobType]} ${mobType}(s) nearby.`
        );
      }
    }
    for (const mobType in prevSnapshot.nearbyMobs) {
      if (!(mobType in nearbyMobs)) {
        this._pushObservation(
          'polling:nearbyMobs',
          `No more ${mobType}(s).`
        );
      }
    }
    this._snapshot.nearbyMobs = nearbyMobs;

    // botHealth
    const health = this.bot.health;
    if (Math.abs(health - prevSnapshot.botHealth) >= 2) {
      if (health < prevSnapshot.botHealth) {
        this._pushObservation(
          'polling:botHealth',
          'Something hurt me. How delightful.'
        );
      }
    }
    this._snapshot.botHealth = health;
  }

  _pollDerivedSources () {
    const now = Date.now();

    // loneliness
    if (this._snapshot.playerPresentSince === null) {
      const aloneMs = now - (this._snapshot.lonelinessSince || now);
      const aloneMin = Math.floor(aloneMs / 1000 / 60);

      if (aloneMin >= 10 && (!this._snapshot.loneliness10 || !this._snapshot.loneliness10Seen)) {
        this._pushObservation(
          'polling:loneliness',
          'Ten minutes alone. I think they\'ve forgotten about me.'
        );
        this._snapshot.loneliness10 = true;
        this._snapshot.loneliness10Seen = true;
      } else if (aloneMin >= 5 && (!this._snapshot.loneliness5Seen)) {
        this._pushObservation(
          'polling:loneliness',
          'Five minutes alone. A new record in tedium.'
        );
        this._snapshot.loneliness5Seen = true;
      } else if (aloneMin >= 1 && (!this._snapshot.loneliness1Seen)) {
        this._pushObservation(
          'polling:loneliness',
          'Nobody\'s been here for a minute.'
        );
        this._snapshot.loneliness1Seen = true;
      }
    } else {
      // Reset loneliness when player is present
      this._snapshot.lonelinessSince = null;
      this._snapshot.loneliness1Seen = false;
      this._snapshot.loneliness5Seen = false;
      this._snapshot.loneliness10Seen = false;
    }

    if (this._snapshot.playerPresentSince === null && !this._snapshot.lonelinessSince) {
      this._snapshot.lonelinessSince = now;
    }
  }

  _subscribeToEvents () {
    // chat
    const chatHandler = (username, message) => {
      if (username === this.bot.username) return;
      this._pushObservation(
        'event:chat',
        `${username} said: "${message}"`
      );
    };
    this.bot.on('chat', chatHandler);
    this._eventHandlers.push({ event: 'chat', handler: chatHandler });

    // playerJoined
    const playerJoinedHandler = (player) => {
      if (player.username === this.bot.username) return;
      this._pushObservation(
        'event:playerJoined',
        `${player.username} joined the server.`
      );
    };
    this.bot.on('playerJoined', playerJoinedHandler);
    this._eventHandlers.push({ event: 'playerJoined', handler: playerJoinedHandler });

    // playerLeft
    const playerLeftHandler = (player) => {
      if (player.username === this.bot.username) return;
      this._pushObservation(
        'event:playerLeft',
        `${player.username} left the server.`
      );
    };
    this.bot.on('playerLeft', playerLeftHandler);
    this._eventHandlers.push({ event: 'playerLeft', handler: playerLeftHandler });

    // entityDead
    const entityDeadHandler = (entity) => {
      const dist = entity.position.distanceTo(this.bot.entity.position);
      if (dist > config.observeRadius) return;
      const name = entity.username || entity.name || entity.mobType || 'something';
      this._pushObservation(
        'event:entityDead',
        `${name} died nearby.`
      );
    };
    this.bot.on('entityDead', entityDeadHandler);
    this._eventHandlers.push({ event: 'entityDead', handler: entityDeadHandler });

    // entityHurt (players only, with cooldown per player)
    const hurtCooldowns = {};
    const entityHurtHandler = (entity) => {
      if (entity.type !== 'player' || entity === this.bot.entity) return;
      const dist = entity.position.distanceTo(this.bot.entity.position);
      if (dist > config.observeRadius) return;

      const now = Date.now();
      const key = entity.username;
      if (hurtCooldowns[key] && now - hurtCooldowns[key] < 5000) return;
      hurtCooldowns[key] = now;

      this._pushObservation(
        'event:entityHurt',
        `${entity.username} took damage.`
      );
    };
    this.bot.on('entityHurt', entityHurtHandler);
    this._eventHandlers.push({ event: 'entityHurt', handler: entityHurtHandler });

    // blockBreakProgressObserved
    const blockMiningHandler = (block, destroyStage, entity) => {
      if (!entity || entity.type !== 'player' || entity === this.bot.entity) return;
      if (destroyStage !== 0) return; // only start of mining
      const dist = block.position.distanceTo(this.bot.entity.position);
      if (dist > config.observeRadius) return;

      this._pushObservation(
        'event:blockMining',
        `${entity.username} started mining ${block.name}.`
      );
    };
    this.bot.on('blockBreakProgressObserved', blockMiningHandler);
    this._eventHandlers.push({ event: 'blockBreakProgressObserved', handler: blockMiningHandler });

    // chestLidMove
    const chestHandler = (block, isOpen) => {
      const dist = block.position.distanceTo(this.bot.entity.position);
      if (dist > config.observeRadius) return;
      const action = isOpen ? 'opened' : 'closed';
      this._pushObservation(
        'event:chestInteraction',
        `Someone ${action} a chest nearby.`
      );
    };
    this.bot.on('chestLidMove', chestHandler);
    this._eventHandlers.push({ event: 'chestLidMove', handler: chestHandler });

    // soundEffectHeard (explosions and thunder)
    const soundHandler = (soundName) => {
      if (!soundName.includes('explosion') && !soundName.includes('thunder')) return;
      this._pushObservation(
        'event:soundEffect',
        `Heard a ${soundName}.`
      );
    };
    this.bot.on('soundEffectHeard', soundHandler);
    this._eventHandlers.push({ event: 'soundEffectHeard', handler: soundHandler });
  }

  async _getModel () {
    if (!this._model) {
      const providerName = config.llmProvider.toLowerCase();
      let createModel;
      try {
        if (providerName === 'openai') {
          const { openai } = require('@ai-sdk/openai');
          createModel = () => openai(config.llmModel, { apiKey: config.llmApiKey });
        } else if (providerName === 'anthropic') {
          const { anthropic } = require('@ai-sdk/anthropic');
          createModel = () => anthropic(config.llmModel, { apiKey: config.llmApiKey });
        } else if (providerName === 'google') {
          const { google } = require('@ai-sdk/google');
          createModel = () => google(config.llmModel, { apiKey: config.llmApiKey });
        } else {
          throw new Error(`Unsupported provider: ${config.llmProvider}`);
        }
        this._model = createModel();
      } catch (err) {
        logger.error(`Failed to initialize LLM provider ${providerName}: ${err.message}`);
        throw err;
      }
    }
    return this._model;
  }

  async _maybeNarrate () {
    const now = Date.now();
    if (now - this._lastLlmTime < config.llmIntervalMs) return;
    if (this._active) return;
    if (!this._observations.length) return;
    if (!orchestrator.allowed('dialogue.narrator')) return;
    if (!playersNearby(this.bot, config.observeRadius)) return;

    this._lastLlmTime = now;
    this._active = true;

    try {
      const model = await this._getModel();

      const observationStr = this._observations
        .slice(-10) // last 10 observations
        .map(obs => this._prompts.observationFormat
          .replace('{time}', new Date(obs.time).toLocaleTimeString())
          .replace('{text}', obs.text))
        .join('\n');

      const userPrompt = this._observations.length === 0
        ? this._prompts.noObservations
        : this._prompts.user.replace('{observations}', observationStr);

      logger.debug(`narration: ${this._observations.length} observations, calling LLM`);

      const response = await generateText({
        model,
        system: this._prompts.system,
        prompt: userPrompt,
        temperature: config.llmTemperature,
        maxTokens: config.llmMaxTokens
      });

      if (response.text && response.text.trim()) {
        if (config.chatEnabled) {
          this.bot.chat(response.text.trim());
        }
        this._observations = [];
        logger.info(`narration sent: ${response.text.length} chars`);
      }
    } catch (err) {
      logger.warn(`narration failed: ${err.message}`);
      if (config.chatEnabled && this.bot.dialogue) {
        this.bot.dialogue.say('narrator:error');
      }
    } finally {
      this._active = false;
    }
  }

  async start () {
    if (!config.enabled) {
      logger.info('Narrator disabled via NARRATOR_ENABLED=false');
      return;
    }

    try {
      await this._loadPrompts();
    } catch (err) {
      logger.error(`Failed to load prompts: ${err.message}`);
      throw err;
    }

    this._subscribeToEvents();

    // Polling loop
    const pollTimer = setInterval(() => {
      this._pollSnapshot();
      this._pollDerivedSources();
    }, config.pollIntervalMs);
    this._timers.push(pollTimer);

    // Narration loop
    const llmTimer = setInterval(() => {
      this._maybeNarrate();
    }, config.llmIntervalMs);
    this._timers.push(llmTimer);

    logger.info('Narrator active');
  }

  stop () {
    for (const timer of this._timers) {
      clearInterval(timer);
    }
    this._timers = [];

    for (const { event, handler } of this._eventHandlers) {
      this.bot.removeListener(event, handler);
    }
    this._eventHandlers = [];

    this._observations = [];
    logger.info('Narrator stopped');
  }
}

let narratorInstance = null;

module.exports = {
  name: 'Narrator',

  async start(bot, memory) {
    narratorInstance = new Narrator(bot);
    await narratorInstance.start();
  },

  stop() {
    if (narratorInstance) {
      narratorInstance.stop();
      narratorInstance = null;
    }
  }
};
