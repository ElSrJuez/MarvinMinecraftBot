const fs = require('fs').promises;
const path = require('path');

require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

// #region Logger Configuration
const LOG_DIR = process.env.LOG_DIR;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

if (!LOG_DIR) {
  console.error('FATAL: LOG_DIR is not defined in .env. Logging to file will be disabled.');
}

const levels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLogLevel = levels[LOG_LEVEL] ?? levels.info;
// #endregion

// #region Logger Implementation
async function log(level, moduleName, msg) {
  if (levels[level] < currentLogLevel) return;

  const ts = new Date().toISOString();
  const line = `[${ts}] [${moduleName}] [${level}] ${msg}`;

  // Always log to console
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }

  // Log to file if LOG_DIR is set
  if (LOG_DIR) {
    try {
      await fs.mkdir(LOG_DIR, { recursive: true });
      const logFile = path.join(LOG_DIR, `${moduleName}.log`);
      await fs.appendFile(logFile, line + '\n', 'utf8');
    } catch (err) {
      console.error(`[${ts}] [Logger] [error] Failed to write to log file: ${err.message}`);
    }
  }
}

function createLogger(moduleName) {
  return {
    debug: (msg) => log('debug', moduleName, msg),
    info: (msg) => log('info', moduleName, msg),
    warn: (msg) => log('warn', moduleName, msg),
    error: (msg) => log('error', moduleName, msg),
  };
}
// #endregion

// #region Configuration Validation Helpers
function requireEnv(moduleName, varName) {
  const value = process.env[varName];
  if (!value) {
    const message = `${moduleName}: Missing required environment variable ${varName}`;
    log('error', 'Config', message);
    throw new Error(message);
  }
  return value;
}

function parseIntRequired(moduleName, varName) {
  const value = requireEnv(moduleName, varName);
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) {
    const message = `${moduleName}: Invalid integer for ${varName}`;
    log('error', 'Config', message);
    throw new Error(message);
  }
  return n;
}

function parseFloatRequired(moduleName, varName) {
  const value = requireEnv(moduleName, varName);
  const n = parseFloat(value);
  if (Number.isNaN(n)) {
    const message = `${moduleName}: Invalid float for ${varName}`;
    log('error', 'Config', message);
    throw new Error(message);
  }
  return n;
}
// #endregion

module.exports = {
  createLogger,
  requireEnv,
  parseIntRequired,
  parseFloatRequired,
};
