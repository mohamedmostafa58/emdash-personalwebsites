#!/bin/bash
set -e

echo "=== Syncing production D1 data for prerendering ==="

# Get all non-FTS table names
TABLES=$(npx wrangler d1 execute my-emdash-site --remote --json \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_fts%' AND name NOT LIKE '%_content' AND name NOT LIKE '%_docsize' AND name NOT LIKE '%_idx' AND name NOT LIKE '%_config' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'" \
  2>/dev/null | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const rows = d[0]?.results || [];
    rows.forEach(r => console.log(r.name));
  ")

echo "Found tables: $TABLES"

# For each table: get CREATE statement and data, execute locally
for TABLE in $TABLES; do
  echo "  Syncing: $TABLE"

  # Get CREATE TABLE statement
  CREATE=$(npx wrangler d1 execute my-emdash-site --remote --json \
    --command "SELECT sql FROM sqlite_master WHERE name='$TABLE'" \
    2>/dev/null | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const sql = d[0]?.results?.[0]?.sql || '';
      if (sql) console.log(sql + ';');
    ")

  if [ -z "$CREATE" ]; then
    echo "    Skipping (no schema)"
    continue
  fi

  # Create table locally (IF NOT EXISTS to be safe)
  SAFE_CREATE=$(echo "$CREATE" | sed 's/CREATE TABLE/CREATE TABLE IF NOT EXISTS/')
  npx wrangler d1 execute my-emdash-site --local --command "$SAFE_CREATE" 2>/dev/null || true

  # Get row count
  COUNT=$(npx wrangler d1 execute my-emdash-site --remote --json \
    --command "SELECT COUNT(*) as c FROM \"$TABLE\"" \
    2>/dev/null | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log(d[0]?.results?.[0]?.c || 0);
    ")

  if [ "$COUNT" = "0" ]; then
    echo "    Empty table, skipping data"
    continue
  fi

  echo "    Copying $COUNT rows..."

  # Export data as JSON, convert to INSERT statements, run locally
  npx wrangler d1 execute my-emdash-site --remote --json \
    --command "SELECT * FROM \"$TABLE\"" \
    2>/dev/null | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const rows = d[0]?.results || [];
      if (!rows.length) process.exit(0);
      const cols = Object.keys(rows[0]);
      const colList = cols.map(c => '\"' + c + '\"').join(',');
      // Write SQL file
      const fs = require('fs');
      let sql = '';
      for (const row of rows) {
        const vals = cols.map(c => {
          const v = row[c];
          if (v === null || v === undefined) return 'NULL';
          if (typeof v === 'number') return v;
          return \"'\" + String(v).replace(/'/g, \"''\") + \"'\";
        }).join(',');
        sql += 'INSERT OR REPLACE INTO \"$TABLE\" (' + colList + ') VALUES (' + vals + ');\n';
      }
      fs.writeFileSync('/tmp/insert_$TABLE.sql', sql);
    " && \
  npx wrangler d1 execute my-emdash-site --local --file="/tmp/insert_$TABLE.sql" 2>/dev/null || true
done

echo "=== D1 sync complete ==="
echo "=== Running astro build ==="
npm run build:ssr
