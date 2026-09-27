#!/bin/sh
# Bundles src.js with React into ../react_ssr.js, one plain script (no imports) that Node,
# QuickJS and Porffor all run. React's edge server build: no Node APIs.
#   npm install --no-save react@19.3.0 react-dom@19.3.0 esbuild  (in this directory, once)
#   ./build.sh
cd "$(dirname "$0")" && npx esbuild src.js --bundle --format=iife --platform=neutral \
  --conditions=edge-light --main-fields=module,main \
  --define:process.env.NODE_ENV='"production"' --minify-syntax \
  --outfile=../react_ssr.js
