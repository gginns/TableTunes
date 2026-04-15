# TableTunes 🎵
**A GM music controller that streams YouTube audio to Discord voice channels.**

This is still in developement and may result in bugs.

---

## Requirements
- Windows 10/11
- [Node.js 18+](https://nodejs.org) (LTS recommended)
- A Discord Bot token
- Chrome with YouTube Premium logged in

---

## Setup

### 1. Install dependencies
Double-click `setup.bat` — this installs everything including Electron and Discord.js.

### 2. Create a Discord Bot
1. Go to https://discord.com/developers/applications
2. Click **New Application** → give it a name
3. Go to **Bot** → click **Add Bot**
4. Under **Token**, click **Reset Token** and copy it
5. Under **Privileged Gateway Intents**, enable **Server Members Intent** and **Voice** (if shown)
6. Go to **OAuth2 → URL Generator**
   - Scopes: `bot`
   - Bot Permissions: `Connect`, `Speak`, `Use Voice Activity`
7. Copy the generated URL, open it in your browser, and invite the bot to your server

### 3. Get your Server ID
- In Discord, go to **Settings → Advanced → Enable Developer Mode**
- Right-click your server name → **Copy Server ID**

### 4. Launch TableTunes
Double-click `start.bat`

---

## Using TableTunes

1. **Paste your Bot Token** and **Server ID** in the left sidebar → click **Connect Bot**
2. **Select your voice channel** from the dropdown → click **Join Channel**
3. **Search YouTube** in the center panel
4. Click **▶ Play** to play immediately, or **+ Queue** to add to queue
5. Drag queue items to reorder them
6. Use the **volume slider** to control stream volume (applies to next track)

> **Note:** yt-dlp will download automatically on first launch (~10MB).  
> It uses your Chrome YouTube Premium cookies for highest quality audio.

---

## File Structure
```
ytdiscord/
├── src/
│   ├── main.js        ← Electron main process + Discord bot + yt-dlp
│   ├── preload.js     ← Secure IPC bridge
│   └── index.html     ← Full UI
├── package.json
├── setup.bat          ← Run first
├── start.bat          ← Run to launch
└── README.md
```

---

## Troubleshooting

**"yt-dlp failed" / no audio**  
- Make sure you're logged into YouTube in Chrome with Premium
- Try running `start.bat` as Administrator once to allow cookie access

**Bot connects but won't join channel**  
- Make sure the bot has `Connect` and `Speak` permissions in that channel

**Audio quality is low**  
- Check you're logged into YouTube Premium in Chrome
- yt-dlp auto-selects best available format with your cookies

**Bot token error**  
- Regenerate the token in Discord Developer Portal — tokens can only be seen once

---

## Notes
- Volume changes apply to the **next** track (ffmpeg is spawned per track)
- Your bot token is saved locally in `%APPDATA%\yt-discord-player\config.json`
- yt-dlp binary is saved to the same folder and auto-updates are not automatic — re-run setup occasionally
