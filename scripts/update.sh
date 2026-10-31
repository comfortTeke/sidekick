#!/bin/bash
# Pulls the latest Sidekick from GitHub and reinstalls the app
set -e
cd "$(dirname "$0")/.."

echo "Getting the latest version..."
git pull --ff-only

echo "Installing packages..."
npm install --silent

bash scripts/install.sh
