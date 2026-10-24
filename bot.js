require('dotenv').config();

const { Telegraf, session, Scenes, Markup } = require('telegraf');
const db = require('./database');
const streamManager = require('./streamManager');
const scenes = require('./scenes');
const { mainMenu, templateKeyboard, activeKeyboard, adminKeyboard } = require('./keyboards');

const token = process.env.BOT_TOKEN;
if (!token) throw new Error('BOT_TOKEN .env faylida sozlanishi kerak.');

const adminIds = new Set(
  (process.env.ADMIN_IDS || '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0),
);
const bot = new Telegraf(token);
const stage = new Scenes.Stage(scenes);

function isAdmin(ctx) {
  return Boolean(ctx.from && adminIds.has(ctx.from.id));
}

async function checkMembership(ctx) {
  if (isAdmin(ctx)) return true;
  const channels = await db.getRequiredChannels();
  const missing = [];
  for (const channel of channels) {
    try {
      const member = await ctx.telegram.getChatMember(channel.chat_id, ctx.from.id);
      if (!['creator', 'administrator', 'member'].includes(member.status) &&
          !(member.status === 'restricted' && member.is_member)) {
        missing.push(channel);
      }
    } catch (error) {
      console.error(`Membership check failed for ${channel.chat_id}: ${error.message}`);
      missing.push(channel);
    }
  }
  if (missing.length) {
    const rows = missing.map((channel) => [Markup.button.url('Kanalga obuna bo‘lish', channel.invite_link)]);
    rows.push([Markup.button.callback('✅ Tekshirish', 'membership:check')]);
    await ctx.reply('Botdan foydalanish uchun quyidagi kanallarga obuna bo‘ling:', Markup.inlineKeyboard(rows));
    return false;
  }
  return true;
}

bot.use(session());
bot.use(async (ctx, next) => {
  if (ctx.from && ctx.chat && ctx.chat.type === 'private') {
    await db.saveUser(ctx.from);
    ctx.state.admin = isAdmin(ctx);
    ctx.state.streamManager = streamManager;
  }
  if (!ctx.chat || ctx.chat.type !== 'private' || !ctx.from) return next();
  if (ctx.callbackQuery && ctx.callbackQuery.data === 'membership:check') return next();
  if (!(await checkMembership(ctx))) return;
  return next();
});
bot.use(stage.middleware());

bot.start(async (ctx) => {
  await ctx.reply('Salom! Efir boshlash uchun tayyor stream shablonini tanlang.', mainMenu(isAdmin(ctx)));
});

bot.command('menu', async (ctx) => {
  await ctx.reply('Asosiy menyu:', mainMenu(isAdmin(ctx)));
});

bot.action('menu:home', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Asosiy menyu:', mainMenu(isAdmin(ctx))).catch((error) => {
    if (!/message is not modified/i.test(error.message)) throw error;
  });
});

bot.action('membership:check', async (ctx) => {
  await ctx.answerCbQuery();
  if (await checkMembership(ctx)) {
    await ctx.reply('Obuna tasdiqlandi. Davom etishingiz mumkin.', mainMenu(isAdmin(ctx)));
  } else {
    await ctx.reply('Obuna hali tasdiqlanmadi. Obuna bo‘lgach qayta tekshiring.');
  }
});

bot.action('streams:list', async (ctx) => {
  await ctx.answerCbQuery();
  const templates = await db.getTemplates();
  if (!templates.length) {
    await ctx.reply('Hozircha stream shablonlari yo‘q.');
    return;
  }
  await ctx.reply('Uzatmoqchi bo‘lgan streamni tanlang:', templateKeyboard(templates));
});

bot.action(/^stream:select:(\d+)$/, async (ctx) => {
  const template = await db.getTemplate(Number(ctx.match[1]));
  if (!template) {
    await ctx.answerCbQuery('Shablon topilmadi.', { show_alert: true });
    return;
  }
  await ctx.answerCbQuery();
  await ctx.scene.enter('stream-config', { templateId: template.id });
});

bot.action('broadcasts:list', async (ctx) => {
  await ctx.answerCbQuery();
  const broadcasts = await db.getActiveBroadcasts(ctx.from.id);
  if (!broadcasts.length) {
    await ctx.reply('Hozir faol efirlaringiz yo‘q.');
    return;
  }
  await ctx.reply('Faol efirlaringiz:', activeKeyboard(broadcasts));
});

bot.action(/^broadcast:stop:(\d+)$/, async (ctx) => {
  const stopped = await streamManager.stop(Number(ctx.match[1]), ctx.from.id);
  await ctx.answerCbQuery(stopped ? 'Efir to‘xtatilmoqda.' : 'Efir faol emas yoki topilmadi.');
  await ctx.reply(stopped ? 'To‘xtatish buyrug‘i yuborildi.' : 'Faol efir topilmadi.');
});

bot.action('admin:home', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Ruxsat yo‘q.', { show_alert: true });
  await ctx.answerCbQuery();
  await ctx.reply('Admin panel:', adminKeyboard());
});

bot.action('admin:stats', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Ruxsat yo‘q.', { show_alert: true });
  await ctx.answerCbQuery();
  const stats = await db.getStats();
  await ctx.reply(`📊 Statistika\nFoydalanuvchilar: ${stats.users}\nFaol efirlar: ${stats.broadcasts}\nShablonlar: ${stats.templates}`, adminKeyboard());
});

bot.action('admin:templates', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Ruxsat yo‘q.', { show_alert: true });
  await ctx.answerCbQuery();
  const templates = await db.getTemplates();
  const rows = templates.flatMap((template) => [[
    Markup.button.callback(`✏️ ${template.name}`, `admin:template:edit:${template.id}`),
    Markup.button.callback('🗑 O‘chirish', `admin:template:delete:${template.id}`),
  ]]);
  rows.push([Markup.button.callback('➕ Shablon qo‘shish', 'admin:template:add')]);
  rows.push([Markup.button.callback('⬅️ Admin panel', 'admin:home')]);
  await ctx.reply(templates.length ? 'Shablonni o‘chirish yoki yangi qo‘shish:' : 'Hozircha shablon yo‘q.', Markup.inlineKeyboard(rows));
});

bot.action('admin:template:add', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Ruxsat yo‘q.', { show_alert: true });
  await ctx.answerCbQuery();
  await ctx.scene.enter('add-template');
});

bot.action(/^admin:template:edit:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Ruxsat yo‘q.', { show_alert: true });
  await ctx.answerCbQuery();
  await ctx.scene.enter('update-template', { templateId: Number(ctx.match[1]) });
});

bot.action(/^admin:template:delete:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Ruxsat yo‘q.', { show_alert: true });
  try {
    const deleted = await db.deleteTemplate(Number(ctx.match[1]));
    await ctx.answerCbQuery(deleted ? 'Shablon o‘chirildi.' : 'Shablon topilmadi.');
  } catch (error) {
    console.error(`Template deletion failed: ${error.message}`);
    await ctx.answerCbQuery('Faol efir ishlatayotgan shablonni o‘chirib bo‘lmaydi.', { show_alert: true });
  }
});

bot.action('admin:channels', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Ruxsat yo‘q.', { show_alert: true });
  await ctx.answerCbQuery();
  const channels = await db.getRequiredChannels();
  const rows = channels.map((channel) => [
    Markup.button.callback(`🗑 ${channel.chat_id}`, `admin:channel:delete:${encodeURIComponent(channel.chat_id)}`),
  ]);
  rows.push([Markup.button.callback('➕ Kanal qo‘shish', 'admin:channel:add')]);
  rows.push([Markup.button.callback('⬅️ Admin panel', 'admin:home')]);
  await ctx.reply(channels.length ? 'Majburiy obuna kanallari:' : 'Majburiy obuna kanallari sozlanmagan.', Markup.inlineKeyboard(rows));
});

bot.action('admin:channel:add', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Ruxsat yo‘q.', { show_alert: true });
  await ctx.answerCbQuery();
  await ctx.scene.enter('add-channel');
});

bot.action(/^admin:channel:delete:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Ruxsat yo‘q.', { show_alert: true });
  const chatId = decodeURIComponent(ctx.match[1]);
  await db.deleteRequiredChannel(chatId);
  await ctx.answerCbQuery('Kanal o‘chirildi.');
});

bot.action('admin:broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Ruxsat yo‘q.', { show_alert: true });
  await ctx.answerCbQuery();
  await ctx.scene.enter('announcement');
});

bot.action('flow:cancel', async (ctx) => {
  await ctx.answerCbQuery('Bekor qilindi.');
  await ctx.scene.leave();
  await ctx.reply('Amal bekor qilindi.', mainMenu(isAdmin(ctx)));
});

bot.catch((error, ctx) => {
  console.error(`Unhandled bot error (${ctx.updateType}): ${error.message}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping active streams.`);
  await streamManager.stopAll();
  await bot.stop(signal);
  await db.close();
}

process.once('exit', streamManager.stopAll);
process.once('SIGINT', () => shutdown('SIGINT').catch((error) => {
  console.error(`Shutdown failed: ${error.message}`);
  process.exitCode = 1;
}));
process.once('SIGTERM', () => shutdown('SIGTERM').catch((error) => {
  console.error(`Shutdown failed: ${error.message}`);
  process.exitCode = 1;
}));

async function start() {
  await db.connect();
  const staleCount = await streamManager.clearStaleRecords();
  if (staleCount) console.warn(`Removed ${staleCount} stale broadcast record(s) from the previous run.`);
  await bot.launch();
  console.log('Telegram bot is running.');
}

start().catch(async (error) => {
  console.error(`Bot startup failed: ${error.message}`);
  await db.close().catch((closeError) => {
    console.error(`MongoDB close failed: ${closeError.message}`);
  });
  process.exitCode = 1;
});
