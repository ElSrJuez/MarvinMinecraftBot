const path = require('path');

const SOURCE_ROOT = path.resolve(__dirname, '..');
const SERVICE_ROOT = path.resolve(SOURCE_ROOT, '..');

function resolveSourcePath (p) {
  return path.isAbsolute(p) ? p : path.resolve(SOURCE_ROOT, p);
}

function resolveServicePath (p) {
  return path.isAbsolute(p) ? p : path.resolve(SERVICE_ROOT, p);
}

module.exports = {
  SOURCE_ROOT,
  SERVICE_ROOT,
  resolveSourcePath,
  resolveServicePath,
};
