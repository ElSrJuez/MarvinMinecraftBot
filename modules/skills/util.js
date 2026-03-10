const { Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');

function pick (arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function say (bot, chatEnabled, msg) {
  if (chatEnabled && bot) bot.chat(msg);
}

async function goTo (bot, pos) {
  const movements = new Movements(bot);
  bot.pathfinder.setMovements(movements);
  await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 2));
}

module.exports = { pick, say, goTo };
