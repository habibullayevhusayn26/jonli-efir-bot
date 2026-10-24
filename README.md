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

## Telegram Mini App stream preview

The stream menu includes a Preview button that opens a minimal, video-only Telegram Mini App. The server verifies Telegram `initData`, checks required-channel membership, starts a short-lived FFmpeg HLS preview, and serves only generated segments through a random, expiring session URL; template source URLs are not sent to the browser. Preview encoding is capped at 480x270, 15 FPS, 250 kbps video and 32 kbps mono audio, with one-second HLS segments. A preview lasts up to five minutes, and the default global preview limit is one process to protect small Render instances.

The included `Dockerfile` installs FFmpeg and yt-dlp. Deploy `render.yaml` as a Render Blueprint, set `BOT_TOKEN`, `ADMIN_IDS`, and `MONGODB_URI`, then configure the Render service's public hostname in BotFather (`/setdomain` for the bot's Mini App domain). Render provides `RENDER_EXTERNAL_URL`, which the bot uses for the Preview button and Telegram webhook. The local `WEB_APP_URL` setting can override it and must be the public HTTPS origin. Add Render's outbound IP addresses to the MongoDB Atlas Network Access list.

The Mini App is served at `/miniapp`; Render's `/health` endpoint is used for health checks. On Render, Telegram updates are delivered by a secret-protected webhook so incoming bot interactions can wake a sleeping free instance. Free Render services may still sleep when idle and have limited CPU/RAM. FFmpeg transcoding can be resource-intensive, so preview may be slow or fail under load; keep `MAX_PREVIEWS=1`, and use an always-on service with adequate CPU for reliable live operation. The preview process and temporary segments are local to one app instance and are removed on stop, timeout, or shutdown.

Live stream concurrency is independently limited by `MAX_STREAMS_PER_USER` (default 1) and `MAX_ACTIVE_STREAMS` (default 30). A user can run only one broadcast at a time; pending FFmpeg launches count toward both limits, so simultaneous button presses cannot overbook slots. The Render Blueprint deliberately defaults the global limit to 2 to reduce the risk of exhausting a small instance; raise it only after upgrading and load-testing. Thirty concurrent transcodes are not a realistic guarantee on Render Free: the outgoing bitrate alone is about 75 Mbps at 2.5 Mbps per stream, in addition to significant CPU, RAM, and incoming bandwidth. The current process manager is single-instance; do not scale to multiple Render instances without a distributed worker/lease design.

## User flow

Users select an administrator-created source template, then provide only their Telegram Stream Key. Use the separate Stream Key issued for each destination channel; a key must not be reused for multiple channel broadcasts. The fixed RTMP server URL is `rtmps://dc4-1.rtmp.t.me/s`; users never need to enter it. The stream key is held in memory only for launch and is not stored in MongoDB or printed in logs. Users can send `/cancel` at any point in the stream-key prompt to abandon setup. Video is transcoded to H.264 and audio to AAC for Telegram-compatible RTMP output. FFmpeg uses low-CPU ultrafast encoding, a one-second keyframe interval, and smaller input probe limits to reduce startup delay; these settings cannot eliminate delays caused by the source server, network, or Telegram ingest. YouTube URLs use yt-dlp's combined audio/video format. The bot reports startup only after FFmpeg reports output frames; this confirms FFmpeg is processing output, not that a user has confirmed the broadcast in Telegram. If Telegram shows a "Stream with other apps" dialog, confirm/start the broadcast there. Users can review and stop their own active broadcasts.

RTMP destinations and HTTP(S) sources must resolve to public IP addresses; private, loopback, link-local, and other non-public targets are rejected. YouTube source URLs are resolved by `yt-dlp` before FFmpeg starts. Install and update `yt-dlp` separately.

## Admin flow

The admin panel provides counts, stream-template add/edit/delete, announcements (text, photo, or video), and required-subscription channel management. For channel membership checks, configure a channel ID and an `https://t.me/...` join link. Make the bot an administrator in the channel.

## Process lifecycle and operations

Broadcast rows and PIDs are stored in MongoDB while their FFmpeg child process is running. FFmpeg exits remove their database rows. On `SIGINT` or `SIGTERM`, the bot signals all in-memory FFmpeg children before closing MongoDB; run the service under a process supervisor that sends these signals during deploys. On startup, leftover database rows from a prior unclean termination are removed, because a PID alone cannot safely identify a process after a restart (the OS may have reused it).

For production, use MongoDB Atlas or a secured MongoDB deployment, configure authentication and network restrictions, keep backups, monitor process/disk usage, and restrict access to `.env`. Run a single bot instance: active FFmpeg processes are managed in that process's memory, so multiple bot replicas need a separate shared process manager before they can safely share the database.
