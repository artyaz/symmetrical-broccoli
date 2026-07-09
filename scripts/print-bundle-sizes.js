#!/usr/bin/env node
// print-bundle-sizes.js — Inspect dist/ and report the entry chunk size.
// Run after `vite build`. Useful for verifying the <14kb initial-load target.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const distDir = join(process.cwd(), 'dist');
const KB = 1024;
const fmt = (b) => `${(b / KB).toFixed(1)}kb`;

try {
  const assetsDir = join(distDir, 'assets');
  const files = readdirSync(assetsDir);
  const rows = files.map((f) => {
    const fp = join(assetsDir, f);
    const size = statSync(fp).size;
    const gz = gzipSync(readFileSync(fp)).length;
    return { name: f, size, gz };
  });
  rows.sort((a, b) => a.gz - b.gz);

  console.log('\nBundle sizes (sorted by gzip size):\n');
  console.log('  size      gzip     file');
  console.log('  --------  -------  --------------------------------');
  for (const r of rows) {
    console.log(`  ${fmt(r.size).padStart(8)}  ${fmt(r.gz).padStart(7)}  ${r.name}`);
  }

  const entry = rows.find((r) => /^index-.*\.js$/.test(r.name)) || rows.find((r) => /^main-.*\.js$/.test(r.name));
  if (entry) {
    console.log(`\nEntry chunk: ${entry.name}`);
    console.log(`  raw:   ${fmt(entry.size)}`);
    console.log(`  gzip:  ${fmt(entry.gz)}`);
    if (entry.gz < 14 * KB) console.log(`  OK - under 14kb gzip target.`);
    else console.log(`  WARN - over 14kb gzip target.`);
  }

  const total = rows.reduce((acc, r) => acc + r.size, 0);
  const totalGz = rows.reduce((acc, r) => acc + r.gz, 0);
  console.log(`\nTotal: ${fmt(total)} raw, ${fmt(totalGz)} gzipped, ${rows.length} chunks.\n`);
} catch (e) {
  console.error('Could not read dist/:', e.message);
  process.exit(1);
}
