// TableTunes — preload.js  v1.2
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Search
  search: (opts) => ipcRenderer.invoke('search', opts),

  // Queue
  addToQueue: (track) => ipcRenderer.send('add-to-queue', track),
  removeFromQueue: (index) => ipcRenderer.send('remove-from-queue', index),
  moveQueueItem: (from, to) => ipcRenderer.send('move-queue-item', { from, to }),
  clearQueue: () => ipcRenderer.send('clear-queue'),
  playTrackNow: (track) => ipcRenderer.send('play-track-now', track),
  playFromQueueIndex: (index) => ipcRenderer.send('play-queue-index', index),

  // Playback
  skip: () => ipcRenderer.send('skip'),
  pause: () => ipcRenderer.send('pause'),
  setVolume: (val) => ipcRenderer.send('set-volume', val),
  seekTo: (seconds) => ipcRenderer.invoke('seek-to', seconds),

  // Bot
  connectBot: (data) => ipcRenderer.invoke('connect-bot', data),
  joinChannel: (channelId) => ipcRenderer.invoke('join-channel', channelId),
  leaveChannel: () => ipcRenderer.send('leave-channel'),

  // YouTube OAuth
  authYoutube:   () => ipcRenderer.invoke('auth-youtube'),
  getAuthStatus: () => ipcRenderer.invoke('get-auth-status'),

  // Playlists
  fetchPlaylists: () => ipcRenderer.invoke('fetch-playlists'),
  fetchPlaylistTracks: (data) => ipcRenderer.invoke('fetch-playlist-tracks', data),

  // Modes
  setShuffle: (enabled) => ipcRenderer.send('set-shuffle', enabled),
  setRepeat: (enabled) => ipcRenderer.send('set-repeat', enabled),

  // Window
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),

  // Events from main
  on: (channel, cb) => {
    const allowed = [
      'status', 'queue-updated', 'now-playing', 'playback-state',
      'bot-ready', 'bot-disconnected', 'config-loaded',
      'seek-progress', 'now-playing-id',
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
      ipcRenderer.on(channel, (_, data) => cb(data));
    }
  },
});
