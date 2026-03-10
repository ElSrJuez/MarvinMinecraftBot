const { Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');

function say (bot, chatEnabled, category) {
  if (chatEnabled && bot.dialogue) bot.dialogue.say(category);
}

async function goTo (bot, pos) {
  const movements = new Movements(bot);
  bot.pathfinder.setMovements(movements);
  await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 2));
}

module.exports = { say, goTo };
