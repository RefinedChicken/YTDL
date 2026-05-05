const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const crypto = require('crypto');
const os = require('os');
const archiver = require('archiver');

const app = express();

// When bundled via Tauri, these are injected as env vars from the Rust wrapper.
// Falls back to dev defaults so plain `node server.js` still works.
const PORT        = parseInt(process.env.YTDL_PORT         || '80',  10);
const YTDLP_BIN   = process.env.YTDLP_PATH                 || 'yt-dlp';
const FFMPEG_BIN  = process.env.FFMPEG_PATH                || 'ffmpeg';
const PUBLIC_DIR  = process.env.YTDL_PUBLIC_DIR            || path.join(__dirname, 'public');
const DOWNLOAD_DIR = process.env.YTDL_DOWNLOAD_DIR         || path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Initialize shared state once at startup
app.locals.jobs = {};
app.locals.tokens = {};

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ─── Helpers ────────────────────────────────────────────────────────────────

async function cleanupOldFiles() {
  try {
    const files = await fsp.readdir(DOWNLOAD_DIR);
    const now = Date.now();
    await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(DOWNLOAD_DIR, file);
        const stats = await fsp.stat(filePath);
        if (now - stats.mtimeMs > 10 * 60 * 1000) {
          await fsp.unlink(filePath).catch(() => {});
        }
      })
    );
  } catch (err) {
    console.warn('Cleanup error:', err.message);
  }
}

function isValidYouTubeUrl(url) {
  return /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=[\w-]{11}|shorts\/[\w-]{11}|playlist\?list=[\w-]+)|youtu\.be\/[\w-]{11})([?&].+)?$/.test(url);
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
  return name.replace(/[^\x20-\x7E]/g, '').replace(/[:"*?<>|\/\\]/g, '').trim() || 'download';
}

function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function zipTimestamp() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const suffix = crypto.randomBytes(2).toString('hex');
  return `ytdl-${date}_${suffix}.zip`;
}

async function cleanupFiles(filePaths) {
  await Promise.all(
    filePaths.map((p) => fsp.unlink(p).catch(() => {}))
  );
}

// ─── Format map ─────────────────────────────────────────────────────────────

const FORMAT_MAP = {
  '1080p': 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]',
  '720p':  'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]',
  '480p':  'bestvideo[height<=480]+bestaudio/best[height<=480]',
};
const DEFAULT_FORMAT = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';

// ─── Routes ─────────────────────────────────────────────────────────────────

// Single video info
app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  const ytdlp = spawn(YTDLP_BIN, ['--dump-json', '--no-playlist', url]);
  let stdout = '';
  let stderr = '';

  ytdlp.stdout.on('data', (d) => { stdout += d; });
  ytdlp.stderr.on('data', (d) => { stderr += d; });

  ytdlp.on('close', (code) => {
    if (code !== 0) {
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
    } catch {
      res.status(500).json({ error: 'Failed to parse video info' });
    }
  });

  setTimeout(() => ytdlp.kill(), 30000);
});

// Playlist / batch info
app.post('/api/info/batch', (req, res) => {
  const { urls } = req.body;
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'No URLs provided' });
  }

  const invalid = urls.filter((u) => !isValidYouTubeUrl(u));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Invalid URL(s): ${invalid.join(', ')}` });
  }

  const tasks = urls.map((url) => new Promise((resolve) => {
    const args = isPlaylistUrl(url)
      ? ['--flat-playlist', '--dump-json', url]
      : ['--dump-json', '--no-playlist', url];

    const ytdlp = spawn(YTDLP_BIN, args);
    let stdout = '';

    ytdlp.stdout.on('data', (d) => { stdout += d; });
    ytdlp.stderr.on('data', () => {});

    ytdlp.on('close', (code) => {
      if (code !== 0) {
        resolve({ error: true, url });
        return;
      }
      const entries = stdout.trim().split('\n').map((line) => {
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

    setTimeout(() => ytdlp.kill(), 60000);
  }));

  Promise.all(tasks).then((results) => {
    const videos = [];
    const errors = [];
    results.forEach((r, i) => {
      if (r.error) errors.push(urls[i]);
      else videos.push(...r.entries);
    });
    res.json({ videos, errors });
  });
});

// Download a single video (SSE)
app.get('/api/download', async (req, res) => {
  const { url, quality } = req.query;
  const decodedUrl = url ? decodeURIComponent(url) : '';

  if (!decodedUrl || !isValidYouTubeUrl(decodedUrl)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  await cleanupOldFiles();

  const jobId = crypto.randomBytes(8).toString('hex');
  const outputTemplate = path.join(DOWNLOAD_DIR, `%(title)s - %(uploader)s.${jobId}.%(ext)s`);
  const isAudio = quality === 'mp3';
  const formatArg = FORMAT_MAP[quality] || DEFAULT_FORMAT;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const args = isAudio
    ? ['--no-playlist', '--extract-audio', '--audio-format', 'mp3', '--ffmpeg-location', FFMPEG_BIN, '--newline', '-o', outputTemplate, decodedUrl]
    : ['--no-playlist', '-f', formatArg, '--merge-output-format', 'mp4', '--ffmpeg-location', FFMPEG_BIN, '--newline', '-o', outputTemplate, decodedUrl];

  const ytdlp = spawn(YTDLP_BIN, args);
  app.locals.jobs[jobId] = ytdlp;

  let finalFilename = null;
  let downloadComplete = false;

  const filenamePatterns = [
    { re: /\[download\] Destination: (.+)/, priority: 1 },
    { re: /\[download\] (.+) has already been downloaded/, priority: 1 },
    { re: /\[Merger\] Merging formats into "(.+)"/, priority: 2 },
    { re: /\[ExtractAudio\] Destination: (.+)/, priority: 2 },
  ];

  sseWrite(res, { type: 'jobId', jobId });

  ytdlp.stdout.on('data', (data) => {
    data.toString().split('\n').forEach((line) => {
      const progressMatch = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)/);
      if (progressMatch) {
        sseWrite(res, {
          type: 'progress',
          percent: parseFloat(progressMatch[1]),
          size: progressMatch[2],
          speed: progressMatch[3],
        });
        return;
      }

      let bestPriority = 0;
      for (const { re, priority } of filenamePatterns) {
        const m = line.match(re);
        if (m && priority >= bestPriority) {
          finalFilename = m[1].trim();
          bestPriority = priority;
        }
      }
    });
  });

  ytdlp.stderr.on('data', (d) => console.error('yt-dlp stderr:', d.toString()));

  ytdlp.on('close', async (code) => {
    delete app.locals.jobs[jobId];

    if (code !== 0) {
      sseWrite(res, { type: 'error', message: 'Download failed. The video may be unavailable or restricted.' });
      return res.end();
    }

    // Fallback: scan for file by jobId if pattern matching missed it
    if (!finalFilename || !fs.existsSync(finalFilename)) {
      const files = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.includes(jobId));
      if (files.length > 0) finalFilename = path.join(DOWNLOAD_DIR, files[0]);
    }

    if (!finalFilename || !fs.existsSync(finalFilename)) {
      sseWrite(res, { type: 'error', message: 'Output file not found after download.' });
      return res.end();
    }

    const downloadToken = crypto.randomBytes(16).toString('hex');
    app.locals.tokens[downloadToken] = {
      path: finalFilename,
      name: path.basename(finalFilename).replace(`.${jobId}`, ''),
      contentType: isAudio ? 'audio/mpeg' : 'video/mp4',
    };

    setTimeout(async () => {
      const td = app.locals.tokens[downloadToken];
      if (td) {
        await fsp.unlink(td.path).catch(() => {});
        delete app.locals.tokens[downloadToken];
      }
    }, 5 * 60 * 1000);

    downloadComplete = true;
    sseWrite(res, { type: 'done', token: downloadToken });
    res.end();
  });

  req.on('close', async () => {
    if (app.locals.jobs[jobId]) {
      ytdlp.kill();
      delete app.locals.jobs[jobId];
    }
    if (!downloadComplete) {
      const partials = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.includes(jobId));
      await cleanupFiles(partials.map((f) => path.join(DOWNLOAD_DIR, f)));
    }
  });
});

// Cancel a download
app.delete('/api/download/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = app.locals.jobs[jobId];

  if (!job) return res.status(404).json({ error: 'Job not found or already complete' });

  job.kill('SIGTERM');
  delete app.locals.jobs[jobId];

  const partials = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.includes(jobId));
  await cleanupFiles(partials.map((f) => path.join(DOWNLOAD_DIR, f)));

  res.json({ success: true });
});

// Serve a single file via token
app.get('/api/file/:token', (req, res) => {
  const tokenData = app.locals.tokens[req.params.token];

  if (!tokenData || !fs.existsSync(tokenData.path)) {
    return res.status(404).json({ error: 'File not found or expired' });
  }

  const filename = sanitizeFilename(tokenData.name);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', tokenData.contentType || 'video/mp4');

  res.sendFile(tokenData.path, async (err) => {
    if (!err) {
      setTimeout(async () => {
        await fsp.unlink(tokenData.path).catch(() => {});
        delete app.locals.tokens[req.params.token];
      }, 5000);
    }
  });
});

// Zip multiple files by token list, write to disk, return a download token
app.post('/api/zip', async (req, res) => {
  const { tokens: tokenList } = req.body;
  if (!Array.isArray(tokenList) || tokenList.length === 0) {
    return res.status(400).json({ error: 'No tokens provided' });
  }

  const tokenStore = app.locals.tokens;

  const files = tokenList
    .map((t) => {
      const td = tokenStore[t];
      if (td && fs.existsSync(td.path)) {
        delete tokenStore[t];
        return td;
      }
      return null;
    })
    .filter(Boolean);

  if (files.length === 0) {
    return res.status(404).json({ error: 'No valid files found for provided tokens' });
  }

  const zipName = zipTimestamp();
  const zipPath = path.join(DOWNLOAD_DIR, zipName);
  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 0 } });

  archive.on('error', (err) => {
    console.error('Archiver error:', err);
    fsp.unlink(zipPath).catch(() => {});
    if (!res.headersSent) res.status(500).json({ error: 'Failed to create zip' });
  });

  output.on('close', async () => {
    await cleanupFiles(files.map((f) => f.path));

    const zipToken = crypto.randomBytes(16).toString('hex');
    app.locals.tokens[zipToken] = {
      path: zipPath,
      name: zipName,
      contentType: 'application/zip',
    };

    setTimeout(async () => {
      const td = app.locals.tokens[zipToken];
      if (td) {
        await fsp.unlink(td.path).catch(() => {});
        delete app.locals.tokens[zipToken];
      }
    }, 5 * 60 * 1000);

    res.json({ token: zipToken });
  });

  archive.pipe(output);
  files.forEach(({ path: filePath, name }) => {
    archive.file(filePath, { name: sanitizeFilename(name) });
  });
  archive.finalize();
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🎬 YouTube Downloader running at http://localhost:${PORT}\n`);

  const versionCheck = spawn(YTDLP_BIN, ['--version']);
  let version = '';
  versionCheck.stdout.on('data', (d) => { version += d; });
  versionCheck.on('close', (code) => {
    if (code !== 0) console.warn('⚠️  yt-dlp not found! Install it: https://github.com/yt-dlp/yt-dlp#installation');
    else console.log(`✅ yt-dlp version: ${version.trim()}`);
  });

  const ffmpegCheck = spawn(FFMPEG_BIN, ['-version']);
  ffmpegCheck.on('close', (code) => {
    if (code !== 0) console.warn('⚠️  ffmpeg not found! Install it for best quality merging.');
    else console.log('✅ ffmpeg detected');
  });
});
