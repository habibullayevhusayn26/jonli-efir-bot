const { Scenes, Markup } = require('telegraf');
const db = require('../database');
const { validateRtmpServer, validateStreamKey, validateSourceUrl } = require('../streamManager');
const { mainMenu } = require('../keyboards');

function isAdmin(ctx) {
  return ctx.state.admin === true;
}

const streamConfigScene = new Scenes.WizardScene(
  'stream-config',
  async (ctx) => {
    if (!ctx.from || !ctx.wizard.state.templateId) {
      await ctx.reply('Shablon tanlanmadi. Menyudan qayta tanlang.');
      return ctx.scene.leave();
    }
    await ctx.reply(
      'Telegram kanalingiz yoki guruhingiz sozlamalaridan olingan RTMP Server URL manzilini yuboring.\n' +
      'Masalan: rtmps://dc4-1.rtmp.t.me/live',
      Markup.inlineKeyboard([[Markup.button.callback('Bekor qilish', 'flow:cancel')]]),
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || typeof ctx.message.text !== 'string') {
      await ctx.reply('RTMP Server URL manzilini matn ko‘rinishida yuboring.');
      return;
    }
    try {
      ctx.wizard.state.serverUrl = await validateRtmpServer(ctx.message.text.trim());
    } catch (error) {
      await ctx.reply(`${error.message}\nIltimos, to‘g‘ri RTMP Server URL yuboring.`);
      return;
    }
    await ctx.reply('Endi Telegram bergan Stream Key’ni yuboring. Bu kalit maxfiy saqlanadi va xabarlarda ko‘rsatilmaydi.');
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || typeof ctx.message.text !== 'string') {
      await ctx.reply('Stream Key’ni matn ko‘rinishida yuboring.');
      return;
    }
    let streamKey;
    try {
      streamKey = validateStreamKey(ctx.message.text.trim());
    } catch (error) {
      await ctx.reply(`${error.message}\nIltimos, kalitni tekshirib qayta yuboring.`);
      return;
    }

    const template = await db.getTemplate(Number(ctx.wizard.state.templateId));
    if (!template) {
      await ctx.reply('Bu stream shabloni endi mavjud emas. Menyudan boshqasini tanlang.');
      return ctx.scene.leave();
    }

    await ctx.reply('Ulanish tekshirilmoqda va efir ishga tushirilmoqda…');
    try {
      const broadcast = await ctx.state.streamManager.start({
        userId: ctx.from.id,
        template,
        serverUrl: ctx.wizard.state.serverUrl,
        streamKey,
        onExit: async (result) => {
          await ctx.telegram.sendMessage(
            ctx.from.id,
            result.clean
              ? `Efir tugadi: ${template.name}.`
              : `Efir kutilmaganda to‘xtadi: ${template.name}. Oqim manbasi yoki RTMP sozlamalarini tekshiring.`,
          );
        },
      });
      await ctx.reply(
        `Efir ishga tushdi: ${template.name}\nPID: ${broadcast.pid}`,
        Markup.inlineKeyboard([[
          Markup.button.callback('⏹ Efirni to‘xtatish', `broadcast:stop:${broadcast.id}`),
        ]]),
      );
    } catch (error) {
      console.error(`Stream launch failed for user ${ctx.from.id}: ${error.message}`);
      await ctx.reply(`Efirni ishga tushirib bo‘lmadi: ${error.message}`);
    }
    return ctx.scene.leave();
  },
);

const addTemplateScene = new Scenes.WizardScene(
  'add-template',
  async (ctx) => {
    await ctx.reply('Yangi stream uchun nom yuboring (1–80 belgi).', Markup.inlineKeyboard([
      [Markup.button.callback('Bekor qilish', 'flow:cancel')],
    ]));
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!isAdmin(ctx)) return ctx.scene.leave();
    if (!ctx.message || typeof ctx.message.text !== 'string') {
      await ctx.reply('Nomni matn ko‘rinishida yuboring.');
      return;
    }
    const name = ctx.message.text.trim();
    if (name.length < 1 || name.length > 80) {
      await ctx.reply('Nom 1–80 belgi bo‘lishi kerak.');
      return;
    }
    ctx.wizard.state.name = name;
    await ctx.reply('Ommaga uzatishga ruxsatingiz bor bo‘lgan manba URL’ni yuboring (HTTP(S), HLS yoki YouTube).');
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!isAdmin(ctx)) return ctx.scene.leave();
    if (!ctx.message || typeof ctx.message.text !== 'string') {
      await ctx.reply('Manba URL’ni matn ko‘rinishida yuboring.');
      return;
    }
    try {
      const sourceUrl = await validateSourceUrl(ctx.message.text.trim());
      const id = await db.addTemplate(ctx.wizard.state.name, sourceUrl);
      await ctx.reply(`Stream shabloni #${id} qo‘shildi.`, mainMenu(true));
    } catch (error) {
      await ctx.reply(`Shablon qo‘shilmadi: ${error.message}`);
      return;
    }
    return ctx.scene.leave();
  },
);

const updateTemplateScene = new Scenes.WizardScene(
  'update-template',
  async (ctx) => {
    const template = await db.getTemplate(Number(ctx.wizard.state.templateId));
    if (!template) {
      await ctx.reply('Shablon topilmadi.');
      return ctx.scene.leave();
    }
    ctx.wizard.state.name = template.name;
    await ctx.reply(`Yangi nom yuboring (1–80 belgi).\nHozirgi nom: ${template.name}`);
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!isAdmin(ctx)) return ctx.scene.leave();
    if (!ctx.message || typeof ctx.message.text !== 'string') {
      await ctx.reply('Nomni matn ko‘rinishida yuboring.');
      return;
    }
    const name = ctx.message.text.trim();
    if (name.length < 1 || name.length > 80) {
      await ctx.reply('Nom 1–80 belgi bo‘lishi kerak.');
      return;
    }
    ctx.wizard.state.name = name;
    await ctx.reply('Yangi manba URL’ni yuboring (HTTP(S), HLS yoki YouTube).');
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!isAdmin(ctx)) return ctx.scene.leave();
    if (!ctx.message || typeof ctx.message.text !== 'string') {
      await ctx.reply('Manba URL’ni matn ko‘rinishida yuboring.');
      return;
    }
    try {
      const sourceUrl = await validateSourceUrl(ctx.message.text.trim());
      const updated = await db.updateTemplate(
        Number(ctx.wizard.state.templateId),
        ctx.wizard.state.name,
        sourceUrl,
      );
      await ctx.reply(updated ? 'Stream shabloni yangilandi.' : 'Shablon topilmadi.', mainMenu(true));
    } catch (error) {
      await ctx.reply(`Shablon yangilanmadi: ${error.message}`);
      return;
    }
    return ctx.scene.leave();
  },
);

const addChannelScene = new Scenes.WizardScene(
  'add-channel',
  async (ctx) => {
    await ctx.reply('Majburiy obuna kanali ID’sini yuboring (masalan, @kanal yoki -100…).');
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!isAdmin(ctx)) return ctx.scene.leave();
    if (!ctx.message || typeof ctx.message.text !== 'string') {
      await ctx.reply('Kanal ID’sini matn ko‘rinishida yuboring.');
      return;
    }
    const chatId = ctx.message.text.trim();
    if (!/^@[A-Za-z0-9_]{5,32}$/.test(chatId) && !/^-100\d{6,}$/.test(chatId)) {
      await ctx.reply('Kanal ID noto‘g‘ri. @username yoki -100… formatidan foydalaning.');
      return;
    }
    ctx.wizard.state.chatId = chatId;
    await ctx.reply('Obuna bo‘lish uchun ochiq t.me havolasini yuboring (https://t.me/…).');
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!isAdmin(ctx)) return ctx.scene.leave();
    if (!ctx.message || typeof ctx.message.text !== 'string') {
      await ctx.reply('Havolani matn ko‘rinishida yuboring.');
      return;
    }
    let link;
    try {
      const parsed = new URL(ctx.message.text.trim());
      if (parsed.protocol !== 'https:' || parsed.hostname !== 't.me' || parsed.username || parsed.password) {
        throw new Error('Faqat https://t.me/... havolasi qabul qilinadi.');
      }
      link = parsed.toString();
      await db.addRequiredChannel(ctx.wizard.state.chatId, link);
    } catch (error) {
      await ctx.reply(`Kanal qo‘shilmadi: ${error.message}`);
      return;
    }
    await ctx.reply('Majburiy obuna kanali qo‘shildi.', mainMenu(true));
    return ctx.scene.leave();
  },
);

const announcementScene = new Scenes.WizardScene(
  'announcement',
  async (ctx) => {
    await ctx.reply('Barcha foydalanuvchilarga yuboriladigan e’lonni yuboring (matn, rasm yoki video).');
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!isAdmin(ctx)) return ctx.scene.leave();
    if (!ctx.message || (!ctx.message.text && !ctx.message.photo && !ctx.message.video)) {
      await ctx.reply('Faqat matn, rasm yoki video yuborish mumkin.');
      return;
    }
    const users = await db.getUsers();
    let sent = 0;
    let failed = 0;
    for (const userId of users) {
      try {
        await ctx.telegram.copyMessage(userId, ctx.chat.id, ctx.message.message_id);
        sent += 1;
      } catch (error) {
        failed += 1;
        console.warn(`Announcement delivery failed for user ${userId}: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await ctx.reply(`E’lon yakunlandi. Yuborildi: ${sent}, yetkazilmadi: ${failed}.`, mainMenu(true));
    return ctx.scene.leave();
  },
);

module.exports = [streamConfigScene, addTemplateScene, updateTemplateScene, addChannelScene, announcementScene];
