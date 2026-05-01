# YTDL — YouTube MP4 Downloader

A self-hosted web server for downloading YouTube videos as MP4s. Supports single videos, playlists, and batch URLs with a queue UI and ZIP export.

## Quick Setup (Ubuntu/Debian)

```bash
chmod +x setup.sh
./setup.sh
```

Installs dependencies, runs `npm install`, and optionally creates a systemd service. Then open **http://localhost:3000**.

---

## Manual Setup

### Requirements

- **Node.js v18+**
- **yt-dlp** — install via pipx, not apt

  > `apt install python3-yt-dlp` ships a stale version that breaks with HTTP 400/403 errors. Always use pipx or pip to get a current build.

  ```bash
  sudo apt install pipx
  pipx install yt-dlp
  pipx ensurepath   # restart your shell after this
  ```

  To upgrade later: `pipx upgrade yt-dlp`

- **ffmpeg** — required for merging video and audio streams

  ```bash
  sudo apt install ffmpeg        # Ubuntu/Debian
  brew install ffmpeg            # macOS
  winget install ffmpeg          # Windows
  ```

### Install and run

```bash
npm install
npm start
```

---

## Usage

**Single mode** — paste one URL, preview the video, pick a quality, download.

**Batch mode** — paste multiple URLs (one per line) or a playlist link. Videos are fetched into a queue with checkboxes. Download individual files or select multiple and export as a ZIP.

Quality options: Best / 1080p / 720p / 480p

---

## Notes

- Temp files are deleted from the server 10 minutes after download
- Files are cleaned up immediately after being served
- Age-restricted and private videos will not work

## Development

```bash
npm run dev   # auto-restarts on file changes (Node 18+)
```
