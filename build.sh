#!/bin/bash
set -e

echo "=== Exporting production D1 data ==="
npx wrangler d1 export my-emdash-site --remote --output=dump.sql

echo "=== Loading data into local D1 ==="
npx wrangler d1 execute my-emdash-site --local --file=dump.sql

echo "=== Running astro build ==="
npm run build
