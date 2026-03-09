const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');
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

class Dialogue extends EventEmitter {
  constructor (bot) {
    super();
    this.bot = bot;
    
    this.urls = config.urls;
    this.cacheFile = config.cacheFile;
    this.intervalMs = config.intervalMs;
    this.probability = config.probability;
    this.maxChunkLength = config.maxChunkLength;
    this.enabled = config.enabled;
    this.radius = config.radius;
    
    this.quotes = [];
    this._timer = null;
    this._running = false;
  }

  async _readCache () {
    try {
      const txt = await fs.readFile(this.cacheFile, 'utf8')
      const data = JSON.parse(txt)
      if (Array.isArray(data) && data.length) return data
      return null
    } catch (err) {
      return null
    }
  }

  async _writeCache (arr) {
    try {
      await fs.writeFile(this.cacheFile, JSON.stringify(arr, null, 2), 'utf8')
    } catch (err) {
      // non-fatal
    }
  }

  async _fetchUrls () {
    const combined = []
    if (!this.urls || this.urls.length === 0) return combined
    for (const u of this.urls) {
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

  _pickRandom () {
    if (!this.quotes || !this.quotes.length) return null
    return this.quotes[Math.floor(Math.random() * this.quotes.length)].trim()
  }

  _splitIntoChunks (text) {
    const max = this.maxChunkLength
    if (!text) return []
    if (text.length <= max) return [text]

    // Split into word tokens while keeping separators
    const tokens = text.split(/(\s+)/)
    const words = []
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (!t) continue
      if (/^\s+$/.test(t)) continue
      let w = t
      if (i + 1 < tokens.length && /^\s+$/.test(tokens[i + 1])) w += tokens[i + 1]
      words.push(w)
    }

    // Estimate number of chunks based on length, then aim for roughly equal word counts
    let numChunks = Math.max(1, Math.ceil(text.length / max))
    let targetWords = Math.max(1, Math.ceil(words.length / numChunks))

    const parts = []
    let idx = 0
    while (idx < words.length) {
      const isContinuation = parts.length >= 1
      const ell = isContinuation ? '...' : ''
      const allowed = Math.max(1, max - (isContinuation ? ell.length : 0))

      let chunk = ''
      let wordsInChunk = 0

      while (idx < words.length) {
        const candidate = chunk + words[idx]
        // if candidate too long
        if (candidate.length > allowed) {
          // if we haven't added any words, need to force-cut the long token
          if (wordsInChunk === 0) {
            const token = words[idx]
            // take slice that fits
            const slice = token.slice(0, allowed)
            chunk += slice
            // replace current word with the remainder (preserve without leading space)
            const remainder = token.slice(slice.length)
            if (remainder.trim().length > 0) {
              words[idx] = remainder
            } else {
              idx++
            }
          }
          break
        }
        chunk = candidate
        idx++
        wordsInChunk++
        if (wordsInChunk >= targetWords) break
      }

      // prefix continuation chunks with ellipsis
      chunk = (isContinuation ? '...' : '') + chunk.trim()
      parts.push(chunk)

      // Recalculate targetWords for remaining words to keep distribution even
      const remainingWords = Math.max(0, words.length - idx)
      if (remainingWords > 0) {
        numChunks = Math.max(1, Math.ceil(remainingWords / targetWords))
        targetWords = Math.max(1, Math.ceil(remainingWords / numChunks))
      }
    }

    return parts
  }

  async loadQuotes (force = false) {
    if (!force) {
      const cache = await this._readCache()
      if (cache) {
        // normalize cached entries to strings
        this.quotes = cache.map(q => (typeof q === 'string' ? q : (q && q.quote) || '')).filter(Boolean)
        logger.info(`loaded ${this.quotes.length} quotes from cache (${this.cacheFile})`)
        return this.quotes
      }
    }
    const fetched = await this._fetchUrls()
    if (fetched && fetched.length) {
      // normalize fetched entries to strings
      this.quotes = fetched.map(q => (typeof q === 'string' ? q : (q && q.quote) || '')).filter(Boolean)
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
        // use chat if available
        if (this.bot && typeof this.bot.chat === 'function') this.bot.chat(chunk)
      } catch (err) {
        // ignore send errors
      }
      // small pause between parts
      await new Promise(r => setTimeout(r, 700))
    }
  }

  async _maybeQuote () {
    if (Math.random() > this.probability) return
    const q = this._pickRandom()
    if (!q) return
    logger.debug(`selected quote length ${q.length}`)
    // ensure radius is configured
    if (typeof this.radius !== 'number' || Number.isNaN(this.radius)) {
      logger.error('QUOTE_RADIUS not configured; dialogue will not send messages')
      return
    }

    // send only if there are players within radius
    if (!this._playersNearby(this.radius)) {
      logger.debug(`no players within radius ${this.radius}; skipping quote`)
      return
    }

    const chunks = this._splitIntoChunks(q)
    await this._sendChunks(chunks)
  }

  _playersNearby (radius) {
    try {
      if (!this.bot || !this.bot.entity) return false
      const mePos = this.bot.entity.position
      // use bot.players entries which include player.entity when in sight
      const players = Object.keys(this.bot.players || {}).filter(n => n !== (this.bot.username || this.bot._username))
      const r2 = radius * radius
      for (const name of players) {
        const p = this.bot.players[name]
        if (!p || !p.entity || !p.entity.position) continue
        const pos = p.entity.position
        const dx = pos.x - mePos.x
        const dy = pos.y - mePos.y
        const dz = pos.z - mePos.z
        const dist2 = dx * dx + dy * dy + dz * dz
        if (dist2 <= r2) return true
      }
    } catch (err) {
      logger.warn(`playersNearby check failed: ${err && err.message}`)
    }
    return false
  }

  async start () {
    if (this._running) return
    if (!this.enabled) {
      logger.info('Dialogue disabled via QUOTE_ENABLED=false')
      return
    }
    this._running = true
    
    await this.loadQuotes(false)
    if (!this.quotes || this.quotes.length === 0) {
      // try a one-off fetch from default URL if no config provided, but warn loudly
      if (!this.urls || this.urls.length === 0) {
        logger.error('No quote URLs configured and no cached quotes found — dialogue will not run')
        this.enabled = false
        return
      }
      logger.warn('No quotes available after load; dialogue will be disabled')
      this.enabled = false
      return
    }
    // initial delay a bit so bot has time to join
    this._timer = setInterval(() => {
      this._maybeQuote().catch(err => logger.error(`maybeQuote error: ${err && err.message}`))
    }, this.intervalMs)
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
