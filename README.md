> ⚠️ **Work in progress:** This project is actively being developed. Features may change and bugs may occur.

# Meet YTDL. A sleek and simple WebUI for yt-dlp

A self-hosted web server for downloading YouTube videos as MP4s. Query and download videos from any valid YouTube video or playlist URL in 480p, 720p, 1080p or best quality. Batch URLs are supported, as well as a customizable download queue and .zip archived bulk downloads.

## Quick Setup (Ubuntu/Debian)

```bash
chmod +x setup.sh
./setup.sh
```

---

## Manual Setup

### Install Dependencies

  ```bash
  sudo apt update
  sudo apt install npm pipx ffmpeg
  pipx install yt-dlp   # To upgrade: pipx upgrade yt-dlp
  pipx ensurepath   # restart your shell after this
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

---

## Notes

- Temp files are deleted from the server 10 minutes after download
- Files are cleaned up immediately after being served
- Age-restricted and private videos will not work

## Development

```bash
npm run dev   # auto-restarts on file changes (Node 18+)
```
