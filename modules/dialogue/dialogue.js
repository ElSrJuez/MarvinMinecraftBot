const fs = require('fs').promises;
const path = require('path');
const { createLogger, requireEnv, parseIntRequired, parseFloatRequired } = require('../log/logging');
const orchestrator = require('../locks/orchestrator');

// #region Configuration Loading
const logger = createLogger('Dialogue');
const config = {};

try {
  config.enabled = requireEnv('Dialogue', 'QUOTE_ENABLED') === 'true';
  const urlString = requireEnv('Dialogue', 'QUOTE_URL');
  config.urls = urlString.split(',').map(s => s.trim()).filter(Boolean);
  config.seedFile = requireEnv('Dialogue', 'QUOTE_SEED_FILE');
  config.intervalMs = parseIntRequired('Dialogue', 'QUOTE_INTERVAL_MS');
  config.probability = parseFloatRequired('Dialogue', 'QUOTE_PROBABILITY');
  config.cacheFile = requireEnv('Dialogue', 'QUOTE_CACHE_FILE');
  config.radius = parseFloatRequired('Dialogue', 'QUOTE_RADIUS');
} catch (err) {
  logger.error(`Initialization failed: ${err.message}`);
  throw err;
}
// #endregion

class Dialogue {
  constructor (bot) {
    this.bot = bot;
    this._categories = {}  // { category: [quote, ...] }
    this._timer = null;
    this._running = false;
  }

  // Read the canonical quote file; seed from quotes.json if it doesn't exist yet
  async _readCanonical () {
    try {
      const txt = await fs.readFile(config.cacheFile, 'utf8')
      const data = JSON.parse(txt)
      if (Array.isArray(data) && data.length) return data
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn(`failed to read canonical file: ${err.message}`)
      }
    }

    // Seed from the configured seed file
    try {
      const seedPath = path.resolve(config.seedFile)
      const txt = await fs.readFile(seedPath, 'utf8')
      const data = JSON.parse(txt)
      if (Array.isArray(data) && data.length) {
        logger.info(`seeded canonical file from ${seedPath}`)
        return data
      }
    } catch (err) {
      logger.error(`failed to read seed file ${config.seedFile}: ${err.message}`)
    }

    return []
  }

  async _writeCanonical (entries) {
    const dir = path.dirname(config.cacheFile)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(config.cacheFile, JSON.stringify(entries, null, 2), 'utf8')
  }

  async _fetchRemote () {
    if (!config.urls.length) return []
    const results = []
    for (const url of config.urls) {
      try {
        const res = await fetch(url)
        if (!res.ok) {
          logger.warn(`failed to fetch ${url}: ${res.status}`)
          continue
        }
        const body = await res.json()
        const raw = Array.isArray(body) ? body : (Array.isArray(body.quotes) ? body.quotes : [])
        for (const entry of raw) {
          const text = typeof entry === 'string' ? entry : (entry && entry.quote) || ''
          if (!text) continue
          results.push({
            quote: text,
            person: (entry && entry.person) || '',
            source: `remote:${url}`,
            category: (entry && entry.category) || 'idle'
          })
        }
        logger.info(`fetched ${raw.length} quotes from ${url}`)
      } catch (err) {
        logger.warn(`fetch error for ${url}: ${err && err.message}`)
      }
    }
    return results
  }

  _merge (existing, remote) {
    const seen = new Set(existing.map(e => `${e.source}\t${e.quote}`))
    let added = 0
    for (const entry of remote) {
      const key = `${entry.source}\t${entry.quote}`
      if (!seen.has(key)) {
        existing.push(entry)
        seen.add(key)
        added++
      }
    }
    if (added) logger.info(`merged ${added} new remote quotes into canonical file`)
    return existing
  }

  _index (entries) {
    this._categories = {}
    for (const entry of entries) {
      const text = (entry && entry.quote) || ''
      if (!text) continue
      const category = (entry && entry.category) || 'idle'
      if (!this._categories[category]) this._categories[category] = []
      this._categories[category].push(text)
    }
    const idle = (this._categories.idle || []).length
    const cats = Object.keys(this._categories).length
    logger.info(`indexed ${idle} idle quotes, ${cats} categories total`)
  }

  _pick (category) {
    const pool = this._categories[category]
    if (!pool || !pool.length) return null
    return pool[Math.floor(Math.random() * pool.length)].trim()
  }

  say (category) {
    const q = this._pick(category)
    if (q) this.bot.chat(q)
    return q
  }

  async loadQuotes () {
    let entries = await this._readCanonical()
    const remote = await this._fetchRemote()
    if (remote.length) {
      entries = this._merge(entries, remote)
      await this._writeCanonical(entries)
    } else if (entries.length) {
      // Ensure canonical file exists on disk (seeded but not yet written)
      await this._writeCanonical(entries)
    }
    this._index(entries)
  }

  _maybeQuote () {
    if (Math.random() > config.probability) return
    if (!orchestrator.allowed('dialogue.idle')) return
    const q = this._pick('idle')
    if (!q) return

    if (!this._playersNearby(config.radius)) {
      logger.debug(`no players within radius ${config.radius}; skipping quote`)
      return
    }

    logger.info(`sending quote: ${q.length} chars`)
    this.bot.chat(q)
  }

  _playersNearby (radius) {
    if (!this.bot.entity) return false
    const mePos = this.bot.entity.position
    const players = Object.keys(this.bot.players).filter(n => n !== this.bot.username)
    const r2 = radius * radius
    for (const name of players) {
      const p = this.bot.players[name]
      if (!p.entity || !p.entity.position) continue
      const pos = p.entity.position
      const dx = pos.x - mePos.x
      const dy = pos.y - mePos.y
      const dz = pos.z - mePos.z
      if (dx * dx + dy * dy + dz * dz <= r2) return true
    }
    return false
  }

  async start () {
    if (this._running) return
    if (!config.enabled) {
      logger.info('Dialogue disabled via QUOTE_ENABLED=false')
      return
    }
    this._running = true

    await this.loadQuotes()
    if (!Object.keys(this._categories).length) {
      logger.warn('No quotes available after load; dialogue will be disabled')
      return
    }
    this._timer = setInterval(() => this._maybeQuote(), config.intervalMs)
    setTimeout(() => this._maybeQuote(), 2000)
  }

  stop () {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
    this._running = false
  }
}

module.exports = Dialogue
