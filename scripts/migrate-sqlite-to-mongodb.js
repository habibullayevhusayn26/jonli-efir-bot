require('dotenv').config();

const path = require('node:path');
const Database = require('better-sqlite3');
const { MongoClient } = require('mongodb');

async function migrate() {
  const sqlitePath = path.resolve(
    process.env.SQLITE_IMPORT_PATH || process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'bot.sqlite'),
  );
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGODB_URI .env faylida sozlanishi kerak.');

  const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10_000 });
  try {
    await client.connect();
    const database = client.db(process.env.MONGODB_DB_NAME || 'telegram_live_stream_bot');
    const users = sqlite.prepare('SELECT telegram_id, username, first_name, created_at FROM users').all();
    const templates = sqlite.prepare('SELECT id, name, source_url, created_at FROM stream_templates').all();
    const channels = sqlite.prepare('SELECT chat_id, invite_link FROM required_channels').all();

    const userCollection = database.collection('users');
    const templateCollection = database.collection('stream_templates');
    const channelCollection = database.collection('required_channels');
    await Promise.all([
      userCollection.createIndex({ telegram_id: 1 }, { unique: true }),
      templateCollection.createIndex({ id: 1 }, { unique: true }),
      channelCollection.createIndex({ chat_id: 1 }, { unique: true }),
    ]);

    for (const user of users) {
      await userCollection.updateOne(
        { telegram_id: user.telegram_id },
        { $setOnInsert: { ...user, created_at: user.created_at ? new Date(user.created_at) : new Date() } },
        { upsert: true },
      );
    }
    for (const template of templates) {
      await templateCollection.updateOne(
        { id: template.id },
        { $setOnInsert: { ...template, created_at: template.created_at ? new Date(template.created_at) : new Date() } },
        { upsert: true },
      );
    }
    for (const channel of channels) {
      await channelCollection.updateOne(
        { chat_id: channel.chat_id },
        { $setOnInsert: channel },
        { upsert: true },
      );
    }

    const counters = database.collection('counters');
    const highestTemplateId = templates.reduce((max, template) => Math.max(max, template.id), 0);
    if (highestTemplateId > 0) {
      await counters.updateOne(
        { _id: 'stream_templates' },
        { $max: { sequence: highestTemplateId } },
        { upsert: true },
      );
    }

    console.log(`SQLite import complete: ${users.length} users, ${templates.length} stream templates, ${channels.length} required channels.`);
    console.log('Active broadcast records were intentionally not imported; old FFmpeg PIDs cannot be resumed safely.');
  } finally {
    sqlite.close();
    await client.close();
  }
}

migrate().catch((error) => {
  console.error(`SQLite import failed: ${error.message}`);
  process.exitCode = 1;
});
