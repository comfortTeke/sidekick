// Settings, API key, and context profiles, saved in the app's data folder
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, safeStorage } = require('electron');

const DEFAULT_SETTINGS = {
  chatModel: process.env.CHAT_MODEL || 'gpt-5.6-sol',
  transcribeModel: process.env.TRANSCRIBE_MODEL || 'gpt-transcribe',
  chunkSeconds: Number(process.env.CHUNK_SECONDS || 5),
  notesDir: '~/Documents/Sidekick',
  detectCalls: true,
  autoListen: true,
  summarizeOnEnd: true,
  autoAnswer: true,
  showTranscript: false,
  settingsVersion: 2,
  openAtLogin: true,
  activeProfile: 'general',
  encryptedKey: '',
};

const dataDir = () => app.getPath('userData');
const filesDir = () => path.join(dataDir(), 'context-files');

function readJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), name), 'utf8')); } catch { return fallback; }
}

function writeJSON(name, data) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(path.join(dataDir(), name), JSON.stringify(data, null, 2));
}

// ---------- settings ----------

let settings = null;

function getSettings() {
  if (!settings) {
    const saved = readJSON('settings.json', {});
    settings = { ...DEFAULT_SETTINGS, ...saved };
    // v2: answers come automatically and the transcript is hidden by default
    if ((saved.settingsVersion || 1) < 2) {
      settings = { ...settings, autoAnswer: true, showTranscript: false, settingsVersion: 2 };
      writeJSON('settings.json', settings);
    }
  }
  return settings;
}

function setSettings(patch) {
  settings = { ...getSettings(), ...patch };
  writeJSON('settings.json', settings);
  return settings;
}

// What the renderer is allowed to see (never the key itself)
function publicSettings() {
  const { encryptedKey, ...rest } = getSettings();
  return { ...rest, hasKey: Boolean(getApiKey()) };
}

function notesDir() {
  return getSettings().notesDir.replace(/^~/, os.homedir());
}

// ---------- API key ----------

function setApiKey(key) {
  const clean = (key || '').trim();
  if (!clean) return setSettings({ encryptedKey: '' });
  const stored = safeStorage.isEncryptionAvailable()
    ? 'enc:' + safeStorage.encryptString(clean).toString('base64')
    : 'raw:' + clean;
  return setSettings({ encryptedKey: stored });
}

function getApiKey() {
  const stored = getSettings().encryptedKey;
  if (stored.startsWith('enc:')) {
    try { return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64')); } catch { return ''; }
  }
  if (stored.startsWith('raw:')) return stored.slice(4);
  return process.env.OPENAI_API_KEY || '';
}

// ---------- context profiles ----------

const DEFAULT_PROFILES = [
  { id: 'general', name: 'General', notes: '', files: [] },
];

let profiles = null;

function getProfiles() {
  if (!profiles) profiles = readJSON('profiles.json', DEFAULT_PROFILES);
  if (!profiles.length) profiles = [...DEFAULT_PROFILES];
  return profiles;
}

function saveProfiles() { writeJSON('profiles.json', profiles); }

function activeProfile() {
  const list = getProfiles();
  return list.find((p) => p.id === getSettings().activeProfile) || list[0];
}

function createProfile(name = 'New context') {
  const p = { id: `p${Date.now()}`, name, notes: '', files: [] };
  getProfiles().push(p);
  saveProfiles();
  setSettings({ activeProfile: p.id });
  return p;
}

function updateProfile({ id, name, notes }) {
  const p = getProfiles().find((x) => x.id === id);
  if (!p) return null;
  if (typeof name === 'string') p.name = name.trim() || 'Untitled';
  if (typeof notes === 'string') p.notes = notes;
  saveProfiles();
  return p;
}

function deleteProfile(id) {
  const p = getProfiles().find((x) => x.id === id);
  if (!p) return;
  p.files.forEach((f) => { try { fs.unlinkSync(f.path); } catch {} });
  profiles = getProfiles().filter((x) => x.id !== id);
  saveProfiles();
  if (getSettings().activeProfile === id) setSettings({ activeProfile: getProfiles()[0].id });
}

function addFileToProfile(id, sourcePath) {
  const p = getProfiles().find((x) => x.id === id);
  if (!p) return null;
  fs.mkdirSync(filesDir(), { recursive: true });
  const name = path.basename(sourcePath);
  const dest = path.join(filesDir(), `${id}-${Date.now()}-${name}`);
  fs.copyFileSync(sourcePath, dest);
  p.files.push({ name, path: dest });
  saveProfiles();
  return p;
}

function removeFileFromProfile(id, filePath) {
  const p = getProfiles().find((x) => x.id === id);
  if (!p) return null;
  try { fs.unlinkSync(filePath); } catch {}
  p.files = p.files.filter((f) => f.path !== filePath);
  saveProfiles();
  return p;
}

// Turns the active profile into pieces for the AI request
function contextForPrompt() {
  const p = activeProfile();
  let text = '';
  const attachments = [];
  if (p.notes.trim()) text += `Notes and instructions:\n${p.notes.trim()}\n\n`;
  for (const f of p.files) {
    const ext = path.extname(f.name).toLowerCase();
    try {
      if (ext === '.pdf') {
        const data = fs.readFileSync(f.path).toString('base64');
        attachments.push({ type: 'input_file', filename: f.name, file_data: `data:application/pdf;base64,${data}` });
      } else {
        const body = fs.readFileSync(f.path, 'utf8').slice(0, 40000);
        text += `File "${f.name}":\n${body}\n\n`;
      }
    } catch { /* file was moved or deleted */ }
  }
  return { name: p.name, text: text.trim(), attachments };
}

module.exports = {
  getSettings, setSettings, publicSettings, notesDir,
  setApiKey, getApiKey,
  getProfiles, activeProfile, createProfile, updateProfile, deleteProfile,
  addFileToProfile, removeFileFromProfile, contextForPrompt,
};
