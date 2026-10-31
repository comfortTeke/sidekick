# Sidekick

A personal AI overlay for Mac. It listens to your mic and your computer's audio, transcribes both live, reads your screen when you ask, and answers using your own context (resume, notes, job descriptions). The window stays on top and doesn't show up in screen shares. It notices when you join a call and starts on its own.

Built with Electron and the OpenAI API.

## Install

In Terminal:

```
cd ~/Projects
git clone https://github.com/<your-username>/sidekick.git
cd sidekick
npm install
npm run install-app
```

That builds Sidekick.app, puts it in your Applications folder, and opens it. After that you never need Terminal again. Sidekick lives in your menu bar (the sparkle icon). It starts hidden at login and only pops up when a call starts or when you press Cmd+\.

### Updating

From this folder:

```
npm run update
```

That pulls the latest code from GitHub, installs packages, and reinstalls the app.

### First launch

1. Click ⋯ > **Settings** and paste your OpenAI key. It's stored encrypted in your Mac's keychain.
2. Allow the microphone when asked.
3. Turn on **Screen Recording** for Sidekick: System Settings > Privacy & Security > Screen & System Audio Recording. Quit Sidekick from the menu bar and open it again.
4. Click ⋯ > **Edit context** and add your first context.

Every reinstall gives the app a new local signature, so macOS may ask for mic and Screen Recording permission again.

## Context

A context is everything Sidekick should know for a situation. Make one per situation, like "Wikimedia interview," "CoServ standup," or "Algorithms lecture." Each one has:

- **Notes and instructions:** paste anything. Your background, talking points, a job description, or instructions like "keep answers short and casual."
- **Files:** PDFs, .txt, or .md files like your resume.

Switch contexts from the dropdown at the top of the window or from the menu bar icon. Every answer uses whichever one is active.

When a question is about you, Sidekick answers in first person using only what's in your context. It won't make up experience you don't have.

## Calls

With **Detect calls** on, Sidekick checks every few seconds for a Zoom meeting, a Google Meet tab, a Teams meeting, Webex, or a Slack huddle. When one starts it pops up, starts a fresh session, and starts listening. When the call ends it stops listening, writes a summary, and saves notes.

Google Meet is detected from the tab title, so the Meet tab needs to be the active tab in its window.

## Ask vs. Auto

- **Ask** (or Cmd+Enter) answers right now using your screen, the conversation, and your context.
- **Auto** (or Cmd+Shift+A) answers on its own. When the other person asks a question, Sidekick waits until they stop talking, then answers it using your context.

## Shortcuts

| Keys | What it does |
|---|---|
| Cmd+Enter | Answer using screen + conversation + context |
| Cmd+Shift+Enter | Answer using conversation + context (no screenshot) |
| Cmd+Shift+A | Turn Auto on/off |
| Cmd+Shift+K | Type a question |
| Cmd+Shift+L | Start or stop listening |
| Cmd+\ | Hide or show the window |
| Cmd+Shift+T | Click-through on/off |
| Cmd+Arrow keys | Move the window |
| Cmd+Shift+M | Summarize the session and save notes |
| Cmd+Shift+X | Clear the session |

Notes save to `~/Documents/Sidekick` as Markdown files.

## Running without installing

`npm start` still works for testing changes. In that mode it reads the key from `.env` if you haven't saved one in Settings, and permissions belong to Terminal instead of the app.

## How it works

- **main.js** runs the overlay window (always on top, `setContentProtection` so it's hidden from capture), the menu bar icon, global shortcuts, screenshots, auto-answer, and the OpenAI calls.
- **calls.js** detects calls from window titles and the Zoom meeting process.
- **store.js** saves settings, the encrypted API key, and context profiles in the app's data folder.
- **renderer.js** records the mic ("You") and system audio ("Them") in short chunks, skips silent ones, and runs the UI.
- Answers go through the OpenAI Responses API with the last 3 minutes of transcript, your active context (PDFs are sent as files), and a screenshot when asked.

## Troubleshooting

- **"Sidekick can't be opened" or "is damaged":** run `xattr -cr /Applications/Sidekick.app` in Terminal, then open it again.
- **Model not found:** change the models in Settings > Advanced to ones your account has.
- **"Them" never moves:** Screen Recording isn't on for Sidekick yet, or you need to quit and reopen it after turning it on.
- **A call isn't detected:** tell me the app and what the window title says, and I'll add it.
