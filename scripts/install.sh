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

# Sign with the personal certificate so macOS keeps permissions across updates.
# Falls back to a throwaway signature if the certificate can't be set up.
SIGN_NAME="Sidekick Local Signing"
bash scripts/setup-signing.sh || echo "Couldn't set up the signing certificate. Using a temporary signature."
if security find-certificate -c "$SIGN_NAME" >/dev/null 2>&1 && \
   codesign --force --deep --sign "$SIGN_NAME" "$APP" 2>/dev/null; then
  echo "Signed with your personal certificate."
else
  codesign --force --deep --sign - "$APP"
  echo "Signed with a temporary signature (permissions may reset after updates)."
fi

# Close the old one if it's running, then replace it
osascript -e 'quit app "Sidekick"' 2>/dev/null || true
pkill -x Sidekick 2>/dev/null || true
sleep 1
rm -rf /Applications/Sidekick.app
cp -R "$APP" /Applications/
xattr -cr /Applications/Sidekick.app

# Remove the build copy so only the installed app shows up in Spotlight
rm -rf dist

echo ""
echo "Installed to /Applications/Sidekick.app"
open /Applications/Sidekick.app
