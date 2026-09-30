'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DOWNLOADS_DIR = path.join(ROOT, 'descargas');
const BIN_DIR = path.join(ROOT, 'bin');
const MAX_CONCURRENT = 2;
const MAX_URLS_PER_REQUEST = 20;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
};

const jobs = new Map();
const queue = [];
let running = 0;
let jobSeq = 0;

ensureDir(DOWNLOADS_DIR);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function runProbe(cmd, args) {
  try {
    const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    return res.status === 0 ? (res.stdout || '').trim() : null;
  } catch {
    return null;
  }
}

function findYtdlp() {
  const local = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (fs.existsSync(local)) return { cmd: local, prefix: [] };

  const onPath = runProbe(process.platform === 'win32' ? 'where' : 'which', ['yt-dlp']);
  if (onPath) return { cmd: onPath.split(/\r?\n/)[0].trim(), prefix: [] };

  const version = runProbe('python', ['-m', 'yt_dlp', '--version']);
  if (version) return { cmd: 'python', prefix: ['-m', 'yt_dlp'] };

  return null;
}

function findFfmpeg() {
  const local = path.join(BIN_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(local)) return local;
  const onPath = runProbe(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']);
  if (onPath) return onPath.split(/\r?\n/)[0].trim();
  return null;
}

function toolStatus() {
  const ytdlp = findYtdlp();
  const ffmpeg = findFfmpeg();
  return {
    ytdlp: Boolean(ytdlp),
    ytdlpPath: ytdlp ? ytdlp.cmd : null,
    ffmpeg: Boolean(ffmpeg),
    ffmpegPath: ffmpeg,
    downloadsDir: DOWNLOADS_DIR,
  };
}

function isYoutubeUrl(raw) {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return YOUTUBE_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function sanitizeName(name) {
  return name
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function buildOutputTemplate() {
  return path.join(DOWNLOADS_DIR, '%(title).120B [%(id)s].%(ext)s');
}

function startJob(url, options) {
  const id = ++jobSeq;
  const job = {
    id,
    url,
    quality: options.quality,
    playlist: options.playlist,
    status: 'queued',
    progress: 0,
    title: null,
    file: null,
    error: null,
    log: [],
    startedAt: null,
    finishedAt: null,
  };
  jobs.set(id, job);
  queue.push(job.id);
  pump();
  return job;
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (job) runJob(job);
  }
}

function runJob(job) {
  const ytdlp = findYtdlp();
  if (!ytdlp) {
    finishJob(job, 'error', 'yt-dlp no está instalado. Ejecuta install-tools.ps1');
    pump();
    return;
  }

  running += 1;
  job.status = 'running';
  job.startedAt = Date.now();
  job.log = ['Iniciando descarga...'];

  const args = [
    ...ytdlp.prefix,
    '--no-colors',
    '--newline',
    '--ignore-errors',
    '--no-warnings',
    '--no-playlist',
    '-x',
    '--audio-format',
    'mp3',
    '--audio-quality',
    job.quality,
    '--embed-metadata',
    '--retries',
    '5',
    '--fragment-retries',
    '5',
    '-o',
    buildOutputTemplate(),
  ];

  if (job.playlist) args.push('--yes-playlist');
  if (job.quality === 'best') args.push('--audio-quality', '0');

  const ffmpeg = findFfmpeg();
  if (ffmpeg) args.push('--ffmpeg-location', path.dirname(ffmpeg));
  else job.log.push('Aviso: no se encontro ffmpeg, puede que la conversion falle.');

  args.push(job.url);

  const child = spawn(ytdlp.cmd, args, { cwd: ROOT, windowsHide: true });
  job.pid = child.pid;
  let lastFile = null;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const onData = (chunk) => {
    for (const rawLine of chunk.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      const percent = line.match(/\[download\]\s+(\d{1,3}(?:\.\d)?)%/);
      if (percent) {
        job.progress = Math.max(job.progress, Math.min(99, Math.round(Number(percent[1]))));
      }

      const dest = line.match(/Destination:\s*(.+)$/);
      if (dest) {
        lastFile = dest[1].trim();
        job.title = path.basename(lastFile).replace(/\.[^.]+$/, '');
      }

      const info = line.match(/^\[info\]\s+(.+?)(?::\s|$)/);
      if (info && !job.title) job.title = info[1].trim();

      job.log.push(line);
      if (job.log.length > 60) job.log.shift();
    }
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', (err) => {
    finishJob(job, 'error', 'No se pudo ejecutar yt-dlp: ' + err.message);
    running -= 1;
    pump();
  });

  child.on('close', (code) => {
    running -= 1;
    delete job.pid;

    const produced = lastFile && fs.existsSync(lastFile);
    if (produced) {
      job.file = path.basename(lastFile);
      job.progress = 100;
      finishJob(job, 'done', 'Listo: ' + job.file);
    } else if (code === 0) {
      finishJob(job, 'error', 'yt-dlp termino sin generar archivo. Revisa el log.');
    } else {
      const errLine = job.log.filter((l) => /^ERROR/i.test(l)).pop();
      finishJob(job, 'error', errLine || 'yt-dlp termino con codigo ' + code);
    }
    pump();
  });
}

function finishJob(job, status, message) {
  job.status = status;
  job.finishedAt = Date.now();
  if (status === 'error') job.error = message;
  if (message) job.log.push(message);
}

function publicJob(job) {
  return {
    id: job.id,
    url: job.url,
    status: job.status,
    progress: job.progress,
    title: job.title,
    file: job.file,
    error: job.error,
    log: job.log,
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': MIME['.json'],
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        reject(new Error('Cuerpo demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('JSON invalido'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Prohibido');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': MIME['.html'] }).end('<h1>404</h1>');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

function listFiles() {
  let entries = [];
  try {
    entries = fs.readdirSync(DOWNLOADS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const stat = fs.statSync(path.join(DOWNLOADS_DIR, entry.name));
      return {
        name: entry.name,
        size: stat.size,
        modified: stat.mtimeMs,
        downloadUrl: '/api/download?name=' + encodeURIComponent(entry.name),
      };
    })
    .sort((a, b) => b.modified - a.modified);
}

function serveDownload(res, name) {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    res.writeHead(400).end('Nombre invalido');
    return;
  }
  const filePath = path.join(DOWNLOADS_DIR, name);
  if (!filePath.startsWith(DOWNLOADS_DIR) || !fs.existsSync(filePath)) {
    res.writeHead(404).end('Archivo no encontrado');
    return;
  }
  const stat = fs.statSync(filePath);
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const disposition = 'attachment; filename="' + name.replace(/"/g, '') + '"';

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Content-Disposition': disposition,
  });
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/status' && req.method === 'GET') {
    sendJson(res, 200, toolStatus());
    return true;
  }

  if (route === '/api/jobs' && req.method === 'GET') {
    sendJson(res, 200, {
      jobs: Array.from(jobs.values())
        .sort((a, b) => b.id - a.id)
        .map(publicJob),
      running,
      queued: queue.length,
    });
    return true;
  }

  if (route === '/api/convert' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return true;
    }

    const quality = ['128K', '192K', '256K', '320K', 'best'].includes(body.quality) ? body.quality : '192K';
    const playlist = Boolean(body.playlist);
    const rawUrls = Array.isArray(body.urls) ? body.urls : [];
    const seen = new Set();
    const accepted = [];
    const rejected = [];

    for (const raw of rawUrls.slice(0, MAX_URLS_PER_REQUEST)) {
      const value = String(raw || '').trim();
      if (!value) continue;
      if (!isYoutubeUrl(value)) {
        rejected.push(value);
        continue;
      }
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      accepted.push(startJob(value, { quality, playlist }));
    }

    sendJson(res, 200, { accepted: accepted.map((job) => job.id), rejected });
    return true;
  }

  if (route === '/api/files' && req.method === 'GET') {
    sendJson(res, 200, { files: listFiles() });
    return true;
  }

  if (route === '/api/download' && req.method === 'GET') {
    serveDownload(res, url.searchParams.get('name') || '');
    return true;
  }

  if (route === '/api/delete' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return true;
    }
    const name = String(body.name || '');
    if (name && !name.includes('/') && !name.includes('\\')) {
      const filePath = path.join(DOWNLOADS_DIR, name);
      if (filePath.startsWith(DOWNLOADS_DIR) && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        sendJson(res, 200, { deleted: name });
        return true;
      }
    }
    sendJson(res, 404, { error: 'Archivo no encontrado' });
    return true;
  }

  if (route === '/api/open-folder' && req.method === 'POST') {
    const opener =
      process.platform === 'win32'
        ? { cmd: 'explorer', args: [DOWNLOADS_DIR] }
        : process.platform === 'darwin'
          ? { cmd: 'open', args: [DOWNLOADS_DIR] }
          : { cmd: 'xdg-open', args: [DOWNLOADS_DIR] };
    spawn(opener.cmd, opener.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    sendJson(res, 200, { opened: DOWNLOADS_DIR });
    return true;
  }

  if (route.startsWith('/api/job/') && req.method === 'DELETE') {
    const id = Number(route.split('/').pop());
    const job = jobs.get(id);
    if (job && job.status !== 'running') {
      jobs.delete(id);
      sendJson(res, 200, { deleted: id });
      return true;
    }
    sendJson(res, 409, { error: 'Ese trabajo no se puede borrar todavia' });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) sendJson(res, 404, { error: 'Ruta no encontrada' });
      return;
    }
    serveStatic(res, url.pathname);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const status = toolStatus();
  console.log('Conversor YouTube -> MP3');
  console.log('Abre http://' + HOST + ':' + PORT);
  console.log('Descarga en: ' + DOWNLOADS_DIR);
  console.log('yt-dlp: ' + (status.ytdlp ? status.ytdlpPath : 'NO ENCONTRADO'));
  console.log('ffmpeg: ' + (status.ffmpeg ? status.ffmpegPath : 'NO ENCONTRADO'));
  if (!status.ytdlp) console.log('Ejecuta: powershell -ExecutionPolicy Bypass -File install-tools.ps1');
});
