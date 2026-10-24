const { Markup } = require('telegraf');

function mainMenu(isAdmin) {
  const rows = [[Markup.button.callback('📺 Stream tanlash', 'streams:list')]];
  rows.push([Markup.button.callback('▶️ Faol efirlarim', 'broadcasts:list')]);
  if (isAdmin) rows.push([Markup.button.callback('⚙️ Admin panel', 'admin:home')]);
  return Markup.inlineKeyboard(rows);
}

function templateKeyboard(templates) {
  return Markup.inlineKeyboard([
    ...templates.map((template) => [
      Markup.button.callback(template.name, `stream:select:${template.id}`),
    ]),
    [Markup.button.callback('⬅️ Menyu', 'menu:home')],
  ]);
}

function activeKeyboard(broadcasts) {
  return Markup.inlineKeyboard([
    ...broadcasts.map((broadcast) => [
      Markup.button.callback(`⏹ ${broadcast.name} (PID ${broadcast.pid})`, `broadcast:stop:${broadcast.id}`),
    ]),
    [Markup.button.callback('🔄 Yangilash', 'broadcasts:list')],
    [Markup.button.callback('⬅️ Menyu', 'menu:home')],
  ]);
}

function adminKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Statistika', 'admin:stats')],
    [Markup.button.callback('🎞 Shablonlar', 'admin:templates')],
    [Markup.button.callback('📣 E’lon yuborish', 'admin:broadcast')],
    [Markup.button.callback('🔒 Obuna kanallari', 'admin:channels')],
    [Markup.button.callback('⬅️ Menyu', 'menu:home')],
  ]);
}

module.exports = { mainMenu, templateKeyboard, activeKeyboard, adminKeyboard };
