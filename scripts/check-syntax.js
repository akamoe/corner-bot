#!/usr/bin/env node
/** `node --check` every JS file in the repo (no test runner needed). */

import { readdirSync, statSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP = new Set(['node_modules', '.git', '.vercel', 'graphify-out'])

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

const files = walk(root)
let failed = 0

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (err) {
    failed++
    console.error(`❌ ${file.replace(root + '/', '')}`)
    console.error(String(err.stderr || err.message).trim())
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed to parse.`)
  process.exit(1)
}
console.log(`✅ ${files.length} files parsed cleanly.`)
