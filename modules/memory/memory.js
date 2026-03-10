const fs = require('fs').promises;
const path = require('path');
const { createLogger, requireEnv, parseIntRequired } = require('../log/logging');

const logger = createLogger('Memory');
const config = {};

try {
  config.dir = requireEnv('Memory', 'MEMORY_DIR');
  config.maxEntries = parseIntRequired('Memory', 'MEMORY_MAX_ENTRIES');
} catch (err) {
  logger.error(`Initialization failed: ${err.message}`);
  throw err;
}

fs.mkdir(config.dir, { recursive: true }).catch(err => {
  logger.error(`Failed to create memory directory "${config.dir}": ${err.message}`);
  process.exit(1);
});

function _filePath (skill) {
  return path.join(config.dir, `${skill}.jsonl`);
}

async function append (skill, entry) {
  const line = JSON.stringify({ ts: Date.now(), ...entry }) + '\n';
  await fs.appendFile(_filePath(skill), line, 'utf8');

  // trim to max entries
  const entries = await read(skill);
  if (entries.length > config.maxEntries) {
    const trimmed = entries.slice(-config.maxEntries);
    const data = trimmed.map(e => JSON.stringify(e)).join('\n') + '\n';
    await fs.writeFile(_filePath(skill), data, 'utf8');
  }
}

async function read (skill, n) {
  try {
    const txt = await fs.readFile(_filePath(skill), 'utf8');
    const lines = txt.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    return n ? lines.slice(-n) : lines;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function clear (skill) {
  try {
    await fs.unlink(_filePath(skill));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = { append, read, clear };
