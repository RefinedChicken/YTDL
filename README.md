# YTDL — YouTube MP4 Downloader

A local web server that lets you paste a YouTube URL and download it as an MP4.

## Quick Setup (Ubuntu/Debian)

A setup script is included that handles everything automatically:

```bash
chmod +x setup.sh
./setup.sh
```

This will install all dependencies, run `npm install`, and optionally set up a systemd service so YTDL starts on boot. If you're on Ubuntu/Debian, this is the recommended way to get started.

---

## Manual Setup

If you're not on a Debian-based system or prefer to install things yourself:

### 1. Node.js (v18+)
```bash
node --version
```

### 2. yt-dlp

> **⚠️ Do not use `apt install python3-yt-dlp` on Ubuntu.** Canonical's package repos
> lag far behind upstream — you'll likely get a version from 2024 or earlier, which
> will fail with HTTP 400/403 errors due to outdated YouTube player extraction logic.
> Always install yt-dlp via pipx or pip to get a current version.

```bash
# Recommended: pipx (manages its own isolated environment, no venv needed)
sudo apt install pipx
pipx install yt-dlp
pipx ensurepath  # adds ~/.local/bin to PATH — restart your shell after this

# Alternative: pip
pip install yt-dlp  # may require --break-system-packages on Ubuntu 24.04+

# macOS
brew install yt-dlp

# Windows
winget install yt-dlp
# or download yt-dlp.exe from https://github.com/yt-dlp/yt-dlp/releases
```

> **Note on `pipx ensurepath`:** This adds `~/.local/bin` to your shell's PATH so the
> `yt-dlp` command is found. It takes effect on your next login or after running
> `source ~/.bashrc`. The setup script handles this automatically.

Keep yt-dlp up to date — YouTube regularly changes their player and old versions break:
```bash
pipx upgrade yt-dlp
```

### 3. ffmpeg (required for merging video+audio for best quality)
```bash
# Ubuntu/Debian
sudo apt install ffmpeg

# macOS
brew install ffmpeg

# Windows
winget install ffmpeg
# or download from https://ffmpeg.org/download.html
```

### 4. Install Node dependencies and start

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

---

## Usage

1. Paste a YouTube URL into the input field
2. Click **Fetch** to preview the video
3. Select your desired quality (Best / 1080p / 720p / 480p)
4. Click **Download MP4**
5. Watch the progress bar — your browser will prompt you to save the file when done

## Notes

- Downloaded files are auto-deleted from the server after 10 minutes
- Files are served once, then cleaned up immediately after transfer
- Works with standard YouTube videos and Shorts
- Age-restricted or private videos will not work

## Development

```bash
# Auto-restart on file changes (Node 18+)
npm run dev
```
