# YTDL — YouTube MP4 Downloader

A local web server that lets you paste a YouTube URL and download it as an MP4.

## Prerequisites

### 1. Node.js (v18+)
```bash
node --version
```

### 2. yt-dlp
```bash
# Linux/macOS
pip install yt-dlp
# or
brew install yt-dlp

# Windows
winget install yt-dlp
# or download yt-dlp.exe from https://github.com/yt-dlp/yt-dlp/releases
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

## Setup

```bash
# Install Node dependencies
npm install

# Start the server
npm start
```

Then open **http://localhost:3000** in your browser.

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
