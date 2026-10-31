#!/bin/bash
# Builds Sidekick.app and installs it into /Applications
set -e
cd "$(dirname "$0")/.."

echo "Building Sidekick.app (takes a minute the first time)..."
npx electron-builder --mac dir --publish never

APP=$(ls -d dist/mac*/Sidekick.app | head -1)
if [ -z "$APP" ]; then
  echo "Build failed: Sidekick.app not found in dist/"
  exit 1
fi

# Local signature so macOS will run it on this Mac
codesign --force --deep --sign - "$APP"

# Close the old one if it's running, then replace it
osascript -e 'quit app "Sidekick"' 2>/dev/null || true
pkill -x Sidekick 2>/dev/null || true
sleep 1
rm -rf /Applications/Sidekick.app
cp -R "$APP" /Applications/
xattr -cr /Applications/Sidekick.app

echo ""
echo "Installed to /Applications/Sidekick.app"
open /Applications/Sidekick.app
