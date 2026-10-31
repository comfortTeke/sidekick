// Watches for an active call by checking open window titles and the Zoom meeting process
const { execFile } = require('child_process');
const { desktopCapturer } = require('electron');

// Window titles that only show up while you're actually in a call
const CALL_PATTERNS = [
  { app: 'Zoom', re: /^Zoom Meeting|^Zoom Webinar|Zoom Workplace.*Meeting/i },
  { app: 'Google Meet', re: /\bMeet - [a-z]{3}-[a-z]{4}-[a-z]{3}\b|^Meet - /i },
  { app: 'Microsoft Teams', re: /(meeting|call).*Microsoft Teams|Microsoft Teams.*(meeting|call)/i },
  { app: 'Webex', re: /Webex.*(meeting|personal room)|meeting.*Webex/i },
  { app: 'Slack huddle', re: /\bhuddle\b/i },
];

function zoomMeetingRunning() {
  // CptHost only runs while a Zoom meeting is active
  return new Promise((resolve) => {
    execFile('pgrep', ['-x', 'CptHost'], (err, out) => resolve(!err && out.trim().length > 0));
  });
}

async function findCall() {
  if (process.platform === 'darwin' && await zoomMeetingRunning()) return 'Zoom';
  let sources = [];
  try {
    sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
  } catch { return null; }
  for (const s of sources) {
    if (/sidekick/i.test(s.name)) continue;
    const hit = CALL_PATTERNS.find((p) => p.re.test(s.name));
    if (hit) return hit.app;
  }
  return null;
}

// Calls onStart(appName) and onEnd(appName). A call has to be missing
// for two checks in a row before it counts as ended, so it doesn't flicker.
function createCallWatcher({ onStart, onEnd, intervalMs = 4000 }) {
  let timer = null;
  let current = null;
  let misses = 0;
  let busy = false;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const found = await findCall();
      if (found && !current) {
        current = found;
        misses = 0;
        onStart(found);
      } else if (found) {
        misses = 0;
      } else if (current && ++misses >= 2) {
        const ended = current;
        current = null;
        misses = 0;
        onEnd(ended);
      }
    } finally {
      busy = false;
    }
  }

  return {
    start() { if (!timer) { timer = setInterval(tick, intervalMs); tick(); } },
    stop() { clearInterval(timer); timer = null; current = null; misses = 0; },
    get inCall() { return current; },
  };
}

module.exports = { createCallWatcher, CALL_PATTERNS };
