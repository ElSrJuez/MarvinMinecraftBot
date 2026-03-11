const fs = require('fs').promises;
const path = require('path');
const { generateText } = require('ai');
const { createLogger, requireEnv, parseIntRequired, parseFloatRequired } = require('../log/logging');
const orchestrator = require('../locks/orchestrator');
const { playersNearby } = require('./util');

// #region Configuration Loading
const logger = createLogger('Narrator');
const promptLogger = createLogger('NarratorPrompts', { fileOnly: true });
const config = {};

try {
  config.enabled = requireEnv('Narrator', 'NARRATOR_ENABLED') === 'true';
  config.chatEnabled = requireEnv('Narrator', 'NARRATOR_CHAT_ENABLED') === 'true';
  config.observeRadius = parseFloatRequired('Narrator', 'NARRATOR_OBSERVE_RADIUS');
  config.pollIntervalMs = parseIntRequired('Narrator', 'NARRATOR_POLL_INTERVAL_MS');
  config.maxObservations = parseIntRequired('Narrator', 'NARRATOR_MAX_OBSERVATIONS');
  config.narrationMemorySize = parseIntRequired('Narrator', 'NARRATOR_NARRATION_MEMORY_SIZE');
  config.llmProvider = requireEnv('Narrator', 'NARRATOR_LLM_PROVIDER');
  config.llmModel = requireEnv('Narrator', 'NARRATOR_LLM_MODEL');
  config.llmApiKey = requireEnv('Narrator', 'NARRATOR_LLM_API_KEY');
  config.llmEndpoint = requireEnv('Narrator', 'NARRATOR_LLM_ENDPOINT');
  config.llmTemperature = parseFloatRequired('Narrator', 'NARRATOR_LLM_TEMPERATURE');
  config.llmMaxTokens = parseIntRequired('Narrator', 'NARRATOR_LLM_MAX_TOKENS');
  config.promptsFile = requireEnv('Narrator', 'NARRATOR_PROMPTS_FILE');
  config.pollingFile = requireEnv('Narrator', 'NARRATOR_POLLING_SINK_FILE');
  config.eventFile = requireEnv('Narrator', 'NARRATOR_EVENT_SINK_FILE');
} catch (err) {
  logger.error(`Initialization failed: ${err.message}`);
  throw err;
}
// #endregion

// Safe expression evaluator: builds a function from an expression string
// with named parameters drawn from a context object.
function buildEvaluator (expr, paramNames) {
  return new Function(...paramNames, `return ${expr}`);
}

class Narrator {
  constructor (bot) {
    this.bot = bot;
    this._observations = [];
    this._active = false;
    this._timers = [];
    this._eventHandlers = [];
    this._prompts = {};
    this._pollingSources = [];
    this._eventSubscriptions = [];
    this._narrationHistory = [];
    this._pollState = {};
    this._dedupeTrackers = {};
  }

  // #region Artifact Loading

  async _loadSinks () {
    const pollingPath = path.resolve(config.pollingFile);
    const eventPath = path.resolve(config.eventFile);

    const [pollingTxt, eventTxt] = await Promise.all([
      fs.readFile(pollingPath, 'utf8'),
      fs.readFile(eventPath, 'utf8')
    ]);

    this._pollingSources = JSON.parse(pollingTxt).sources;
    this._eventSubscriptions = JSON.parse(eventTxt).subscriptions;

    // Pre-compile polling read/extract functions so we don't rebuild them every cycle
    for (const source of this._pollingSources) {
      if (source.read && source.read !== 'derived') {
        source._readFn = buildEvaluator(source.read, ['bot', 'radius']);
      }
      if (source.fields) {
        for (const field of Object.values(source.fields)) {
          if (field.read) field._readFn = buildEvaluator(field.read, ['bot', 'radius']);
          if (field.extract) field._extractFn = buildEvaluator(field.extract, ['entity', 'bot', 'radius']);
        }
      }
    }

    logger.debug(`Loaded ${this._pollingSources.length} polling sources, ${this._eventSubscriptions.length} event subscriptions`);
  }

  async _loadPrompts () {
    const promptsPath = path.resolve(config.promptsFile);
    const txt = await fs.readFile(promptsPath, 'utf8');
    this._prompts = JSON.parse(txt);
    logger.info(`loaded prompts from ${promptsPath}`);
  }

  // #endregion

  _pushObservation (sourceId, text) {
    this._observations.push({ time: Date.now(), source: sourceId, text });
    if (this._observations.length > config.maxObservations) {
      this._observations.shift();
    }
  }

  _template (str, data) {
    let result = str;
    for (const key in data) {
      result = result.replaceAll(`{${key}}`, data[key] ?? 'unknown');
    }
    return result;
  }

  // #region Event Sink

  _subscribeToEvents () {
    for (const sub of this._eventSubscriptions) {
      // Parse parameter names from signature: "(block, destroyStage, entity)" → ['block','destroyStage','entity']
      const paramNames = sub.signature.replace(/[()]/g, '').split(',').map(s => s.trim());

      // Pre-compile filter and extract functions
      const allParams = [...paramNames, 'bot', 'radius'];
      const filterFn = buildEvaluator(sub.filter, allParams);
      const extractFn = buildEvaluator(sub.extract, allParams);

      const handler = (...args) => {
        try {
          // Build argument list: event args + bot + radius
          const callArgs = [...args, this.bot, config.observeRadius];

          if (!filterFn(...callArgs)) return;

          const extracted = extractFn(...callArgs);

          // Dedupe via cooldown
          if (sub.dedupe === 'cooldown' && sub.cooldownMs) {
            const dedupeKey = `evt:${sub.id}:${JSON.stringify(extracted)}`;
            const now = Date.now();
            if (this._dedupeTrackers[dedupeKey] && now - this._dedupeTrackers[dedupeKey] < sub.cooldownMs) return;
            this._dedupeTrackers[dedupeKey] = now;
          }

          this._pushObservation(sub.id, this._template(sub.observation, extracted));
        } catch (err) {
          logger.debug(`event ${sub.id} handler error: ${err.message}`);
        }
      };

      this.bot.on(sub.event, handler);
      this._eventHandlers.push({ event: sub.event, handler });
    }

    logger.info(`Event subscriptions active (${this._eventSubscriptions.length} events)`);
  }

  // #endregion

  // #region Polling Sink

  _pollAllSources () {
    for (const source of this._pollingSources) {
      try {
        if (source.read === 'derived') {
          this._pollDerived(source);
        } else if (source.fields && !source.read) {
          // Fields-only source (e.g., weather): each field has its own read
          this._pollFieldsOnly(source);
        } else if (source.fields) {
          // Source with top-level read + sub-fields (e.g., nearestPlayer)
          this._pollWithFields(source);
        } else {
          // Simple source with single read + diff
          this._pollSimple(source);
        }
      } catch (err) {
        logger.debug(`polling error on ${source.id}: ${err.message}`);
      }
    }
  }

  // Simple source: one read, one diff (e.g., playerCount, timeOfDay, botHealth, nearbyMobs)
  _pollSimple (source) {
    let current = source._readFn(this.bot, config.observeRadius);

    // countByName: convert entity array to { name: count } map
    if (source.diff === 'countByName' && Array.isArray(current)) {
      const map = {};
      for (const e of current) {
        const name = e.displayName?.toString() || e.name || 'unknown';
        map[name] = (map[name] || 0) + 1;
      }
      current = map;
    }

    const stateKey = source.id;
    if (!(stateKey in this._pollState)) {
      this._pollState[stateKey] = current;
      return;
    }

    const prev = this._pollState[stateKey];
    this._pollState[stateKey] = current;

    this._applyDiff(source, prev, current, {});
  }

  // Source with top-level read + sub-fields (e.g., nearestPlayer)
  _pollWithFields (source) {
    const entity = source._readFn(this.bot, config.observeRadius);

    // Store raw entity for derived sources
    this._pollState[source.id] = entity;

    // Template context for observations (e.g., {player})
    const templateData = {};
    if (entity && entity.username) templateData.player = entity.username;

    for (const [fieldName, field] of Object.entries(source.fields)) {
      const stateKey = `${source.id}.${fieldName}`;

      // Extract current value from entity
      let current;
      try {
        current = field._extractFn(entity, this.bot, config.observeRadius);
      } catch {
        current = undefined;
      }

      if (!(stateKey in this._pollState)) {
        this._pollState[stateKey] = current;
        continue;
      }

      const prev = this._pollState[stateKey];
      this._pollState[stateKey] = current;

      this._applyDiff(field, prev, current, templateData, source.id);
    }
  }

  // Fields-only source: no top-level read, each field reads independently (e.g., weather)
  _pollFieldsOnly (source) {
    for (const [fieldName, field] of Object.entries(source.fields)) {
      const stateKey = `${source.id}.${fieldName}`;

      const current = field._readFn(this.bot, config.observeRadius);

      if (!(stateKey in this._pollState)) {
        this._pollState[stateKey] = current;
        continue;
      }

      const prev = this._pollState[stateKey];
      this._pollState[stateKey] = current;

      this._applyDiff(field, prev, current, {}, source.id);
    }
  }

  // Derived sources (e.g., loneliness derived from nearestPlayer.present)
  _pollDerived (source) {
    if (source.diff !== 'duration') return;

    // Resolve the derived-from field
    const playerPresent = !!this._pollState[source.derivedFrom];
    const now = Date.now();

    if (!playerPresent) {
      if (!this._dedupeTrackers.lonelinessSince) {
        this._dedupeTrackers.lonelinessSince = now;
      }

      const aloneMs = now - this._dedupeTrackers.lonelinessSince;

      for (const threshold of source.durationThresholds) {
        const dedupeKey = `loneliness:${threshold}`;
        if (aloneMs >= threshold && !this._dedupeTrackers[dedupeKey]) {
          const obs = source.observations[String(threshold)];
          if (obs) this._pushObservation(source.id, this._template(obs, { minutes: Math.floor(aloneMs / 60000) }));
          this._dedupeTrackers[dedupeKey] = true;
        }
      }
    } else {
      this._dedupeTrackers.lonelinessSince = null;
      for (const threshold of source.durationThresholds) {
        this._dedupeTrackers[`loneliness:${threshold}`] = false;
      }
    }
  }

  // #endregion

  // #region Diff Strategies

  _applyDiff (spec, prev, current, templateData, sourceId) {
    const id = sourceId || spec.id;

    if (spec.diff === 'boolean') {
      if (prev === current) return;
      const key = `${prev}→${current}`;
      const obs = spec.observations?.[key];
      if (obs) this._pushObservation(id, this._template(obs, templateData));

    } else if (spec.diff === 'string') {
      if (prev === current) return;
      const obs = spec.observation;
      if (obs) this._pushObservation(id, this._template(obs, { ...templateData, value: current }));

    } else if (spec.diff === 'number') {
      if (prev === current) return;
      if (current === 0 && spec.observations?.['0']) {
        this._pushObservation(id, this._template(spec.observations['0'], templateData));
      } else if (current > prev && spec.observations?.increased) {
        this._pushObservation(id, this._template(spec.observations.increased, templateData));
      } else if (current < prev && spec.observations?.decreased) {
        this._pushObservation(id, this._template(spec.observations.decreased, templateData));
      }

    } else if (spec.diff === 'threshold') {
      if (prev === undefined || current === undefined) return;
      const t = spec.threshold;
      if (prev - current >= t && spec.observations?.decreased) {
        this._pushObservation(id, this._template(spec.observations.decreased, templateData));
      } else if (current - prev >= t && spec.observations?.increased) {
        this._pushObservation(id, this._template(spec.observations.increased, templateData));
      }
      if (current < 5 && spec.observations?.low) {
        this._pushObservation(id, this._template(spec.observations.low, templateData));
      }

    } else if (spec.diff === 'bands') {
      let prevBand = null, currBand = null;
      for (const [name, [min, max]] of Object.entries(spec.bands)) {
        if (prev >= min && prev < max) prevBand = name;
        if (current >= min && current < max) currBand = name;
      }
      if (prevBand !== currBand && currBand) {
        this._pushObservation(id, this._template(spec.observation, { ...templateData, band: currBand }));
      }

    } else if (spec.diff === 'countByName') {
      const prevKeys = new Set(Object.keys(prev || {}));
      const currKeys = new Set(Object.keys(current || {}));

      for (const name of currKeys) {
        if (!prevKeys.has(name) && spec.observations?.appeared) {
          this._pushObservation(id, this._template(spec.observations.appeared, { ...templateData, count: current[name], name }));
        }
      }
      for (const name of prevKeys) {
        if (!currKeys.has(name) && spec.observations?.disappeared) {
          this._pushObservation(id, this._template(spec.observations.disappeared, { ...templateData, name }));
        }
      }
    }
  }

  // #endregion

  // #region State Snapshot

  _buildStateSnapshot () {
    const lines = [];

    for (const source of this._pollingSources) {
      if (source.fields) {
        const entity = this._pollState[source.id];
        const templateData = {};
        if (entity && entity.username) templateData.player = entity.username;

        for (const [fieldName, field] of Object.entries(source.fields)) {
          if (!field.stateTemplate) continue;
          const value = this._pollState[`${source.id}.${fieldName}`];
          const line = this._resolveStateTemplate(field.stateTemplate, value, { ...templateData, value });
          if (line) lines.push(line);
        }
      } else if (source.stateTemplate && source.read !== 'derived') {
        const value = this._pollState[source.id];
        if (value === undefined) continue;

        // bands: resolve current band name
        if (source.diff === 'bands') {
          let band = null;
          for (const [name, [min, max]] of Object.entries(source.bands)) {
            if (value >= min && value < max) { band = name; break; }
          }
          if (band) lines.push(this._template(source.stateTemplate, { band }));
        } else {
          const line = this._resolveStateTemplate(source.stateTemplate, value, { value });
          if (line) lines.push(line);
        }
      }
    }

    return lines.join('\n');
  }

  _resolveStateTemplate (tpl, value, templateData) {
    if (typeof tpl === 'string') {
      return this._template(tpl, templateData);
    }
    // Object form: keyed by value (e.g., { "true": "It's raining.", "false": null })
    const key = String(value);
    const text = tpl[key];
    if (!text) return null;
    return this._template(text, templateData);
  }

  // #endregion

  // #region Aggregation

  _aggregateObservations (observations) {
    if (!observations.length) return observations;

    const textCounts = {};
    for (const obs of observations) {
      textCounts[obs.text] = (textCounts[obs.text] || 0) + 1;
    }

    const result = [];
    const seen = new Set();

    for (const obs of observations) {
      if (seen.has(obs.text)) continue;
      seen.add(obs.text);

      const count = textCounts[obs.text];
      result.push({
        time: obs.time,
        source: obs.source,
        text: count === 1 ? obs.text : `${obs.text} (×${count})`
      });
    }

    return result;
  }

  // #endregion

  // #region LLM

  async _getModel () {
    if (!this._model) {
      const providerName = config.llmProvider.toLowerCase();
      let createModel;
      if (config.llmEndpoint) {
        const { createOpenAICompatible } = require('@ai-sdk/openai-compatible');
        const provider = createOpenAICompatible({
          name: 'custom',
          apiKey: config.llmApiKey,
          baseURL: config.llmEndpoint
        });
        createModel = () => provider(config.llmModel);
        logger.info(`Using OpenAI-compatible endpoint: ${config.llmEndpoint}`);
      } else if (providerName === 'openai') {
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
    }
    return this._model;
  }

  async getCommentary () {
    if (this._active) return null;
    if (!this._observations.length) return null;
    if (!playersNearby(this.bot, config.observeRadius)) return null;

    this._active = true;

    try {
      const model = await this._getModel();

      const stateStr = this._buildStateSnapshot();
      const aggregated = this._aggregateObservations(this._observations);

      const observationStr = aggregated
        .map(obs => this._prompts.observationFormat
          .replace('{time}', new Date(obs.time).toLocaleTimeString())
          .replace('{text}', obs.text))
        .join('\n');

      const historyStr = this._narrationHistory.length > 0
        ? this._prompts.narrationMemory.replace('{history}',
            this._narrationHistory.map(n => `• ${n}`).join('\n'))
        : '';

      const basePrompt = this._observations.length === 0
        ? this._prompts.noObservations
        : this._prompts.user.replace('{observations}', observationStr);

      const userPrompt = basePrompt.replace('{state}', stateStr || 'Nothing notable.') + historyStr;

      promptLogger.info(`[NARRATION REQUEST] Raw: ${this._observations.length} → Aggregated: ${aggregated.length}, Memory: ${this._narrationHistory.length}/${config.narrationMemorySize}`);
      promptLogger.debug(`[SYSTEM PROMPT]\n${this._prompts.system}`);
      promptLogger.debug(`[USER PROMPT]\n${userPrompt}`);

      const response = await generateText({
        model,
        system: this._prompts.system,
        prompt: userPrompt,
        temperature: config.llmTemperature,
        maxTokens: config.llmMaxTokens
      });

      if (response.text && response.text.trim()) {
        const narration = response.text.trim();
        this._observations = [];

        this._narrationHistory.push(narration);
        if (this._narrationHistory.length > config.narrationMemorySize) {
          this._narrationHistory.shift();
        }

        promptLogger.debug(`[LLM RESPONSE]\n${narration}`);
        promptLogger.info(`[NARRATION] "${narration}"`);

        return narration;
      }
    } catch (err) {
      logger.warn(`Narration failed: ${err.message}`);
      promptLogger.warn(`[LLM ERROR] ${err.message}`);
      return null;
    } finally {
      this._active = false;
    }

    return null;
  }

  // #endregion

  async start () {
    if (!config.enabled) {
      logger.info('Narrator disabled via NARRATOR_ENABLED=false');
      return;
    }

    await this._loadPrompts();
    await this._loadSinks();

    this._subscribeToEvents();

    const pollTimer = setInterval(() => this._pollAllSources(), config.pollIntervalMs);
    this._timers.push(pollTimer);

    logger.info(`Narrator active (memory: ${config.narrationMemorySize}, max observations: ${config.maxObservations})`);
  }

  stop () {
    for (const timer of this._timers) clearInterval(timer);
    this._timers = [];

    for (const { event, handler } of this._eventHandlers) {
      this.bot.removeListener(event, handler);
    }
    this._eventHandlers = [];

    this._observations = [];
    this._narrationHistory = [];
    logger.info('Narrator stopped');
  }
}

let narratorInstance = null;

module.exports = {
  name: 'Narrator',

  async start (bot, memory) {
    narratorInstance = new Narrator(bot);
    await narratorInstance.start();
  },

  stop () {
    if (narratorInstance) {
      narratorInstance.stop();
      narratorInstance = null;
    }
  },

  async getCommentary () {
    if (!narratorInstance) return null;
    return await narratorInstance.getCommentary();
  }
};
