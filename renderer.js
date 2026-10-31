const $ = (id) => document.getElementById(id);
const api = window.sidekick;

let state = { settings: {}, profiles: [] };
let listening = false;
let tracks = [];
let answerText = '';
let editingId = null;

// Below this peak level a chunk counts as silence and isn't sent
const SILENCE_PEAK = 0.02;

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg || '';
  el.classList.toggle('error', isError);
  if (msg && !isError) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
}

function pickMime() {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return options.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

// ---------- audio ----------

// One audio source (mic or system) recorded in short standalone chunks
class AudioTrack {
  constructor(who, stream, meterEl, keepAlive) {
    this.who = who;
    this.stream = stream;
    this.meterEl = meterEl;
    this.keepAlive = keepAlive;
    this.mime = pickMime();
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.samples = new Float32Array(this.analyser.fftSize);
    this.peak = 0;
    this.meterTimer = setInterval(() => this.measure(), 100);
    this.active = true;
    this.cycle();
  }

  measure() {
    this.analyser.getFloatTimeDomainData(this.samples);
    let max = 0;
    for (const s of this.samples) max = Math.max(max, Math.abs(s));
    this.peak = Math.max(this.peak, max);
    this.meterEl.style.setProperty('--lvl', `${Math.min(100, max * 300)}%`);
  }

  cycle() {
    if (!this.active) return;
    const chunks = [];
    this.peak = 0;
    const rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      const peak = this.peak;
      if (this.active) this.cycle(); // start the next chunk right away
      if (!chunks.length || peak < SILENCE_PEAK) return;
      const blob = new Blob(chunks, { type: rec.mimeType });
      api.sendChunk(this.who, await blob.arrayBuffer(), rec.mimeType);
    };
    rec.start();
    this.recorder = rec;
    const secs = Number(state.settings.chunkSeconds) || 5;
    setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, secs * 1000);
  }

  stop() {
    this.active = false;
    clearInterval(this.meterTimer);
    if (this.recorder && this.recorder.state === 'recording') this.recorder.stop();
    this.stream.getTracks().forEach((t) => t.stop());
    if (this.keepAlive) this.keepAlive.getTracks().forEach((t) => t.stop());
    this.ctx.close();
    this.meterEl.style.setProperty('--lvl', '0%');
  }
}

async function startListening() {
  if (listening) return;
  tracks = [];
  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    tracks.push(new AudioTrack('You', mic, $('meterYou')));
  } catch (err) {
    setStatus(`Mic blocked: ${err.message}. Check System Settings > Privacy > Microphone.`, true);
  }

  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    display.getVideoTracks().forEach((t) => { t.enabled = false; });
    const audio = display.getAudioTracks();
    if (audio.length) {
      tracks.push(new AudioTrack('Them', new MediaStream(audio), $('meterThem'), display));
    } else {
      display.getTracks().forEach((t) => t.stop());
      setStatus('No system audio. Turn on Screen Recording for Sidekick, then reopen it.', true);
    }
  } catch (err) {
    setStatus(`System audio off: ${err.message}. Turn on Screen Recording for Sidekick, then reopen it.`, true);
  }

  if (!tracks.length) return;
  listening = true;
  api.setListening(true);
  $('dot').classList.add('live');
  $('listenBtn').classList.add('on');
  $('listenBtn').textContent = 'Stop';
  if ($('transcript').querySelector('.muted')) $('transcript').innerHTML = '';
  setStatus('Listening');
}

function stopListening() {
  if (!listening) return;
  tracks.forEach((t) => t.stop());
  tracks = [];
  listening = false;
  api.setListening(false);
  $('dot').classList.remove('live');
  $('listenBtn').classList.remove('on');
  $('listenBtn').textContent = 'Listen';
  setStatus('Stopped listening');
}

function toggleListening() {
  return listening ? stopListening() : startListening();
}

// ---------- answers ----------

function renderMarkdown(text) {
  return window.marked ? window.marked.parse(text) : text.replace(/</g, '&lt;');
}

function ask(question = '') {
  showView('main');
  api.ask({ question, includeScreen: $('useScreen').checked });
}

async function summarize() {
  showView('main');
  $('answerLabel').textContent = 'Summary';
  $('answer').innerHTML = '<p class="muted">Summarizing...</p>';
  const res = await api.summarize();
  if (res.error) {
    $('answer').innerHTML = `<p class="muted">${res.error}</p>`;
    return;
  }
  $('answer').innerHTML = renderMarkdown(res.summary);
  setStatus(`Notes saved to ${res.file}`);
}

async function clearSession(quiet = false) {
  await api.clear();
  $('transcript').innerHTML = '';
  $('answer').innerHTML = '';
  $('answerLabel').textContent = 'Answer';
  if (!quiet) setStatus('Session cleared');
}

// ---------- views ----------

function showView(name) {
  $('mainView').classList.toggle('hidden', name !== 'main');
  $('contextView').classList.toggle('hidden', name !== 'context');
  $('settingsView').classList.toggle('hidden', name !== 'settings');
  $('menu').classList.add('hidden');
  if (name === 'context') renderContextEditor(state.settings.activeProfile);
  if (name === 'settings') renderSettings();
  if (name !== 'main') api.focus();
}

// ---------- state ----------

function applyState(next) {
  state = next;
  const { settings, profiles } = state;

  const sel = $('profileSelect');
  sel.innerHTML = '';
  profiles.forEach((p) => sel.add(new Option(p.name, p.id, false, p.id === settings.activeProfile)));

  $('autoBtn').classList.toggle('on', Boolean(settings.autoAnswer));
  $('transcriptWrap').classList.toggle('hidden', !settings.showTranscript);
  $('toggleTranscriptBtn').textContent = settings.showTranscript ? 'Hide transcript' : 'Show transcript';

  if (!$('contextView').classList.contains('hidden')) renderContextEditor(editingId);
  if (!$('settingsView').classList.contains('hidden')) renderSettings(true);

  if (!settings.hasKey) setStatus('Add your OpenAI key in ⋯ > Settings to get started.', true);
}

// ---------- context editor ----------

function renderContextEditor(id) {
  const { profiles } = state;
  const p = profiles.find((x) => x.id === id) || profiles[0];
  editingId = p.id;

  const sel = $('ctxSelect');
  sel.innerHTML = '';
  profiles.forEach((x) => sel.add(new Option(x.name, x.id, false, x.id === p.id)));

  if (document.activeElement !== $('ctxName')) $('ctxName').value = p.name;
  if (document.activeElement !== $('ctxNotes')) $('ctxNotes').value = p.notes;
  $('ctxDelete').disabled = profiles.length <= 1;

  const list = $('ctxFiles');
  list.innerHTML = '';
  if (!p.files.length) list.innerHTML = '<li class="muted">No files yet. Add your resume or notes.</li>';
  p.files.forEach((f) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = f.name;
    const rm = document.createElement('button');
    rm.textContent = 'Remove';
    rm.onclick = () => api.removeFile(p.id, f.path);
    li.append(name, rm);
    list.append(li);
  });
}

let saveTimer = null;
function queueContextSave() {
  clearTimeout(saveTimer);
  $('ctxSaved').textContent = 'Saving...';
  saveTimer = setTimeout(async () => {
    const updated = await api.updateProfile({ id: editingId, name: $('ctxName').value, notes: $('ctxNotes').value });
    if (updated) {
      const i = state.profiles.findIndex((x) => x.id === updated.id);
      if (i >= 0) state.profiles[i] = updated;
      applyState(state);
    }
    $('ctxSaved').textContent = 'Saved';
  }, 500);
}

// ---------- settings ----------

function renderSettings(keepFocused = false) {
  const s = state.settings;
  document.querySelectorAll('[data-setting]').forEach((el) => {
    if (keepFocused && document.activeElement === el) return;
    const k = el.dataset.setting;
    if (el.type === 'checkbox') el.checked = Boolean(s[k]);
    else el.value = s[k] ?? '';
  });
  $('keyStatus').textContent = s.hasKey ? 'Key saved. Paste a new one to replace it.' : 'No key saved yet.';
}

document.querySelectorAll('[data-setting]').forEach((el) => {
  el.addEventListener('change', async () => {
    const k = el.dataset.setting;
    const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
    await api.setSettings({ [k]: value });
    setStatus('Saved');
  });
});

$('keySave').onclick = async () => {
  const v = $('keyInput').value.trim();
  if (!v) return;
  const ok = await api.setKey(v);
  $('keyInput').value = '';
  $('keyStatus').textContent = ok ? 'Key saved.' : 'Could not save the key.';
};

// ---------- events from main ----------

api.on('state', applyState);

api.on('transcript:line', ({ who, text }) => {
  if (who === 'You') return; // my own words still help answers, but don't need to be shown
  const el = $('transcript');
  const p = document.createElement('p');
  const name = document.createElement('span');
  name.className = `who ${who}`;
  name.textContent = `${who}:`;
  p.append(name, document.createTextNode(` ${text}`));
  el.append(p);
  el.scrollTop = el.scrollHeight;
});

api.on('answer:start', ({ question }) => {
  showView('main');
  answerText = '';
  $('answerLabel').textContent = question.length > 80 ? `${question.slice(0, 80)}...` : question;
  $('answer').innerHTML = '<p class="muted">Writing your answer...</p>';
});

api.on('answer:delta', (delta) => {
  answerText += delta;
  $('answer').innerHTML = renderMarkdown(answerText);
  $('answer').scrollTop = $('answer').scrollHeight;
});

api.on('answer:done', () => {});
api.on('answer:error', (msg) => { $('answer').innerHTML = `<p class="muted">${msg}</p>`; });
api.on('status', ({ error, info }) => setStatus(error || info, Boolean(error)));
api.on('open-panel', (name) => showView(name));

// Actions main can trigger with a user gesture (needed to start audio capture)
window.__sk = {
  start: startListening,
  stop: stopListening,
  toggle: toggleListening,
  summarize,
  clear: () => clearSession(),
  newSession: () => clearSession(true),
  focusInput: () => { showView('main'); $('question').focus(); },
};

// ---------- UI wiring ----------

$('listenBtn').onclick = toggleListening;
$('askBtn').onclick = () => ask($('question').value.trim());
$('autoBtn').onclick = () => api.setSettings({ autoAnswer: !state.settings.autoAnswer });
$('moreBtn').onclick = () => $('menu').classList.toggle('hidden');
$('profileSelect').onchange = (e) => api.setSettings({ activeProfile: e.target.value });
$('summaryBtn').onclick = summarize;
$('notesBtn').onclick = () => { $('menu').classList.add('hidden'); api.openNotes(); };
$('clearBtn').onclick = () => { $('menu').classList.add('hidden'); clearSession(); };
$('hideBtn').onclick = () => { $('menu').classList.add('hidden'); api.hide(); };
$('quitBtn').onclick = () => api.quit();
$('toggleTranscriptBtn').onclick = () => {
  $('menu').classList.add('hidden');
  api.setSettings({ showTranscript: !state.settings.showTranscript });
};
document.querySelectorAll('[data-panel]').forEach((b) => { b.onclick = () => showView(b.dataset.panel); });
document.querySelectorAll('.close-panel').forEach((b) => { b.onclick = () => showView('main'); });

$('ctxSelect').onchange = (e) => renderContextEditor(e.target.value);
$('ctxNew').onclick = async () => {
  const p = await api.createProfile();
  if (!state.profiles.find((x) => x.id === p.id)) state.profiles.push(p);
  renderContextEditor(p.id);
  $('ctxName').focus();
  $('ctxName').select();
};
$('ctxDelete').onclick = () => {
  const p = state.profiles.find((x) => x.id === editingId);
  if (p && confirm(`Delete the "${p.name}" context and its files?`)) api.deleteProfile(editingId);
};
$('ctxName').oninput = queueContextSave;
$('ctxNotes').oninput = queueContextSave;
$('ctxAddFile').onclick = () => api.addFile(editingId);

$('askForm').onsubmit = (e) => {
  e.preventDefault();
  const q = $('question').value.trim();
  ask(q);
  $('question').value = '';
};

api.getState().then(applyState);
