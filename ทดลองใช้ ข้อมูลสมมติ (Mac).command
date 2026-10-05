#!/bin/bash
# Lesson Plan System for macOS - DEMO with sample data (real data is not touched)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed on this Mac."
  echo "Please install Node.js 24 LTS from https://nodejs.org then open this file again."
  read -r -p "Press Enter to close"
  exit 1
fi
if [ ! -d "node_modules/express" ] || [ ! -d "node_modules/pdf-lib" ]; then
  echo "First run: downloading the required files. This needs internet and takes about 1 minute."
  if ! npm install; then
    echo "Could not download the required files. Check the internet connection and try again."
    read -r -p "Press Enter to close"
    exit 1
  fi
fi
if [ ! -f "data-demo/app.db" ]; then
  echo "Creating sample school data..."
  node --disable-warning=ExperimentalWarning scripts/seed-demo.js
fi
echo "DEMO mode: all names are fictional. Real data is not touched."
echo "To start the demo fresh, delete the folder data-demo and open this file again."
node --disable-warning=ExperimentalWarning server.js --data data-demo --demo --port 3100 --open
read -r -p "Press Enter to close"
