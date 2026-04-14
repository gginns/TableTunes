// ═══════════════════════════════════════════════════════════════════════════════
// TableTunes — main.js  v1.2
// Electron main process: window, Discord bot, yt-dlp, playback pipeline
// ═══════════════════════════════════════════════════════════════════════════════

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require('@discordjs/voice');
const YTDlpWrap = require('yt-dlp-wrap').default;
const { spawn } = require('child_process');

// ffmpeg-static returns a path inside the asar archive when packaged,
// but binaries can't be executed from inside asar. Redirect to the
// unpacked copy that electron-builder places alongside the asar.
let ffmpegPath = require('ffmpeg-static');
if (ffmpegPath.includes('app.asar')) {
  ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const CONFIG_PATH       = path.join(app.getPath('userData'), 'config.json');
const COOKIES_PATH      = path.join(app.getPath('home'), 'Desktop', 'TableTunes', 'ytcookies.txt');
const CREDENTIALS_PATH  = path.join(app.getPath('home'), 'Desktop', 'TableTunes', 'yt-credentials.json');
const CREDENTIALS_PATH2 = path.join(app.getPath('userData'), 'yt-credentials.json');
const OAUTH_TOKEN_PATH  = path.join(app.getPath('userData'), 'yt-oauth-token.json');

// ─── YouTube OAuth ─────────────────────────────────────────────────────────────

const REDIRECT_URI  = 'http://localhost:42813/oauth2callback';
const OAUTH_SCOPES  = 'https://www.googleapis.com/auth/youtube.readonly';

function loadCredentials() {
  for (const p of [CREDENTIALS_PATH, CREDENTIALS_PATH2]) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {}
  }
  return null;
}

function loadOAuthToken() {
  try {
    if (fs.existsSync(OAUTH_TOKEN_PATH)) return JSON.parse(fs.readFileSync(OAUTH_TOKEN_PATH, 'utf8'));
  } catch {}
  return null;
}

function saveOAuthToken(data) {
  fs.writeFileSync(OAUTH_TOKEN_PATH, JSON.stringify(data, null, 2));
}

async function httpsPost(hostname, urlPath, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const req = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': buf.length },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Bad response')); } });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

async function getValidAccessToken() {
  const token = loadOAuthToken();
  if (!token?.refresh_token) throw new Error('Not authenticated — connect YouTube account first');

  // Still valid with 60s buffer
  if (token.access_token && token.expires_at && Date.now() < token.expires_at - 60000) {
    return token.access_token;
  }

  // Refresh it
  const creds = loadCredentials();
  if (!creds) throw new Error('yt-credentials.json not found');

  const result = await httpsPost('oauth2.googleapis.com', '/token',
    new URLSearchParams({
      client_id:     creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: token.refresh_token,
      grant_type:    'refresh_token',
    }).toString()
  );

  if (result.error) throw new Error(`Token refresh failed: ${result.error_description || result.error}`);

  token.access_token = result.access_token;
  token.expires_at   = Date.now() + (result.expires_in * 1000);
  saveOAuthToken(token);
  return token.access_token;
}

async function ytApiGet(endpoint, params) {
  const accessToken = await getValidAccessToken();
  const qs = new URLSearchParams(params).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.googleapis.com',
      path: `/youtube/v3${endpoint}?${qs}`,
      headers: { Authorization: `Bearer ${accessToken}` },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Bad API response')); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Config ───────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  return { botToken: '', guildId: '', channelId: '', volume: 80 };
}

function saveConfig(updates) {
  // Merges only the changed fields — avoids overwriting unrelated saved values
  const cfg = loadConfig();
  Object.assign(cfg, updates);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ─── State: Window & App ──────────────────────────────────────────────────────

let mainWindow   = null;
let isCleaningUp = false;

// ─── State: Discord / Voice ───────────────────────────────────────────────────

let discordClient   = null;
let voiceConnection = null;
let audioPlayer     = null;
let ytDlp           = null;

// ─── State: Playback ──────────────────────────────────────────────────────────

let currentTrack    = null;
let currentAudioUrl = null;
let currentFfmpeg   = null;
let currentResource = null;
let isPlaying       = false;
let isPausedState   = false;
let volume          = 0.8;

// Generation counters: playbackGeneration increments on every new play request.
// lastStartedGeneration is stamped when audioPlayer.play() is actually called.
// The Idle handler only advances the queue when they match (= natural end of track).
// Any skip/jump increments playbackGeneration first, making all pending Idle events stale.
let playbackGeneration    = 0;
let lastStartedGeneration = 0;

// Progress tracking
let playbackStartTime  = null;
let playbackSeekOffset = 0;
let progressInterval   = null;

// ─── State: Queue ─────────────────────────────────────────────────────────────

let queue             = [];
let currentQueueIndex = -1;
let shuffleMode       = false;
let repeatMode        = false;

// ─── State: Misc ──────────────────────────────────────────────────────────────
// (reserved for future use)

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Send a message to the renderer, safely ignoring destroyed windows */
function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
    mainWindow.webContents.send(channel, data);
}

/** Format seconds to "m:ss" */
function formatDuration(seconds) {
  if (!seconds) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

/** Returns yt-dlp cookie args if the cookie file exists */
function getCookiesArgs() {
  return fs.existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : [];
}

/**
 * Parse a raw yt-dlp JSON object into a track.
 * Single source of truth — used by search, fetch-playlists, fetch-playlist-tracks.
 */
function parseTrack(d) {
  return {
    id:          d.id,
    title:       d.title   || 'Unknown',
    channel:     d.channel || d.uploader || 'Unknown',
    duration:    formatDuration(d.duration),
    durationSec: d.duration    || 0,
    thumbnail:   d.thumbnail   || `https://img.youtube.com/vi/${d.id}/mqdefault.jpg`,
    url:         `https://www.youtube.com/watch?v=${d.id}`,
    viewCount:   d.view_count  || null,
    uploadDate:  d.upload_date || null,
  };
}

/**
 * Kill the current ffmpeg process and clear the progress timer.
 * Called before any new playback starts, on skip, seek, and app close.
 */
function stopCurrentPlayback() {
  if (currentFfmpeg) {
    try { currentFfmpeg.kill('SIGKILL'); } catch {}
    currentFfmpeg = null;
  }
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
}

/** Broadcast current queue state to the renderer */
function broadcastQueue() {
  sendToRenderer('queue-updated', { tracks: queue, currentIndex: currentQueueIndex });
}

// ═══════════════════════════════════════════════════════════════════════════════
// APP LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

async function initYtDlp() {
  const ytDlpPath = path.join(app.getPath('userData'), 'yt-dlp.exe');
  ytDlp = new YTDlpWrap(ytDlpPath);
  if (!fs.existsSync(ytDlpPath)) {
    sendToRenderer('status', { message: 'Downloading yt-dlp...', type: 'info' });
    await YTDlpWrap.downloadFromGithub(ytDlpPath);
    sendToRenderer('status', { message: 'yt-dlp ready!', type: 'success' });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900, height: 660,
    resizable: false, maximizable: false,
    frame: false, backgroundColor: '#0d0d0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('close', (event) => {
    if (isCleaningUp) return;
    event.preventDefault();
    isCleaningUp = true;

    stopCurrentPlayback();
    if (voiceConnection) { try { voiceConnection.destroy(); } catch {} voiceConnection = null; }

    if (discordClient) {
      const fallback = setTimeout(() => { mainWindow.destroy(); app.exit(0); }, 2000);
      discordClient.destroy()
        .catch(() => {})
        .finally(() => { clearTimeout(fallback); mainWindow.destroy(); app.exit(0); });
    } else {
      mainWindow.destroy();
      app.exit(0);
    }
  });
}

app.whenReady().then(async () => {
  createWindow();
  await initYtDlp();
  const cfg = loadConfig();
  volume = (cfg.volume || 80) / 100;
  mainWindow.webContents.once('did-finish-load', () => sendToRenderer('config-loaded', cfg));
});

app.on('window-all-closed', () => {});

// ═══════════════════════════════════════════════════════════════════════════════
// YOUTUBE / SEARCH
// ═══════════════════════════════════════════════════════════════════════════════

/** Convert a raw yt-dlp NDJSON string into an array of tracks */
function parseNdjson(raw) {
  return raw.trim().split('\n').filter(Boolean).map(line => {
    try { return parseTrack(JSON.parse(line)); } catch { return null; }
  }).filter(t => t && t.title !== 'Unknown'); // drop titleless/garbage entries
}

const YT_URL_RE = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//;

/**
 * Handle a pasted YouTube URL directly:
 * - Single video     → full metadata fetch (includes viewCount, uploadDate)
 * - Playlist/channel → flat-fetch first `limit` tracks
 */
async function searchByUrl(url, limit) {
  const isPlaylistOrChannel =
    url.includes('list=') || url.includes('/playlist') ||
    url.includes('/channel/') || url.includes('/@') || url.includes('/c/');

  if (isPlaylistOrChannel) {
    sendToRenderer('status', { message: 'Loading URL...', type: 'info' });
    const raw = await ytDlp.execPromise([
      url, '--dump-json', '--flat-playlist', '--no-warnings',
      '--playlist-end', String(limit), '--js-runtime', 'node', ...getCookiesArgs(),
    ]);
    return parseNdjson(raw);
  } else {
    // Single video — omit --flat-playlist to get full metadata including view count
    sendToRenderer('status', { message: 'Loading video info...', type: 'info' });
    const raw = await ytDlp.execPromise([
      url, '--dump-json', '--no-warnings', '--no-playlist',
      '--js-runtime', 'node', ...getCookiesArgs(),
    ]);
    try { return [parseTrack(JSON.parse(raw.trim().split('\n')[0]))]; } catch { return []; }
  }
}

ipcMain.handle('search', async (_, { query, sort = 'relevance', offset = 0, limit = 50 }) => {
  try {
    // Pasted YouTube URL — bypass normal keyword search
    if (YT_URL_RE.test(query)) return await searchByUrl(query, limit);

    // Always use relevance prefix — yt-dlp has no reliable views/date sort prefix.
    // "Most Viewed" sort is applied client-side after results arrive.
    const total = offset + limit;
    const raw = await ytDlp.execPromise([
      `ytsearch${total}:${query}`,
      '--dump-json', '--flat-playlist', '--no-warnings',
      '--js-runtime', 'node',
      ...getCookiesArgs(),
    ]);

    const all = parseNdjson(raw);
    return all.slice(offset);
  } catch (err) {
    sendToRenderer('status', { message: `Search error: ${err.message}`, type: 'error' });
    return [];
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYLISTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── YouTube Auth ──────────────────────────────────────────────────────────────

ipcMain.handle('get-auth-status', () => {
  const token = loadOAuthToken();
  const creds = loadCredentials();
  return {
    authenticated:  !!(token?.refresh_token),
    hasCredentials: !!(creds?.client_id && creds?.client_secret),
  };
});

ipcMain.handle('auth-youtube', async () => {
  const creds = loadCredentials();
  if (!creds?.client_id || !creds?.client_secret)
    return { success: false, error: 'yt-credentials.json not found or invalid in TableTunes folder' };

  return new Promise((resolve) => {
    let server;

    const timeout = setTimeout(() => {
      server?.close();
      resolve({ success: false, error: 'Auth timeout — no response after 5 minutes' });
    }, 5 * 60 * 1000);

    server = http.createServer(async (req, res) => {
      try {
        const url   = new URL(req.url, 'http://localhost:42813');
        const code  = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;padding:40px"><h2>Authorization denied.</h2><p>You can close this tab.</p></body></html>');
          clearTimeout(timeout); server.close();
          resolve({ success: false, error: `Access denied: ${error}` });
          return;
        }

        if (!code) {
          // Silently ignore favicon and other non-callback requests
          res.writeHead(204);
          res.end();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;padding:40px;background:#0d0d0f;color:#e8e8f0"><h2 style="color:#00c9b1">&#10003; TableTunes connected to YouTube!</h2><p>You can close this tab and return to the app.</p></body></html>');
        clearTimeout(timeout); server.close();

        // Exchange code for tokens
        const tokenData = await httpsPost('oauth2.googleapis.com', '/token',
          new URLSearchParams({
            code,
            client_id:     creds.client_id,
            client_secret: creds.client_secret,
            redirect_uri:  REDIRECT_URI,
            grant_type:    'authorization_code',
          }).toString()
        );

        if (tokenData.error) {
          resolve({ success: false, error: tokenData.error_description || tokenData.error });
          return;
        }

        saveOAuthToken({
          access_token:  tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at:    Date.now() + (tokenData.expires_in * 1000),
        });

        resolve({ success: true });
      } catch (err) {
        resolve({ success: false, error: err.message });
      }
    });

    server.listen(42813, () => {
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id:     creds.client_id,
        redirect_uri:  REDIRECT_URI,
        response_type: 'code',
        scope:         OAUTH_SCOPES,
        access_type:   'offline',
        prompt:        'consent',
      }).toString();
      shell.openExternal(authUrl);
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ success: false, error: `Could not start auth server: ${err.message}` });
    });
  });
});

// ─── Playlists (YouTube Data API v3) ──────────────────────────────────────────

ipcMain.handle('fetch-playlists', async () => {
  try {
    sendToRenderer('status', { message: 'Fetching playlists...', type: 'info' });

    const playlists = [];
    let pageToken = '';

    do {
      const params = { part: 'snippet,contentDetails', mine: 'true', maxResults: '50' };
      if (pageToken) params.pageToken = pageToken;

      const data = await ytApiGet('/playlists', params);
      if (data.error) throw new Error(data.error.message);

      for (const item of (data.items || [])) {
        const thumbs = item.snippet.thumbnails;
        playlists.push({
          id:        item.id,
          title:     item.snippet.title,
          count:     item.contentDetails.itemCount,
          thumbnail: thumbs?.medium?.url || thumbs?.default?.url || '',
          url:       `https://www.youtube.com/playlist?list=${item.id}`,
        });
      }

      pageToken = data.nextPageToken || '';
    } while (pageToken);

    sendToRenderer('status', { message: `Found ${playlists.length} playlists`, type: 'success' });
    return playlists;
  } catch (err) {
    const msg = err.message.includes('Not authenticated')
      ? 'Connect your YouTube account in the Playlists tab'
      : `Playlist error: ${err.message}`;
    sendToRenderer('status', { message: msg, type: 'error' });
    return [];
  }
});

/** Parse ISO 8601 duration (PT1H2M3S) → seconds */
function parseISODuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

ipcMain.handle('fetch-playlist-tracks', async (_, { url, title, limit = 50, offset = 0 }) => {
  try {
    sendToRenderer('status', { message: `Loading: ${title}...`, type: 'info' });

    const playlistId = new URL(url).searchParams.get('list');
    if (!playlistId) throw new Error('Invalid playlist URL');

    const tracks    = [];
    let pageToken   = '';
    let totalFetched = 0;

    // Page through until we reach offset, then collect up to limit
    do {
      const params = { part: 'snippet', playlistId, maxResults: '50' };
      if (pageToken) params.pageToken = pageToken;

      const data = await ytApiGet('/playlistItems', params);
      if (data.error) throw new Error(data.error.message);

      for (const item of (data.items || [])) {
        totalFetched++;
        if (totalFetched <= offset) continue;
        if (tracks.length >= limit) break;

        const snippet = item.snippet;
        const videoId = snippet.resourceId?.videoId;
        if (!videoId || snippet.title === 'Private video' || snippet.title === 'Deleted video') continue;

        const thumbs = snippet.thumbnails;
        tracks.push({
          id:          videoId,
          title:       snippet.title,
          channel:     snippet.videoOwnerChannelTitle || 'Unknown',
          duration:    '?:??',
          durationSec: 0,
          thumbnail:   thumbs?.medium?.url || thumbs?.default?.url || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
          url:         `https://www.youtube.com/watch?v=${videoId}`,
          viewCount:   null,
          uploadDate:  null,
        });
      }

      pageToken = data.nextPageToken || '';
    } while (pageToken && tracks.length < limit);

    // Batch-fetch durations from videos API (50 IDs per request)
    for (let i = 0; i < tracks.length; i += 50) {
      const ids = tracks.slice(i, i + 50).map(t => t.id).join(',');
      const vdata = await ytApiGet('/videos', { part: 'contentDetails', id: ids });
      for (const item of (vdata.items || [])) {
        const track = tracks.find(t => t.id === item.id);
        if (track) {
          const sec = parseISODuration(item.contentDetails?.duration);
          track.durationSec = sec;
          track.duration    = formatDuration(sec);
        }
      }
    }

    sendToRenderer('status', { message: `Loaded ${tracks.length} tracks`, type: 'success' });
    return tracks;
  } catch (err) {
    sendToRenderer('status', { message: `Error: ${err.message}`, type: 'error' });
    return [];
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// QUEUE
// ═══════════════════════════════════════════════════════════════════════════════

function shuffleQueue() {
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }
}

ipcMain.on('add-to-queue', (_, track) => {
  queue.push(track);
  if (shuffleMode && queue.length > 1) shuffleQueue();
  broadcastQueue();
  sendToRenderer('status', { message: `Added: ${track.title}`, type: 'success' });
});

ipcMain.on('remove-from-queue', (_, i) => {
  queue.splice(i, 1);
  if (i <= currentQueueIndex) currentQueueIndex--;
  broadcastQueue();
});

ipcMain.on('move-queue-item', (_, { from, to }) => {
  const [item] = queue.splice(from, 1);
  queue.splice(to, 0, item);
  broadcastQueue();
});

ipcMain.on('clear-queue', () => {
  queue = [];
  currentQueueIndex = -1;
  broadcastQueue();
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYBACK — NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Interrupt current playback and start the next track determined by currentQueueIndex.
 * Incrementing playbackGeneration:
 *   1. Cancels any in-flight yt-dlp fetch (myGen check in playNext)
 *   2. Makes all pending Idle events from the old track stale (generation mismatch in Idle handler)
 */
function interruptAndPlay() {
  playbackGeneration++;
  stopCurrentPlayback();
  isPlaying     = false;
  isPausedState = false;
  if (audioPlayer) audioPlayer.stop(true);
  playNext();
}

// Play a specific track immediately — inserts at front of queue
ipcMain.on('play-track-now', (_, track) => {
  queue.unshift(track);
  currentQueueIndex = -1; // playNext() will increment to 0
  broadcastQueue();
  interruptAndPlay();
});

// Jump to an existing queue slot — no duplication
ipcMain.on('play-queue-index', (_, index) => {
  currentQueueIndex = index - 1; // playNext() increments before playing
  interruptAndPlay();
});

// Skip to next track
ipcMain.on('skip', () => {
  interruptAndPlay();
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYBACK — CORE
// ═══════════════════════════════════════════════════════════════════════════════

async function playNext() {
  if (!voiceConnection || queue.length === 0) {
    isPlaying = false; currentTrack = null; currentQueueIndex = -1;
    sendToRenderer('now-playing', null);
    sendToRenderer('now-playing-id', null);
    broadcastQueue();
    sendToRenderer('status', { message: 'Queue finished', type: 'info' });
    return;
  }

  // Advance index
  if (shuffleMode) {
    let nextIdx;
    do { nextIdx = Math.floor(Math.random() * queue.length); }
    while (queue.length > 1 && nextIdx === currentQueueIndex);
    currentQueueIndex = nextIdx;
  } else {
    currentQueueIndex++;
  }

  // Wrap or stop at end of queue
  if (currentQueueIndex >= queue.length) {
    if (repeatMode) {
      currentQueueIndex = 0;
    } else {
      isPlaying = false; currentTrack = null; currentQueueIndex = -1;
      sendToRenderer('now-playing', null);
      sendToRenderer('now-playing-id', null);
      broadcastQueue();
      sendToRenderer('status', { message: 'Queue finished', type: 'info' });
      return;
    }
  }

  currentTrack = queue[currentQueueIndex];
  broadcastQueue();
  sendToRenderer('now-playing', currentTrack);
  sendToRenderer('now-playing-id', currentTrack.id);
  sendToRenderer('status', { message: `Loading: ${currentTrack.title}`, type: 'info' });

  isPlaying = true;
  const myGen = playbackGeneration; // snapshot — bail if this changes mid-await

  try {
    const raw = await ytDlp.execPromise([
      currentTrack.url, '--get-url', '--no-warnings', '--no-playlist',
      '-f', 'bestaudio/best', '--js-runtime', 'node', ...getCookiesArgs(),
    ]);

    if (myGen !== playbackGeneration) return; // stale — a newer request took over

    const audioUrl = raw.trim().split('\n')[0];
    if (!audioUrl) throw new Error('Could not get audio URL');

    currentAudioUrl    = audioUrl;
    playbackStartTime  = Date.now();
    playbackSeekOffset = 0;
    isPausedState      = false;

    // Start progress timer
    const capturedDuration = currentTrack.durationSec || 0;
    progressInterval = setInterval(() => {
      const elapsed = playbackSeekOffset + Math.floor((Date.now() - playbackStartTime) / 1000);
      sendToRenderer('seek-progress', { current: elapsed, duration: capturedDuration });
    }, 1000);

    sendToRenderer('status', { message: `Now playing: ${currentTrack.title}`, type: 'success' });

    // Spawn ffmpeg
    const ffmpegProcess = spawn(ffmpegPath, [
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', audioUrl, '-vn',
      '-af', `adelay=500|500,afade=t=in:st=0.5:d=0.5,volume=${volume}`,
      '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    currentFfmpeg = ffmpegProcess;
    ffmpegProcess.stderr.on('data', (d) => {
      const msg = d.toString();
      if (!msg.includes('size=') && !msg.includes('time=') && !msg.includes('speed='))
        console.log('ffmpeg:', msg.trim());
    });
    ffmpegProcess.on('error', (err) => { if (err.code !== 'EPIPE') console.error('ffmpeg error:', err.message); });
    ffmpegProcess.stdout.on('error', () => {});

    const resource = createAudioResource(ffmpegProcess.stdout, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume.setVolume(volume);
    currentResource = resource;

    // Stamp generation at the exact moment we start playing.
    // Idle handler compares playbackGeneration === lastStartedGeneration to detect natural end-of-track.
    lastStartedGeneration = playbackGeneration;
    audioPlayer.play(resource);

  } catch (err) {
    if (myGen !== playbackGeneration) return; // stale — newer request handles recovery
    console.error('Playback error:', err.message);
    sendToRenderer('status', { message: `Playback error: ${err.message}`, type: 'error' });
    sendToRenderer('now-playing', null);
    sendToRenderer('now-playing-id', null);
    isPlaying = false;
    setTimeout(playNext, 2000);
  }
}

// ─── Pause / Resume ───────────────────────────────────────────────────────────

ipcMain.on('pause', () => {
  if (!audioPlayer || !isPlaying) return;

  if (!isPausedState) {
    audioPlayer.pause();
    isPausedState = true;
    if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
    // Capture elapsed time so resume starts from the right position
    playbackSeekOffset += Math.floor((Date.now() - playbackStartTime) / 1000);
    sendToRenderer('playback-state', { paused: true });
  } else {
    audioPlayer.unpause();
    isPausedState     = false;
    playbackStartTime = Date.now();
    const capturedDuration = currentTrack?.durationSec || 0;
    progressInterval = setInterval(() => {
      const elapsed = playbackSeekOffset + Math.floor((Date.now() - playbackStartTime) / 1000);
      sendToRenderer('seek-progress', { current: elapsed, duration: capturedDuration });
    }, 1000);
    sendToRenderer('playback-state', { paused: false });
  }
});

// ─── Seek ─────────────────────────────────────────────────────────────────────

ipcMain.handle('seek-to', async (_, seconds) => {
  if (!currentTrack || !currentAudioUrl) return;

  // Treat seek like a new playback start so old Idle events are ignored
  playbackGeneration++;
  const myGen = playbackGeneration;

  stopCurrentPlayback();
  playbackSeekOffset = seconds;
  playbackStartTime  = Date.now();
  isPausedState      = false;

  try {
    const ffmpegProcess = spawn(ffmpegPath, [
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-ss', String(seconds), '-i', currentAudioUrl, '-vn',
      '-af', `adelay=500|500,afade=t=in:st=0.5:d=0.5,volume=${volume}`,
      '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    currentFfmpeg = ffmpegProcess;
    ffmpegProcess.stderr.on('data', () => {});
    ffmpegProcess.on('error', () => {});
    ffmpegProcess.stdout.on('error', () => {});

    const seekRes = createAudioResource(ffmpegProcess.stdout, { inputType: StreamType.Raw, inlineVolume: true });
    seekRes.volume.setVolume(volume);
    currentResource = seekRes;

    const capturedDuration = currentTrack.durationSec || 0;
    progressInterval = setInterval(() => {
      const elapsed = playbackSeekOffset + Math.floor((Date.now() - playbackStartTime) / 1000);
      sendToRenderer('seek-progress', { current: elapsed, duration: capturedDuration });
    }, 1000);

    lastStartedGeneration = myGen;
    audioPlayer.play(seekRes);
  } catch (err) {
    console.error('Seek error:', err.message);
  }
});

// ─── Volume ───────────────────────────────────────────────────────────────────

let volumeSaveDebounce = null;
ipcMain.on('set-volume', (_, val) => {
  volume = val / 100;
  if (currentResource?.volume) currentResource.volume.setVolume(volume);
  // Apply instantly — only debounce the disk write
  clearTimeout(volumeSaveDebounce);
  volumeSaveDebounce = setTimeout(() => saveConfig({ volume: val }), 300);
});

// ─── Modes ────────────────────────────────────────────────────────────────────

ipcMain.on('set-shuffle', (_, enabled) => {
  shuffleMode = enabled;
  if (enabled && queue.length > 1) { shuffleQueue(); broadcastQueue(); }
  sendToRenderer('status', { message: `Shuffle ${enabled ? 'ON' : 'OFF'}`, type: 'info' });
});

ipcMain.on('set-repeat', (_, enabled) => {
  repeatMode = enabled;
  sendToRenderer('status', { message: `Repeat ${enabled ? 'ON' : 'OFF'}`, type: 'info' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DISCORD BOT
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('connect-bot', async (_, { token, guildId }) => {
  try {
    if (discordClient) { discordClient.destroy(); discordClient = null; }

    discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

    await new Promise((resolve, reject) => {
      discordClient.once('clientReady', resolve);
      discordClient.once('error', reject);
      discordClient.login(token).catch(reject);
      setTimeout(() => reject(new Error('Login timeout')), 15000);
    });

    const guild         = await discordClient.guilds.fetch(guildId);
    const channels      = await guild.channels.fetch();
    const voiceChannels = channels
      .filter(c => c && c.type === 2)
      .map(c => ({ id: c.id, name: c.name }));

    saveConfig({ botToken: token, guildId });
    sendToRenderer('bot-ready', { username: discordClient.user.tag, voiceChannels });
    return { success: true, voiceChannels };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('join-channel', async (_, channelId) => {
  try {
    if (!discordClient) throw new Error('Bot not connected');

    const cfg     = loadConfig();
    const guild   = await discordClient.guilds.fetch(cfg.guildId);
    const channel = await guild.channels.fetch(channelId);

    if (voiceConnection) { voiceConnection.destroy(); voiceConnection = null; }

    voiceConnection = joinVoiceChannel({
      channelId:      channel.id,
      guildId:        guild.id,
      adapterCreator: guild.voiceAdapterCreator,
    });

    audioPlayer = createAudioPlayer();

    audioPlayer.on(AudioPlayerStatus.Idle, () => {
      stopCurrentPlayback();
      // Only advance queue on natural end-of-track.
      // skip/play-now/seek all increment playbackGeneration before stamping lastStartedGeneration,
      // so their Idle events (from ffmpeg EOF + audioPlayer.stop()) are both silently ignored here.
      if (playbackGeneration === lastStartedGeneration) {
        isPlaying = false;
        playNext();
      }
    });

    audioPlayer.on('error', (err) => {
      console.error('Player error:', err.message);
      isPlaying = false;
      playNext();
    });

    voiceConnection.subscribe(audioPlayer);
    await entersState(voiceConnection, VoiceConnectionStatus.Ready, 20_000);

    saveConfig({ channelId });
    sendToRenderer('status', { message: `Joined: ${channel.name}`, type: 'success' });
    return { success: true, channelName: channel.name };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.on('leave-channel', () => {
  stopCurrentPlayback();
  if (voiceConnection) { voiceConnection.destroy(); voiceConnection = null; }
  audioPlayer     = null;
  isPlaying       = false;
  currentTrack    = null;
  currentAudioUrl = null;
  sendToRenderer('now-playing', null);
  sendToRenderer('status', { message: 'Left voice channel', type: 'info' });
  sendToRenderer('bot-disconnected', {});
});

// ═══════════════════════════════════════════════════════════════════════════════
// WINDOW CONTROLS
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-close', () => mainWindow.close());
