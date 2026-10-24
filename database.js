const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB_NAME || 'telegram_live_stream_bot';
let client;
let database;

function collection(name) {
  if (!database) throw new Error('MongoDB ulanmagan. Avval database.connect() chaqiring.');
  return database.collection(name);
}

async function connect() {
  if (!uri) throw new Error('MONGODB_URI .env faylida sozlanishi kerak.');
  if (database) return database;
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
  });
  try {
    await client.connect();
    database = client.db(databaseName);
    await Promise.all([
      collection('users').createIndex({ telegram_id: 1 }, { unique: true }),
      collection('stream_templates').createIndex({ id: 1 }, { unique: true }),
      collection('required_channels').createIndex({ chat_id: 1 }, { unique: true }),
      collection('broadcasts').createIndex({ pid: 1 }, { unique: true }),
      collection('broadcasts').createIndex({ user_id: 1, started_at: -1 }),
    ]);
    return database;
  } catch (error) {
    database = undefined;
    await client.close();
    client = undefined;
    throw new Error(`MongoDB ga ulanib bo‘lmadi: ${error.message}`);
  }
}

async function saveUser(user) {
  await collection('users').updateOne(
    { telegram_id: user.id },
    {
      $set: { username: user.username || null, first_name: user.first_name || null },
      $setOnInsert: { created_at: new Date() },
    },
    { upsert: true },
  );
}

async function getUsers() {
  return collection('users').find({}, { projection: { _id: 0, telegram_id: 1 } })
    .map((user) => user.telegram_id)
    .toArray();
}

async function getStats() {
  const [users, broadcasts, templates] = await Promise.all([
    collection('users').countDocuments(),
    collection('broadcasts').countDocuments(),
    collection('stream_templates').countDocuments(),
  ]);
  return { users, broadcasts, templates };
}

async function getTemplates() {
  return collection('stream_templates').find({}, { projection: { _id: 0 } }).sort({ id: -1 }).toArray();
}

async function getTemplate(id) {
  return collection('stream_templates').findOne({ id: Number(id) }, { projection: { _id: 0 } });
}

async function nextId(counterName) {
  const counter = await collection('counters').findOneAndUpdate(
    { _id: counterName },
    { $inc: { sequence: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return counter.sequence;
}

async function addTemplate(name, sourceUrl) {
  const id = await nextId('stream_templates');
  await collection('stream_templates').insertOne({
    id,
    name,
    source_url: sourceUrl,
    created_at: new Date(),
  });
  return id;
}

async function updateTemplate(id, name, sourceUrl) {
  const result = await collection('stream_templates').updateOne(
    { id: Number(id) },
    { $set: { name, source_url: sourceUrl } },
  );
  return result.matchedCount > 0;
}

async function deleteTemplate(id) {
  const templateId = Number(id);
  if (await collection('broadcasts').findOne({ template_id: templateId }, { projection: { _id: 1 } })) {
    throw new Error('Faol efir ishlatayotgan shablonni o‘chirib bo‘lmaydi.');
  }
  return (await collection('stream_templates').deleteOne({ id: templateId })).deletedCount > 0;
}

async function getRequiredChannels() {
  return collection('required_channels').find({}, { projection: { _id: 0 } }).sort({ chat_id: 1 }).toArray();
}

async function addRequiredChannel(chatId, inviteLink) {
  await collection('required_channels').updateOne(
    { chat_id: chatId },
    { $set: { invite_link: inviteLink } },
    { upsert: true },
  );
}

async function deleteRequiredChannel(chatId) {
  return (await collection('required_channels').deleteOne({ chat_id: chatId })).deletedCount > 0;
}

async function addBroadcast(userId, templateId, pid) {
  const id = await nextId('broadcasts');
  await collection('broadcasts').insertOne({
    id,
    user_id: userId,
    template_id: Number(templateId),
    pid,
    started_at: new Date(),
  });
  return id;
}

async function getActiveBroadcasts(userId) {
  const broadcasts = await collection('broadcasts').find({ user_id: userId }).sort({ started_at: -1 }).toArray();
  if (!broadcasts.length) return [];
  const templateIds = [...new Set(broadcasts.map((broadcast) => broadcast.template_id))];
  const templates = await collection('stream_templates')
    .find({ id: { $in: templateIds } }, { projection: { _id: 0, id: 1, name: 1 } })
    .toArray();
  const names = new Map(templates.map((template) => [template.id, template.name]));
  return broadcasts.map(({ id, user_id, template_id, pid }) => ({
    id,
    user_id,
    template_id,
    pid,
    name: names.get(template_id) || 'O‘chirilgan shablon',
  }));
}

async function getBroadcast(id) {
  const broadcast = await collection('broadcasts').findOne({ id: Number(id) });
  if (!broadcast) return undefined;
  return { id: broadcast.id, user_id: broadcast.user_id, pid: broadcast.pid };
}

async function deleteBroadcast(id) {
  return (await collection('broadcasts').deleteOne({ id: Number(id) })).deletedCount > 0;
}

async function clearStaleBroadcasts() {
  const result = await collection('broadcasts').deleteMany({});
  return result.deletedCount;
}

async function close() {
  const activeClient = client;
  client = undefined;
  database = undefined;
  if (activeClient) await activeClient.close();
}

module.exports = {
  connect,
  saveUser,
  getUsers,
  getStats,
  getTemplates,
  getTemplate,
  addTemplate,
  updateTemplate,
  deleteTemplate,
  getRequiredChannels,
  addRequiredChannel,
  deleteRequiredChannel,
  addBroadcast,
  getActiveBroadcasts,
  getBroadcast,
  deleteBroadcast,
  clearStaleBroadcasts,
  close,
};
