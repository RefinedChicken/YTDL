const express = require('express');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Clean up old files (older than 10 minutes)
function cleanupOldFiles() {
  const files = fs.readdirSync(DOWNLOAD_DIR);
  const now = Date.now();
  files.forEach(file => {
    const filePath = path.join(DOWNLOAD_DIR, file);
    const stats = fs.statSync(filePath);
    if (now - stats.mtimeMs > 10 * 60 * 1000) {
      fs.unlinkSync(filePath);
    }
  });
}

// Validate YouTube URL
function isValidYouTubeUrl(url) {
  const pattern = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[\w-]{11}/;
  return pattern.test(url);
}

// Get video info
app.post('/api/info', async (req, res) => {
  const { url } = req.body;

  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  exec(`yt-dlp --dump-json --no-playlist "${url}"`, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('yt-dlp info error:', stderr);
      return res.status(500).json({ error: 'Could not fetch video info. Make sure the video is public.' });
    }

    try {
      const info = JSON.parse(stdout);
      res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration_string || formatDuration(info.duration),
        uploader: info.uploader,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse video info' });
    }
  });
});

function formatDuration(seconds) {
  if (!seconds) return 'Unknown';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

// Download video with SSE progress
app.get('/api/download', (req, res) => {
  const { url, quality } = req.query;

  if (!url || !isValidYouTubeUrl(decodeURIComponent(url))) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  cleanupOldFiles();

  const decodedUrl = decodeURIComponent(url);
  const jobId = crypto.randomBytes(8).toString('hex');
  // const outputTemplate = path.join(DOWNLOAD_DIR, `${jobId}.%(uploader)s - %(title)s.%(ext)s`);
  const outputTemplate = path.join(DOWNLOAD_DIR, `%(title)s - %(uploader)s.${jobId}.%(ext)s`);
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // Format selection based on quality
  let formatArg;
  if (quality === '1080p') {
    formatArg = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]';
  } else if (quality === '720p') {
    formatArg = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]';
  } else if (quality === '480p') {
    formatArg = 'bestvideo[height<=480]+bestaudio/best[height<=480]';
  } else {
    formatArg = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
  }

  const args = [
    '--no-playlist',
    '-f', formatArg,
    '--merge-output-format', 'mp4',
    '--newline',
    '-o', outputTemplate,
    decodedUrl
  ];

  const ytdlp = spawn('yt-dlp', args);
  let finalFilename = null;

  ytdlp.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      // Parse progress
      const progressMatch = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)/);
      if (progressMatch) {
        send({
          type: 'progress',
          percent: parseFloat(progressMatch[1]),
          size: progressMatch[2],
          speed: progressMatch[3],
        });
      }

      // Detect merge/destination
      const destMatch = line.match(/\[Merger\] Merging formats into "(.+)"/);
      if (destMatch) finalFilename = destMatch[1];

      const dlMatch = line.match(/\[download\] Destination: (.+\.mp4)/);
      if (dlMatch) finalFilename = dlMatch[1];

      const alreadyMatch = line.match(/\[download\] (.+) has already been downloaded/);
      if (alreadyMatch) finalFilename = alreadyMatch[1];
    });
  });

  ytdlp.stderr.on('data', (data) => {
    console.error('yt-dlp stderr:', data.toString());
  });

  ytdlp.on('close', (code) => {
    if (code !== 0) {
      send({ type: 'error', message: 'Download failed. The video may be unavailable or restricted.' });
      return res.end();
    }

    // Find the output file
    if (!finalFilename) {
      const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(jobId));
      if (files.length > 0) {
        finalFilename = path.join(DOWNLOAD_DIR, files[0]);
      }
    }

    if (!finalFilename || !fs.existsSync(finalFilename)) {
      send({ type: 'error', message: 'Output file not found after download.' });
      return res.end();
    }

    const downloadToken = crypto.randomBytes(16).toString('hex');
    // Store token→file mapping in memory briefly
    app.locals.tokens = app.locals.tokens || {};
    app.locals.tokens[downloadToken] = {
      path: finalFilename,
      name: path.basename(finalFilename).replace(`.${jobId}`, '')
    };
    setTimeout(() => {
      delete app.locals.tokens[downloadToken];
    }, 5 * 60 * 1000);

    send({ type: 'done', token: downloadToken });
    res.end();
  });

  req.on('close', () => {
    ytdlp.kill();
  });
});

// Serve the file via token
app.get('/api/file/:token', (req, res) => {
  const { token } = req.params;
  const tokens = app.locals.tokens || {};
  const tokenData = tokens[token];
  const filePath = tokenData?.path;

  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found or expired' });
  }

  const filename = tokenData.name
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[:"*?<>|]/g, '')
    .trim();
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'video/mp4');
  res.sendFile(filePath, (err) => {
    if (!err) {
      // Clean up after serving
      setTimeout(() => {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        delete tokens[token];
      }, 5000);
    }
  });
});

app.listen(PORT, () => {
  console.log(`\n🎬 YouTube Downloader running at http://localhost:${PORT}\n`);
  // Check for yt-dlp
  exec('yt-dlp --version', (err, stdout) => {
    if (err) {
      console.warn('⚠️  yt-dlp not found! Install it: pip install yt-dlp');
    } else {
      console.log(`✅ yt-dlp version: ${stdout.trim()}`);
    }
  });
  // Check for ffmpeg
  exec('ffmpeg -version', (err) => {
    if (err) {
      console.warn('⚠️  ffmpeg not found! Install it for best quality merging.');
    } else {
      console.log('✅ ffmpeg detected');
    }
  });
});
