const { Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');

function say (bot, chatEnabled, category) {
  if (chatEnabled && bot.dialogue) bot.dialogue.say(category);
}

async function goTo (bot, pos) {
  const movements = new Movements(bot);
  bot.pathfinder.setMovements(movements);
  await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 2));
}

function playersNearby (bot, radius) {
  if (!bot.entity) return false;
  const mePos = bot.entity.position;
  const players = Object.keys(bot.players).filter(n => n !== bot.username);
  const r2 = radius * radius;
  for (const name of players) {
    const p = bot.players[name];
    if (!p.entity || !p.entity.position) continue;
    const pos = p.entity.position;
    const dx = pos.x - mePos.x;
    const dy = pos.y - mePos.y;
    const dz = pos.z - mePos.z;
    if (dx * dx + dy * dy + dz * dz <= r2) return true;
  }
  return false;
}

module.exports = { say, goTo, playersNearby };
