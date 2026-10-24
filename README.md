# Telegram live-stream bot

Telegraf v4 bot for relaying administrator-configured stream sources to a user's own Telegram live stream. Use it only with source streams and Telegram destinations you are authorized to broadcast.

## Requirements

- Node.js 20 or newer
- MongoDB 6 or newer (local server or MongoDB Atlas)
- A Telegram bot token from BotFather
- FFmpeg installed and available in `PATH` (or set `FFMPEG_PATH`)
- `yt-dlp` installed and available in `PATH` to resolve YouTube URLs (or set `YTDLP_PATH`)
- The bot must be an administrator in every required-subscription channel so Telegram membership checks work reliably

## Setup

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`.
3. Set `BOT_TOKEN`, comma-separated numeric Telegram user IDs in `ADMIN_IDS`, and your `MONGODB_URI`.
4. Optionally set `MONGODB_DB_NAME`, `FFMPEG_PATH`, and `YTDLP_PATH`.
5. Start with `npm start`.

`npm test` runs the automated tests. `npm run check` performs JavaScript syntax checks.
`npm run migrate:sqlite` imports users, templates, and required channels from the previous `data/bot.sqlite` database; set `SQLITE_IMPORT_PATH` if it is elsewhere. The import is safe to re-run and does not overwrite existing MongoDB records. Take a backup before migrating. Active broadcasts are not imported because old process IDs cannot be resumed safely.

## User flow

Users select an administrator-created source template, then provide their Telegram RTMP Server URL and Stream Key. The stream key is held in memory only for launch and is not stored in MongoDB or printed in logs. Users can review and stop their own active broadcasts.

RTMP destinations and HTTP(S) sources must resolve to public IP addresses; private, loopback, link-local, and other non-public targets are rejected. YouTube source URLs are resolved by `yt-dlp` before FFmpeg starts. Install and update `yt-dlp` separately.

## Admin flow

The admin panel provides counts, stream-template add/edit/delete, announcements (text, photo, or video), and required-subscription channel management. For channel membership checks, configure a channel ID and an `https://t.me/...` join link. Make the bot an administrator in the channel.

## Process lifecycle and operations

Broadcast rows and PIDs are stored in MongoDB while their FFmpeg child process is running. FFmpeg exits remove their database rows. On `SIGINT` or `SIGTERM`, the bot signals all in-memory FFmpeg children before closing MongoDB; run the service under a process supervisor that sends these signals during deploys. On startup, leftover database rows from a prior unclean termination are removed, because a PID alone cannot safely identify a process after a restart (the OS may have reused it).

For production, use MongoDB Atlas or a secured MongoDB deployment, configure authentication and network restrictions, keep backups, monitor process/disk usage, and restrict access to `.env`. Run a single bot instance: active FFmpeg processes are managed in that process's memory, so multiple bot replicas need a separate shared process manager before they can safely share the database.
