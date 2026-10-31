const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, session,
  screen, systemPreferences, shell, Tray, Menu, nativeImage, dialog,
} = require('electron');

require('dotenv').config({ path: path.join(__dirname, '.env') });
const store = require('./store');
const { createCallWatcher } = require('./calls');

// Keeps system audio on the Screen Recording permission path (works in dev and packaged)
app.commandLine.appendSwitch('disable-features', 'MacCatapLoopbackAudioForScreenShare');

if (!app.requestSingleInstanceLock()) app.quit();

let win;
let tray;
let clickThrough = false;
let isListening = false;
let currentAbort = null;
let questionTimer = null;
let lastQuestion = '';
const pastAnswers = []; // answers given in this session, so stories don't repeat
const transcript = []; // { who: 'You' | 'Them', text, at }
let sessionStart = new Date();

const settings = () => store.getSettings();

// ---------- window ----------

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: 480,
    height: 600,
    minWidth: 340,
    minHeight: 300,
    x: width - 500,
    y: 40,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(true); // hidden from screen share and screenshots
  win.loadFile('index.html');

  // Show on first launch, or when started by hand (not at login)
  // Started at login: stay hidden in the menu bar until a call starts
  win.once('ready-to-show', () => {
    if (!STARTED_HIDDEN) win.showInactive();
  });
}

const STARTED_HIDDEN = process.argv.includes('--hidden');
const LAUNCH_AGENT = path.join(require('os').homedir(), 'Library', 'LaunchAgents', 'dev.commi.sidekick.plist');

// macOS 13+ doesn't tell apps they were opened at login, so we register our own
// login agent that launches Sidekick with --hidden
function setOpenAtLogin(on) {
  if (!app.isPackaged || process.platform !== 'darwin') return;
  try { app.setLoginItemSettings({ openAtLogin: false }); } catch {} // remove the old style login item
  if (!on) {
    try { fs.unlinkSync(LAUNCH_AGENT); } catch {}
    return;
  }
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.commi.sidekick</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>--hidden</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(LAUNCH_AGENT), { recursive: true });
  fs.writeFileSync(LAUNCH_AGENT, plist);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Runs a renderer action as if the user clicked, so mic and
// screen-audio capture are allowed to start
function runInRenderer(action) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  return win.webContents.executeJavaScript(`window.__sk && window.__sk.${action}()`, true).catch(() => {});
}

function showWindow(focus = false) {
  if (focus) { win.show(); win.focus(); } else win.showInactive();
}

function toggleVisible() {
  if (win.isVisible()) win.hide(); else showWindow();
  updateTray();
}

// ---------- capture ----------

function setupDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => callback({}));
  });
}

async function captureScreen() {
  const display = screen.getPrimaryDisplay();
  const scale = Math.min(1, 1600 / display.size.width);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  });
  const primary = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!primary) return null;
  return primary.thumbnail.toJPEG(80).toString('base64');
}

function recentTranscript(seconds = 180) {
  const cutoff = Date.now() - seconds * 1000;
  return transcript.filter((t) => t.at >= cutoff).map((t) => `${t.who}: ${t.text}`).join('\n');
}


// ---------- errors ----------

const LOG_FILE = () => path.join(app.getPath('userData'), 'sidekick.log');

function logError(where, detail) {
  try {
    fs.appendFileSync(LOG_FILE(), `[${new Date().toISOString()}] ${where}: ${detail}\n`);
  } catch {}
}

// Turns an OpenAI error response into something readable
function friendlyApiError(what, status, body) {
  let msg = '';
  try { msg = JSON.parse(body).error?.message || ''; } catch { msg = String(body || '').slice(0, 200); }
  logError(what, `${status} ${body}`);
  if (status === 401) return `${what} failed: your OpenAI key was rejected. Paste it again in Settings.`;
  if (status === 429) return `${what} failed: out of OpenAI credits or rate limited. Check your balance at platform.openai.com. (${msg})`;
  if (status === 404) return `${what} failed: the model name isn't available on your account. Change it in Settings > Advanced. (${msg})`;
  return `${what} failed (${status}): ${msg || 'no details from OpenAI'}`;
}

function errorText(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  return err.message || err.toString() || 'Unknown error';
}

// ---------- OpenAI ----------

function requireKey() {
  const key = store.getApiKey();
  if (!key) throw new Error('No OpenAI key yet. Open ⋯ > Settings and paste your key.');
  return key;
}

async function transcribe(buffer, mimeType) {
  const key = requireKey();
  const form = new FormData();
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  form.append('file', new Blob([buffer], { type: mimeType }), `chunk.${ext}`);
  form.append('model', settings().transcribeModel);
  form.append('language', 'en');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(friendlyApiError('Transcription', res.status, await res.text()));
  const data = await res.json();
  return (data.text || '').trim();
}

const BASE_PROMPT = `You are Sidekick, a real-time assistant shown in a small overlay.
The user is in the middle of something live: an interview, a call, a meeting, a lecture, or work on their screen.
Your job is to hand them the actual answer, ready to use.

How to answer:
- Never restate, summarize, or describe the question. Go straight to the answer.
- When someone asked the user a question, write what the user should say back, in first person, as if they're talking.
- Keep it short enough to glance at: usually 3 to 6 sentences. Longer only for "walk me through" questions.
- If there's a coding or math problem on screen, give the approach and the solution with brief reasoning.
- "You" in the transcript is the user. "Them" is everyone else.

Sound like a real person, not an AI:
- Write the way a smart, friendly college senior actually talks in a professional interview: contractions, plain words, specific details (what the problem was, what they actually did, what tools, what happened).
- Vary how answers start and end. Don't end with a tidy moral, a summary line, or "and that's why I...". It's fine to just stop once the point is made.
- Avoid filler and corporate words: passionate, leverage, utilize, spearheaded, synergy, "I'm excited to", "ultimately", "at the end of the day", "in summary", "this taught me the importance of".
- Let some personality through: a little warmth, honesty about what was hard, curiosity.

Use the full range of the user's experience:
- Their context has many experiences: jobs, projects, school, volunteering, life. Pick the one that best fits each question, not the same favorite every time.
- Check "What I've already said" below. Don't reuse a story that's already been told unless the question is specifically about it. Reach for a different experience.

Honesty:
- You can use general knowledge to explain concepts, reason through technical questions, and frame answers naturally.
- Never invent experiences, results, numbers, tools, or skills the user doesn't have. If their context doesn't cover something, answer honestly from what they do have, or note in a few words what's missing.
- Follow the user's own notes and instructions in their context.`;

// mode: 'heard' = someone asked the user a question out loud,
//       'typed' = the user typed a question, 'now' = Cmd+Enter with nothing typed
function buildInput({ question, screenshot, mode }) {
  const ctx = store.contextForPrompt();
  const content = [];
  let text = '';
  if (ctx.text) text += `=== My context (${ctx.name}) ===\n${ctx.text}\n\n`;
  const convo = recentTranscript();
  if (convo) text += `=== Recent transcript ===\n${convo}\n\n`;
  if (pastAnswers.length) {
    text += `=== What I've already said in this conversation (don't repeat these stories) ===\n${pastAnswers.slice(-8).map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\n`;
  }
  if (mode === 'heard') {
    text += `=== Task ===\nThey just asked me: "${question}"\nWrite exactly what I should say back, in first person. Don't repeat or describe the question.`;
  } else if (question) {
    text += `=== Task ===\n${question}\n\nIf that reads like a question someone asked me (an interview or conversation question), write exactly what I should say back, in first person. Otherwise just answer it directly. Don't repeat or describe the question.`;
  } else {
    text += '=== Task ===\nIf someone in the transcript just asked me a question, write exactly what I should say back, in first person. If there is a problem on my screen, solve it. Otherwise tell me the most useful thing for this moment. Don\'t repeat or describe the question.';
  }
  content.push({ type: 'input_text', text });
  content.push(...ctx.attachments);
  if (screenshot) content.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${screenshot}` });
  return [{ role: 'user', content }];
}

async function streamAnswer({ question = '', includeScreen = false, label = '', mode = '' }) {
  if (currentAbort) currentAbort.abort();
  const ac = new AbortController();
  currentAbort = ac;
  try {
    const key = requireKey();
    send('answer:start', { question: label || question || (includeScreen ? 'Screen + conversation' : 'Conversation') });
    let screenshot = null;
    if (includeScreen) {
      try {
        screenshot = await captureScreen();
      } catch (err) {
        // usually Screen Recording permission was reset by a reinstall
        logError('Screenshot', errorText(err));
        send('status', { error: 'Could not read your screen, so I answered without it. Turn on Screen Recording for Sidekick in System Settings, then reopen it.' });
      }
    }
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: ac.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings().chatModel,
        instructions: BASE_PROMPT,
        input: buildInput({ question, screenshot, mode }),
        stream: true,
      }),
    });
    if (!res.ok) throw new Error(friendlyApiError('Answer', res.status, await res.text()));

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let gotText = false;
    let fullAnswer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        if (ac.signal.aborted) return;
        if (evt.type === 'response.output_text.delta') { gotText = true; fullAnswer += evt.delta || ''; send('answer:delta', evt.delta); }
        if (evt.type === 'response.output_text.done' && !gotText && evt.text) { gotText = true; send('answer:delta', evt.text); }
        if (evt.type === 'error' || evt.type === 'response.failed') {
          logError('Answer stream', payload);
          throw new Error(`Answer failed: ${evt.message || evt.error?.message || evt.response?.error?.message || 'OpenAI returned an error with no details'}`);
        }
        if (evt.type === 'response.refusal.delta' && evt.delta) { gotText = true; send('answer:delta', evt.delta); }
        if (evt.type === 'response.incomplete') logError('Answer stream', `incomplete: ${payload}`);
      }
    }
    if (!gotText) {
      logError('Answer', 'stream ended with no text');
      send('answer:error', 'The model sent back an empty answer. Try again, or change the answer model in Settings.');
    }
    else {
      if (fullAnswer.trim()) pastAnswers.push(fullAnswer.trim().replace(/\s+/g, ' ').slice(0, 400));
      send('answer:done');
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    logError('Answer', errorText(err));
    send('answer:error', errorText(err));
  } finally {
    if (currentAbort === ac) currentAbort = null;
  }
}

async function summarize() {
  const full = transcript.map((t) => `${t.who}: ${t.text}`).join('\n');
  if (!full) throw new Error('Nothing in the transcript yet.');
  const key = requireKey();
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings().chatModel,
      instructions: 'Summarize this conversation in plain language. Sections: Summary (3 to 5 sentences), Key points, Action items (who does what), Follow-up questions. Keep it tight.',
      input: full,
    }),
  });
  if (!res.ok) throw new Error(friendlyApiError('Summary', res.status, await res.text()));
  const data = await res.json();
  const summary = data.output_text
    || (data.output || []).flatMap((o) => o.content || []).map((c) => c.text || '').join('');

  const dir = store.notesDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = sessionStart.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const file = path.join(dir, `${stamp}.md`);
  fs.writeFileSync(file, `# Session ${sessionStart.toLocaleString()}\n\nContext: ${store.activeProfile().name}\n\n${summary}\n\n---\n\n## Transcript\n\n${full}\n`);
  return { summary, file };
}

// ---------- auto-answer ----------

const QUESTION_START = /^(so,?\s+|okay,?\s+|and\s+)?(what|how|why|when|where|which|who|can you|could you|would you|do you|did you|have you|are you|is there|tell me|walk me|describe|explain|give me|talk about)\b/i;

function looksLikeQuestion(text) {
  return text.includes('?') || QUESTION_START.test(text.trim());
}

// Waits for the other person to finish talking before answering
function handleAutoAnswer(line) {
  if (line.who !== 'Them') return;
  if (!settings().autoAnswer) {
    if (looksLikeQuestion(line.text)) send('status', { info: 'Question heard. Turn on Auto, or press Cmd+Shift+Enter to answer.' });
    return;
  }
  if (questionTimer) {
    // still talking: keep adding to the question
    lastQuestion = `${lastQuestion} ${line.text}`.trim();
  } else if (looksLikeQuestion(line.text)) {
    lastQuestion = line.text;
  } else {
    return;
  }
  clearTimeout(questionTimer);
  questionTimer = setTimeout(() => {
    questionTimer = null;
    const q = lastQuestion;
    const label = `Heard: "${q.length > 70 ? q.slice(0, 70) + '...' : q}"`;
    streamAnswer({ question: q, includeScreen: false, label, mode: 'heard' });
  }, 1800);
}

// ---------- call detection ----------

const callWatcher = createCallWatcher({
  onStart: async (appName) => {
    send('status', { info: `${appName} call detected` });
    showWindow();
    await runInRenderer('newSession');
    if (settings().autoListen && !isListening) await runInRenderer('start');
    updateTray();
  },
  onEnd: async (appName) => {
    send('status', { info: `${appName} call ended` });
    if (isListening) await runInRenderer('stop');
    if (settings().summarizeOnEnd && transcript.length) {
      // give the last audio chunks a moment to finish transcribing
      setTimeout(() => runInRenderer('summarize'), 4000);
    }
    updateTray();
  },
});

function applySettingsSideEffects() {
  const s = settings();
  if (s.detectCalls) callWatcher.start(); else callWatcher.stop();
  setOpenAtLogin(s.openAtLogin);
}

// ---------- tray (menu bar icon) ----------

function updateTray() {
  if (!tray) return;
  const s = settings();
  const profiles = store.getProfiles();
  const call = callWatcher.inCall;
  const menu = Menu.buildFromTemplate([
    { label: call ? `In call: ${call}` : 'No call detected', enabled: false },
    { type: 'separator' },
    { label: win && win.isVisible() ? 'Hide Sidekick' : 'Show Sidekick', accelerator: 'CommandOrControl+\\', click: toggleVisible },
    { label: isListening ? 'Stop listening' : 'Start listening', click: () => { showWindow(); runInRenderer('toggle'); } },
    { type: 'separator' },
    {
      label: 'Context',
      submenu: profiles.map((p) => ({
        label: p.name, type: 'radio', checked: p.id === s.activeProfile,
        click: () => { store.setSettings({ activeProfile: p.id }); pushState(); },
      })),
    },
    { label: 'Auto-answer questions', type: 'checkbox', checked: s.autoAnswer, click: (i) => changeSettings({ autoAnswer: i.checked }) },
    { label: 'Detect calls', type: 'checkbox', checked: s.detectCalls, click: (i) => changeSettings({ detectCalls: i.checked }) },
    { label: 'Run hidden at login (for call detection)', type: 'checkbox', checked: s.openAtLogin, click: (i) => changeSettings({ openAtLogin: i.checked }) },
    { type: 'separator' },
    { label: 'Edit context...', click: () => { showWindow(true); send('open-panel', 'context'); } },
    { label: 'Settings...', click: () => { showWindow(true); send('open-panel', 'settings'); } },
    { label: 'Open notes folder', click: openNotes },
    { type: 'separator' },
    { label: 'Quit Sidekick', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(isListening ? 'Sidekick (listening)' : 'Sidekick');
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  updateTray();
}

function changeSettings(patch) {
  store.setSettings(patch);
  applySettingsSideEffects();
  pushState();
}

// Sends current settings and profiles to the window and refreshes the menu
function pushState() {
  send('state', { settings: store.publicSettings(), profiles: store.getProfiles() });
  updateTray();
}

function openNotes() {
  const dir = store.notesDir();
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('state', () => ({ settings: store.publicSettings(), profiles: store.getProfiles() }));

  ipcMain.handle('settings:set', (_e, patch) => {
    const allowed = ['chatModel', 'transcribeModel', 'chunkSeconds', 'notesDir', 'detectCalls',
      'autoListen', 'summarizeOnEnd', 'autoAnswer', 'openAtLogin', 'activeProfile', 'showTranscript'];
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
    changeSettings(clean);
    return store.publicSettings();
  });

  ipcMain.handle('key:set', (_e, key) => { store.setApiKey(key); pushState(); return store.publicSettings().hasKey; });

  ipcMain.handle('profile:create', () => { const p = store.createProfile(); pushState(); return p; });
  ipcMain.handle('profile:update', (_e, p) => { const r = store.updateProfile(p); updateTray(); return r; });
  ipcMain.handle('profile:delete', (_e, id) => { store.deleteProfile(id); pushState(); });
  ipcMain.handle('profile:addFile', async (_e, id) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Add context files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Documents', extensions: ['pdf', 'txt', 'md'] }],
    });
    if (canceled) return null;
    filePaths.forEach((fp) => store.addFileToProfile(id, fp));
    pushState();
    return true;
  });
  ipcMain.handle('profile:removeFile', (_e, id, filePath) => { store.removeFileFromProfile(id, filePath); pushState(); });

  ipcMain.handle('audio:chunk', async (_e, { who, data, mimeType }) => {
    try {
      const text = await transcribe(Buffer.from(data), mimeType);
      if (!text || /^(thank you\.?|thanks for watching\.?|you\.?)$/i.test(text)) return null;
      const line = { who, text, at: Date.now() };
      transcript.push(line);
      send('transcript:line', line);
      handleAutoAnswer(line);
      return line;
    } catch (err) {
      logError('Transcription', errorText(err));
      send('status', { error: errorText(err) });
      return null;
    }
  });

  ipcMain.handle('ask', (_e, opts) => streamAnswer(opts));

  ipcMain.handle('summarize', async () => {
    try { return await summarize(); } catch (err) { logError('Summary', errorText(err)); return { error: errorText(err) }; }
  });

  ipcMain.handle('clear', () => {
    transcript.length = 0;
    pastAnswers.length = 0;
    sessionStart = new Date();
    clearTimeout(questionTimer);
    questionTimer = null;
  });

  ipcMain.on('listening', (_e, on) => { isListening = on; updateTray(); });
  ipcMain.handle('open-notes', openNotes);
  ipcMain.handle('open-log', () => {
    if (!fs.existsSync(LOG_FILE())) fs.writeFileSync(LOG_FILE(), 'No errors logged yet.\n');
    shell.openPath(LOG_FILE());
  });
  ipcMain.on('hide', () => { win.hide(); updateTray(); });
  ipcMain.on('focus', () => { win.show(); win.focus(); });
  ipcMain.on('quit', () => app.quit());
}

// ---------- hotkeys ----------

function move(dx, dy) {
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
}

function registerShortcuts() {
  const keys = {
    'CommandOrControl+Return': () => { showWindow(); streamAnswer({ includeScreen: true }); },
    'CommandOrControl+Shift+Return': () => { showWindow(); streamAnswer({ includeScreen: false }); },
    'CommandOrControl+\\': toggleVisible,
    'CommandOrControl+Shift+L': () => { showWindow(); runInRenderer('toggle'); },
    'CommandOrControl+Shift+K': () => { showWindow(true); runInRenderer('focusInput'); },
    'CommandOrControl+Shift+A': () => changeSettings({ autoAnswer: !settings().autoAnswer }),
    'CommandOrControl+Shift+M': () => runInRenderer('summarize'),
    'CommandOrControl+Shift+X': () => runInRenderer('clear'),
    'CommandOrControl+Shift+T': () => {
      clickThrough = !clickThrough;
      win.setIgnoreMouseEvents(clickThrough, { forward: true });
      send('status', { info: clickThrough ? 'Click-through on' : 'Click-through off' });
    },
    'CommandOrControl+Up': () => move(0, -40),
    'CommandOrControl+Down': () => move(0, 40),
    'CommandOrControl+Left': () => move(-40, 0),
    'CommandOrControl+Right': () => move(40, 0),
  };
  for (const [accel, fn] of Object.entries(keys)) {
    if (!globalShortcut.register(accel, fn)) console.warn(`Could not register ${accel}`);
  }
}

// ---------- start ----------

app.on('second-instance', () => { if (win) showWindow(true); });

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.dock.hide();
    await systemPreferences.askForMediaAccess('microphone').catch(() => {});
  }
  setupDisplayMedia();
  registerIpc();
  createWindow();
  createTray();
  registerShortcuts();
  applySettingsSideEffects();
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); callWatcher.stop(); });
app.on('window-all-closed', (e) => e.preventDefault()); // keep running in the menu bar
