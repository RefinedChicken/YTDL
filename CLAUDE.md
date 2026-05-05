# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # Install dependencies (see note below about archiver)
npm start          # Start server (requires port 80 — run as admin/sudo)
npm run dev        # Watch mode with --watch flag (Node 18+)
```

**Note:** `archiver` is imported in `server.js` but is not declared in `package.json`. Run `npm install archiver` and add it to dependencies if ZIP functionality is needed.

Port 80 requires elevated privileges. On Linux, use `sudo` or the systemd service created by `setup.sh`. On Windows, run as Administrator.

The `setup.sh` script automates installation on Ubuntu/Debian: installs npm, pipx, ffmpeg, and yt-dlp, and optionally creates a systemd service (`ytdl.service`).

## Architecture

Single-file Express backend (`server.js`, ~415 lines) + single-file frontend SPA (`public/index.html`, ~1100 lines). No framework beyond Express; no build step.

**Runtime dependencies beyond npm:**
- `yt-dlp` — must be installed and on PATH (used via `child_process.spawn`)
- `ffmpeg` — required by yt-dlp for format merging

### Backend (`server.js`)

Three download modes:
1. **Single video** — `POST /api/info` fetches metadata, `GET /api/download` streams the download
2. **Batch/playlist** — `POST /api/info/batch` expands URLs/playlists into a queue
3. **ZIP export** — `POST /api/zip` archives multiple completed downloads

Progress is pushed to the browser via **Server-Sent Events** on `GET /api/download`. Each download spawns a `yt-dlp` child process; job IDs are tracked in a `Map` so `DELETE /api/download/:jobId` can `kill()` the process.

After a file is ready, a **one-time token** (5-min TTL) is issued. `GET /api/file/:token` serves the file and invalidates the token. A periodic cleanup task deletes files older than 10 minutes from the downloads directory.

Quality options passed to yt-dlp: best, 1080p, 720p, 480p (mapped to yt-dlp format strings).

### Frontend (`public/index.html`)

Vanilla JS SPA. Two UI modes (single / batch) toggled by buttons. Uses the browser's `EventSource` API to consume the SSE stream and update a progress bar with speed/size stats. Batch mode renders a queue with checkboxes; checked items can be ZIP-exported.

Design tokens: dark background, lime accent `#e8ff47`, red error `#ff4747`. Fonts: Space Mono (monospace), Syne (sans-serif) via Google Fonts.

### API Routes

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/info` | Fetch single video metadata |
| `POST` | `/api/info/batch` | Expand URLs/playlists to batch queue |
| `GET` | `/api/download` | Stream download progress via SSE (`?url=&quality=`) |
| `DELETE` | `/api/download/:jobId` | Cancel in-progress download |
| `GET` | `/api/file/:token` | Serve file (one-time token) |
| `POST` | `/api/zip` | Create ZIP from array of tokens |
