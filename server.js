const express = require('express');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const archiver = require('archiver');

const app = express();
const PORT = 80;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function isValidYouTubeUrl(url) {
  return /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/|playlist\?)|youtu\.be\/)[\w\-?=&]+/.test(url);
}

function isPlaylistUrl(url) {
  return /youtube\.com\/playlist\?list=/.test(url) ||
         (/youtube\.com\/watch/.test(url) && /[?&]list=/.test(url));
}

function formatDuration(seconds) {
  if (!seconds) return 'Unknown';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function sanitizeFilename(name) {
  return name.replace(/[^\x20-\x7E]/g, '').replace(/[:"*?<>|\/\\]/g, '').trim();
}

// ── Single video info ─────────────────────────────────────────────────────────

app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  exec(`yt-dlp --dump-json --no-playlist "${url}"`, { timeout: 30000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'Could not fetch video info. Make sure the video is public.' });
    try {
      const info = JSON.parse(stdout);
      res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration_string || formatDuration(info.duration),
        uploader: info.uploader,
      });
    } catch {
      res.status(500).json({ error: 'Failed to parse video info' });
    }
  });
});

// ── Playlist / batch info ─────────────────────────────────────────────────────

app.post('/api/info/batch', (req, res) => {
  const { urls } = req.body; // array of URLs
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'No URLs provided' });
  }

  const invalid = urls.filter(u => !isValidYouTubeUrl(u));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Invalid URL(s): ${invalid.join(', ')}` });
  }

  // Fetch info for all URLs in parallel; each may expand into multiple entries (playlists)
  const tasks = urls.map(url => new Promise((resolve) => {
    // --flat-playlist dumps one JSON object per entry without downloading
    const flags = isPlaylistUrl(url)
      ? `--flat-playlist --dump-json "${url}"`
      : `--dump-json --no-playlist "${url}"`;

    exec(`yt-dlp ${flags}`, { timeout: 60000 }, (err, stdout) => {
      if (err) {
        resolve({ error: true, url });
        return;
      }
      // stdout may be multiple JSON objects (one per line) for playlists
      const entries = stdout.trim().split('\n').map(line => {
        try {
          const info = JSON.parse(line);
          return {
            url: info.webpage_url || info.url || `https://youtube.com/watch?v=${info.id}`,
            id: info.id,
            title: info.title || info.ie_key || 'Unknown',
            thumbnail: info.thumbnail || info.thumbnails?.[0]?.url || null,
            duration: info.duration_string || formatDuration(info.duration),
            uploader: info.uploader || info.channel || info.uploader_id || 'Unknown',
          };
        } catch {
          return null;
        }
      }).filter(Boolean);

      resolve({ error: false, entries });
    });
  }));

  Promise.all(tasks).then(results => {
    const videos = [];
    const errors = [];
    results.forEach((r, i) => {
      if (r.error) errors.push(urls[i]);
      else videos.push(...r.entries);
    });
    res.json({ videos, errors });
  });
});

// ── Download a single video (SSE) ─────────────────────────────────────────────

app.get('/api/download', (req, res) => {
  const { url, quality } = req.query;
  if (!url || !isValidYouTubeUrl(decodeURIComponent(url))) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  cleanupOldFiles();

  const decodedUrl = decodeURIComponent(url);
  const jobId = crypto.randomBytes(8).toString('hex');
  const outputTemplate = path.join(DOWNLOAD_DIR, `%(title)s - %(uploader)s.${jobId}.%(ext)s`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  let formatArg;
  if (quality === '1080p')     formatArg = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]';
  else if (quality === '720p') formatArg = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]';
  else if (quality === '480p') formatArg = 'bestvideo[height<=480]+bestaudio/best[height<=480]';
  else                         formatArg = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';

  const args = [
    '--no-playlist', '-f', formatArg,
    '--merge-output-format', 'mp4',
    '--newline', '-o', outputTemplate,
    decodedUrl,
  ];

  const ytdlp = spawn('yt-dlp', args);
  let finalFilename = null;

  app.locals.jobs = app.locals.jobs || {};
  app.locals.jobs[jobId] = ytdlp;
  send({ type: 'jobId', jobId });

  ytdlp.stdout.on('data', (data) => {
    data.toString().split('\n').forEach(line => {
      const progressMatch = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)/);
      if (progressMatch) send({ type: 'progress', percent: parseFloat(progressMatch[1]), size: progressMatch[2], speed: progressMatch[3] });

      const destMatch = line.match(/\[Merger\] Merging formats into "(.+)"/);
      if (destMatch) finalFilename = destMatch[1];

      const dlMatch = line.match(/\[download\] Destination: (.+\.mp4)/);
      if (dlMatch) finalFilename = dlMatch[1];

      const alreadyMatch = line.match(/\[download\] (.+) has already been downloaded/);
      if (alreadyMatch) finalFilename = alreadyMatch[1];
    });
  });

  ytdlp.stderr.on('data', (data) => console.error('yt-dlp stderr:', data.toString()));

  ytdlp.on('close', (code) => {
    delete (app.locals.jobs || {})[jobId];
    if (code !== 0) {
      send({ type: 'error', message: 'Download failed. The video may be unavailable or restricted.' });
      return res.end();
    }

    if (!finalFilename) {
      const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.includes(jobId));
      if (files.length > 0) finalFilename = path.join(DOWNLOAD_DIR, files[0]);
    }

    if (!finalFilename || !fs.existsSync(finalFilename)) {
      send({ type: 'error', message: 'Output file not found after download.' });
      return res.end();
    }

    const downloadToken = crypto.randomBytes(16).toString('hex');
    app.locals.tokens = app.locals.tokens || {};
    app.locals.tokens[downloadToken] = {
      path: finalFilename,
      name: path.basename(finalFilename).replace(`.${jobId}`, ''),
    };
    setTimeout(() => { delete app.locals.tokens[downloadToken]; }, 5 * 60 * 1000);

    send({ type: 'done', token: downloadToken });
    res.end();
  });

  req.on('close', () => ytdlp.kill());
});

// ── Cancel a download ─────────────────────────────────────────────────────────

app.delete('/api/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const jobs = app.locals.jobs || {};
  const job = jobs[jobId];

  if (!job) return res.status(404).json({ error: 'Job not found or already complete' });

  job.kill('SIGTERM');
  delete jobs[jobId];

  try {
    fs.readdirSync(DOWNLOAD_DIR)
      .filter(f => f.includes(jobId))
      .forEach(f => fs.unlinkSync(path.join(DOWNLOAD_DIR, f)));
  } catch (e) {
    console.warn('Cleanup after cancel failed:', e.message);
  }

  res.json({ success: true });
});

// ── Serve a single file via token ─────────────────────────────────────────────

app.get('/api/file/:token', (req, res) => {
  const tokens = app.locals.tokens || {};
  const tokenData = tokens[req.params.token];
  const filePath = tokenData?.path;

  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found or expired' });
  }

  const filename = sanitizeFilename(tokenData.name);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'video/mp4');
  res.sendFile(filePath, (err) => {
    if (!err) {
      setTimeout(() => {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        delete tokens[req.params.token];
      }, 5000);
    }
  });
});

// ── Zip and serve multiple files by token list ────────────────────────────────

app.post('/api/zip', (req, res) => {
  const { tokens: tokenList } = req.body;
  if (!Array.isArray(tokenList) || tokenList.length === 0) {
    return res.status(400).json({ error: 'No tokens provided' });
  }

  const tokenStore = app.locals.tokens || {};
  const files = tokenList
    .map(t => tokenStore[t])
    .filter(t => t && fs.existsSync(t.path));

  if (files.length === 0) {
    return res.status(404).json({ error: 'No valid files found for provided tokens' });
  }

  res.setHeader('Content-Disposition', 'attachment; filename="ytdl-batch.zip"');
  res.setHeader('Content-Type', 'application/zip');

  const archive = archiver('zip', { zlib: { level: 0 } }); // level 0 = store only (videos don't compress)
  archive.pipe(res);

  files.forEach(({ path: filePath, name }) => {
    archive.file(filePath, { name: sanitizeFilename(name) });
  });

  archive.finalize();

  archive.on('error', (err) => {
    console.error('Archiver error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to create zip' });
  });

  // Clean up files after zip is sent
  archive.on('finish', () => {
    setTimeout(() => {
      tokenList.forEach(t => {
        const td = tokenStore[t];
        if (td && fs.existsSync(td.path)) fs.unlinkSync(td.path);
        delete tokenStore[t];
      });
    }, 5000);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🎬 YouTube Downloader running at http://localhost:${PORT}\n`);
  exec('yt-dlp --version', (err, stdout) => {
    if (err) console.warn('⚠️  yt-dlp not found! Install it with pipx: pipx install yt-dlp');
    else console.log(`✅ yt-dlp version: ${stdout.trim()}`);
  });
  exec('ffmpeg -version', (err) => {
    if (err) console.warn('⚠️  ffmpeg not found! Install it for best quality merging.');
    else console.log('✅ ffmpeg detected');
  });
});
