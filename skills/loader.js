const fs = require('fs');
const path = require('path');
const { createLogger } = require('../log/logging');

const logger = createLogger('SkillLoader');

function loadSkills (dir) {
  const skills = [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'loader.js');
  for (const file of files) {
    try {
      const skill = require(path.join(dir, file));
      if (!skill.name || !skill.start || !skill.stop) {
        logger.warn(`Skipping ${file}: must export { name, start, stop }`);
        continue;
      }
      skills.push(skill);
      logger.info(`Loaded skill: ${skill.name}`);
    } catch (err) {
      logger.error(`Failed to load skill ${file}: ${err.message}`);
    }
  }
  return skills;
}

async function startAll (skills, bot, memory) {
  for (const skill of skills) {
    try {
      await skill.start(bot, memory);
      logger.info(`Started skill: ${skill.name}`);
    } catch (err) {
      logger.error(`Failed to start skill ${skill.name}: ${err.message}`);
    }
  }
}

function stopAll (skills) {
  for (const skill of skills) {
    try {
      skill.stop();
      logger.info(`Stopped skill: ${skill.name}`);
    } catch (err) {
      logger.error(`Failed to stop skill ${skill.name}: ${err.message}`);
    }
  }
}

module.exports = { loadSkills, startAll, stopAll };
