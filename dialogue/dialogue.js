const fs = require('fs').promises;
const { createLogger, requireEnv, parseIntRequired, parseFloatRequired } = require('../log/logging');

// #region Configuration Loading
const logger = createLogger('Dialogue');
const config = {};

try {
  config.enabled = requireEnv('Dialogue', 'QUOTE_ENABLED') === 'true';
  const urlString = requireEnv('Dialogue', 'QUOTE_URL');
  config.urls = urlString.split(',').map(s => s.trim()).filter(Boolean);
  if (config.urls.length === 0) throw new Error('Dialogue: QUOTE_URL contains no valid URLs');
  
  config.intervalMs = parseIntRequired('Dialogue', 'QUOTE_INTERVAL_MS');
  config.probability = parseFloatRequired('Dialogue', 'QUOTE_PROBABILITY');
  config.maxChunkLength = parseIntRequired('Dialogue', 'QUOTE_MAX_LEN');
  config.cacheFile = requireEnv('Dialogue', 'QUOTE_CACHE_FILE');
  config.radius = parseFloatRequired('Dialogue', 'QUOTE_RADIUS');
} catch (err) {
  logger.error(`Initialization failed: ${err.message}`);
  throw err; // Re-throw to prevent the module from being used in a broken state
}
// #endregion

class Dialogue {
  constructor (bot) {
    this.bot = bot;
    this.quotes = [];
    this._timer = null;
    this._running = false;
  }

  async _readCache () {
    try {
      const txt = await fs.readFile(config.cacheFile, 'utf8')
      const data = JSON.parse(txt)
      if (Array.isArray(data) && data.length) return data
      return null
    } catch (err) {
      logger.warn(`failed to read cache ${config.cacheFile}: ${err.message}`)
      return null
    }
  }

  async _writeCache (arr) {
    try {
      await fs.writeFile(config.cacheFile, JSON.stringify(arr, null, 2), 'utf8')
    } catch (err) {
      logger.warn(`failed to write cache ${config.cacheFile}: ${err.message}`)
    }
  }

  async _fetchUrls () {
    const combined = []
    for (const u of config.urls) {
      try {
        const res = await fetch(u)
        if (!res.ok) {
          logger.warn(`failed to fetch ${u}: ${res.status}`)
          continue
        }
        const body = await res.json()
        if (Array.isArray(body)) combined.push(...body)
        else if (Array.isArray(body.quotes)) combined.push(...body.quotes)
      } catch (err) {
        logger.warn(`fetch error for ${u}: ${err && err.message}`)
      }
    }
    return combined
  }

  _normalizeQuotes (arr) {
    return arr.map(q => (typeof q === 'string' ? q : (q && q.quote) || '')).filter(Boolean)
  }

  _pickRandom () {
    if (!this.quotes || !this.quotes.length) return null
    return this.quotes[Math.floor(Math.random() * this.quotes.length)].trim()
  }

  _splitIntoChunks (text) {
    const max = config.maxChunkLength
    if (!text || text.length <= max) return text ? [text] : []

    const words = text.split(/\s+/)
    const numChunks = Math.ceil(text.length / max)
    const targetWords = Math.ceil(words.length / numChunks)

    const parts = []
    let idx = 0
    while (idx < words.length) {
      const prefix = parts.length > 0 ? '...' : ''
      const limit = max - prefix.length
      let chunk = ''
      let count = 0
      while (idx < words.length && count < targetWords) {
        const sep = chunk ? ' ' : ''
        if (chunk && (chunk + sep + words[idx]).length > limit) break
        chunk += sep + words[idx]
        idx++
        count++
      }
      parts.push(prefix + chunk)
    }
    return parts
  }

  async loadQuotes (force = false) {
    if (!force) {
      const cache = await this._readCache()
      if (cache) {
        this.quotes = this._normalizeQuotes(cache)
        logger.info(`loaded ${this.quotes.length} quotes from cache (${config.cacheFile})`)
        return this.quotes
      }
    }
    const fetched = await this._fetchUrls()
    if (fetched && fetched.length) {
      this.quotes = this._normalizeQuotes(fetched)
      logger.info(`fetched ${this.quotes.length} quotes from URL(s)`)
      await this._writeCache(this.quotes)
    }
    return this.quotes
  }

  async _sendChunks (chunks) {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i].trim()
      if (!chunk) continue
      logger.info(`sending chunk (${i + 1}/${chunks.length}): ${chunk.length} chars`)
      try {
        this.bot.chat(chunk)
      } catch (err) {
        logger.warn(`failed to send chat chunk: ${err.message}`)
      }
      // small pause between parts
      await new Promise(r => setTimeout(r, 700))
    }
  }

  async _maybeQuote () {
    if (Math.random() > config.probability) return
    const q = this._pickRandom()
    if (!q) return
    logger.debug(`selected quote length ${q.length}`)

    // send only if there are players within radius
    if (!this._playersNearby(config.radius)) {
      logger.debug(`no players within radius ${config.radius}; skipping quote`)
      return
    }

    const chunks = this._splitIntoChunks(q)
    await this._sendChunks(chunks)
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
    
    await this.loadQuotes(false)
    if (!this.quotes || this.quotes.length === 0) {
      logger.warn('No quotes available after load; dialogue will be disabled')
      return
    }
    // initial delay a bit so bot has time to join
    this._timer = setInterval(() => {
      this._maybeQuote().catch(err => logger.error(`maybeQuote error: ${err && err.message}`))
    }, config.intervalMs)
    // also schedule first run shortly after start
    setTimeout(() => { this._maybeQuote().catch(err => logger.error(`maybeQuote error: ${err && err.message}`)) }, 2000)
  }

  stop () {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
    this._running = false
  }
}

module.exports = Dialogue
