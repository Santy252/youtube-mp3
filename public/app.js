'use strict';

const el = {
  urls: document.getElementById('urls'),
  count: document.getElementById('count'),
  convert: document.getElementById('convert'),
  quality: document.getElementById('quality'),
  playlist: document.getElementById('playlist'),
  jobs: document.getElementById('jobs'),
  files: document.getElementById('files'),
  filesHint: document.getElementById('files-hint'),
  banner: document.getElementById('banner'),
  status: document.getElementById('status'),
  paste: document.getElementById('paste'),
  clear: document.getElementById('clear'),
  refresh: document.getElementById('refresh'),
  openFolder: document.getElementById('open-folder'),
};

const state = { lastFilesKey: '' };

function parseUrls(text) {
  return Array.from(
    new Set(
      text
        .split(/[\s,]+/)
        .map((value) => value.trim())
        .filter((value) => /^https?:\/\//i.test(value))
    )
  );
}

function updateCount() {
  el.count.textContent = parseUrls(el.urls.value).length + (parseUrls(el.urls.value).length === 1 ? ' enlace' : ' enlaces');
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1) + ' ' + units[index];
}

function formatTime(ms) {
  return new Date(ms).toLocaleString('es', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
  return data;
}

function renderBanner(status) {
  const missing = [];
  if (!status.ytdlp) missing.push('yt-dlp');
  if (!status.ffmpeg) missing.push('ffmpeg');

  if (missing.length === 0) {
    el.banner.classList.add('hidden');
    el.status.textContent = 'Listo. Los MP3 se guardan en ' + status.downloadsDir;
    return;
  }

  el.banner.classList.remove('hidden');
  el.banner.innerHTML =
    'Falta instalar: <strong>' +
    missing.join(' y ') +
    '</strong>. Abre PowerShell en esta carpeta y ejecuta <code>powershell -ExecutionPolicy Bypass -File install-tools.ps1</code>, luego reinicia el servidor.';
  el.status.textContent = 'Herramientas incompletas: ' + missing.join(', ');
}

function renderJobs(data) {
  if (data.jobs.length === 0) {
    el.jobs.innerHTML = '<p class="empty">Todavia no hay descargas.</p>';
    return;
  }

  el.jobs.innerHTML = data.jobs
    .map((job) => {
      const label = job.title || job.url;
      let state = 'En cola';
      if (job.status === 'running') state = job.progress + '%';
      if (job.status === 'done') state = 'Listo';
      if (job.status === 'error') state = 'Error';

      const message =
        job.status === 'error'
          ? job.error
          : job.status === 'done'
            ? job.file
            : job.log.length > 1
              ? job.log[job.log.length - 1]
              : 'Procesando...';

      const download =
        job.status === 'done'
          ? '<a class="btn ghost small" href="/api/download?name=' + encodeURIComponent(job.file) + '">Guardar</a>'
          : '';

      return (
        '<div class="job ' +
        job.status +
        '">' +
        '<div class="job-top"><div class="job-title">' +
        escapeHtml(label) +
        '</div><div class="job-state">' +
        state +
        '</div></div>' +
        '<div class="bar"><div style="width:' +
        (job.status === 'done' ? 100 : job.progress) +
        '%"></div></div>' +
        '<div class="job-msg">' +
        escapeHtml(String(message || '')) +
        '</div>' +
        '<div class="row">' +
        download +
        '<button class="btn ghost small" data-clear-job="' +
        job.id +
        '" data-status="' +
        job.status +
        '">Quitar</button>' +
        '</div>' +
        '</div>'
      );
    })
    .join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

function renderFiles(data) {
  if (data.files.length === 0) {
    el.files.innerHTML = '<p class="empty">Carpeta vacia.</p>';
    el.filesHint.textContent = '';
    state.lastFilesKey = '';
    return;
  }

  el.files.innerHTML = data.files
    .map(
      (file) =>
        '<div class="file">' +
        '<div class="file-name" title="' +
        escapeHtml(file.name) +
        '">' +
        escapeHtml(file.name) +
        '</div>' +
        '<div class="file-size">' +
        formatSize(file.size) +
        ' · ' +
        formatTime(file.modified) +
        '</div>' +
        '<a class="btn ghost small" href="' +
        file.downloadUrl +
        '">Guardar</a>' +
        '<button class="btn ghost small" data-del="' +
        escapeHtml(file.name) +
        '">Borrar</button>' +
        '</div>'
    )
    .join('');

  el.filesHint.textContent = data.files.length + (data.files.length === 1 ? ' archivo' : ' archivos');
}

async function refreshStatus() {
  try {
    renderBanner(await api('/api/status'));
  } catch (err) {
    el.status.textContent = 'No se pudo contactar con el servidor: ' + err.message;
  }
}

async function refreshJobs() {
  try {
    renderJobs(await api('/api/jobs'));
  } catch {
    /* el servidor se estara reiniciando */
  }
}

async function refreshFiles() {
  try {
    renderFiles(await api('/api/files'));
  } catch {
    /* ignora */
  }
}

async function submit() {
  const urls = parseUrls(el.urls.value);
  if (urls.length === 0) {
    el.urls.focus();
    return;
  }

  el.convert.disabled = true;
  el.convert.textContent = 'Procesando...';
  try {
    const data = await api('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls, quality: el.quality.value, playlist: el.playlist.checked }),
    });

    if (data.rejected.length > 0) {
      el.banner.classList.remove('hidden');
      el.banner.textContent = 'Enlaces ignorados (solo YouTube): ' + data.rejected.join(' , ');
    }

    el.urls.value = '';
    updateCount();
    await refreshJobs();
  } catch (err) {
    el.banner.classList.remove('hidden');
    el.banner.textContent = err.message;
  } finally {
    el.convert.disabled = false;
    el.convert.textContent = 'Descargar MP3';
  }
}

el.urls.addEventListener('input', updateCount);
el.convert.addEventListener('click', submit);

el.paste.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      el.urls.value = el.urls.value ? el.urls.value + '\n' + text : text;
      updateCount();
    }
  } catch {
    el.urls.focus();
  }
});

el.clear.addEventListener('click', () => {
  el.urls.value = '';
  updateCount();
  el.urls.focus();
});

el.refresh.addEventListener('click', () => {
  refreshStatus();
  refreshJobs();
  refreshFiles();
});

el.openFolder.addEventListener('click', async () => {
  try {
    await api('/api/open-folder', { method: 'POST' });
  } catch (err) {
    el.banner.classList.remove('hidden');
    el.banner.textContent = err.message;
  }
});

el.jobs.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-clear-job]');
  if (!button || button.dataset.status === 'running') return;
  try {
    await api('/api/job/' + button.dataset.clearJob, { method: 'DELETE' });
    refreshJobs();
  } catch (err) {
    el.banner.classList.remove('hidden');
    el.banner.textContent = err.message;
  }
});

el.files.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-del]');
  if (!button) return;
  if (!confirm('Borrar "' + button.dataset.del + '"?')) return;
  try {
    await api('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: button.dataset.del }),
    });
    refreshFiles();
    refreshJobs();
  } catch (err) {
    el.banner.classList.remove('hidden');
    el.banner.textContent = err.message;
  }
});

updateCount();
refreshStatus();
refreshJobs();
refreshFiles();
setInterval(refreshJobs, 1200);
setInterval(refreshFiles, 5000);
