#!/bin/bash
# Lesson Plan System for macOS - keep this window open while teachers use the system
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed on this Mac."
  echo "Please install Node.js 24 LTS from https://nodejs.org then open this file again."
  read -r -p "Press Enter to close"
  exit 1
fi
if [ ! -d "node_modules/express" ] || [ ! -d "node_modules/eslint-scope" ]; then
  echo "First run: downloading the required files. This needs internet and takes about 1 minute."
  if ! npm install; then
    echo "Could not download the required files. Check the internet connection and try again."
    read -r -p "Press Enter to close"
    exit 1
  fi
fi
echo "Starting the lesson plan system..."
echo "Keep this window open. Close it to stop the system."
node --disable-warning=ExperimentalWarning server.js --open "$@"
read -r -p "Press Enter to close"
