const mineflayer = require('mineflayer')
require('dotenv').config()

const host = process.env.MC_HOST || 'localhost'
const port = parseInt(process.env.MC_PORT, 10) || 37269
const username = process.env.MC_USERNAME || 'lookAt_Bot'

const bot = mineflayer.createBot({
  host,
  port,
  username
})

function lookAtNearestPlayer () {
  const playerFilter = (entity) => entity.type === 'player'
  const playerEntity = bot.nearestEntity(playerFilter)
  
  if (!playerEntity) return
  
  const pos = playerEntity.position.offset(0, playerEntity.height, 0)
  bot.lookAt(pos)
}

bot.on('physicTick', lookAtNearestPlayer)