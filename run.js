/**
 * One-shot runner with Discord notifications for start / no games / errors.
 *
 * Success notifications (✅) are already sent by util.notify() in each platform script.
 * This file handles only: container start, no games, error + screenshot.
 *
 * Usage: node run.js <script1> <script2> ...
 * Example: node run.js prime-gaming gog epic-games aliexpress
 */

import { spawn }                          from 'node:child_process';
import { readFile, readdir, stat }        from 'node:fs/promises';
import path                               from 'node:path';
import logger                             from './src/logger.js';
import {
  notifyOnline,
  notifyEmpty,
  notifyErrorWithScreenshot,
} from './src/discord.js';

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------
const NAMES = {
  'prime-gaming': 'Prime Gaming',
  'epic-games':   'Epic Games',
  'gog':          'GOG',
  'steam-games':  'Steam',
  'aliexpress':   'AliExpress',
};

const DB_FILES = {
  'prime-gaming': 'prime-gaming.json',
  'epic-games':   'epic-games.json',
  'gog':          'gog.json',
  'steam-games':  'steam.json',
  'aliexpress':   null,
};

// Scripts that exit with code != 0 even when successful (upstream quirk).
// For these, != 0 is treated as "nothing to claim" rather than an error.
const NONZERO_IS_EMPTY = new Set(['aliexpress']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count games with 'claimed' status in the lowdb JSON file. */
const countClaimed = async (file) => {
  if (!file) return 0;
  try {
    const raw = await readFile(path.resolve('data', file), 'utf8');
    const db  = JSON.parse(raw);
    return (db.games || []).filter(g => g.status === 'claimed').length;
  } catch {
    return 0;
  }
};

/** Find the newest screenshot .png saved after `afterMs`. */
const findRecentScreenshot = async (afterMs) => {
  const dir = path.resolve('data', 'screenshots');
  try {
    const files = await readdir(dir);
    const pngs  = files.filter(f => f.endsWith('.png'));
    const stats = await Promise.all(
      pngs.map(async f => {
        const full = path.join(dir, f);
        const s    = await stat(full);
        return { path: full, mtime: s.mtimeMs };
      })
    );
    const newest = stats
      .filter(s => s.mtime >= afterMs)
      .sort((a, b) => b.mtime - a.mtime)[0];
    return newest?.path || null;
  } catch {
    return null;
  }
};

/** Run platform script, return exit code. */
const runScript = (script) => new Promise(resolve => {
  const proc = spawn('node', [`${script}.js`], { stdio: 'inherit', env: process.env });
  proc.on('exit',  code => resolve(code ?? 1));
  proc.on('error', err  => { logger.error(`Process error: ${err.message}`); resolve(1); });
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const scripts = process.argv.slice(2);

if (scripts.length === 0) {
  logger.error('Usage: node run.js <script1> <script2> ...');
  logger.error('Example: node run.js prime-gaming gog epic-games aliexpress');
  process.exit(1);
}

const platforms = scripts.map(s => NAMES[s] || s);
logger.info(`Platforms: ${platforms.join(', ')}`);

// 1. Container start notification
await notifyOnline(platforms).catch(() => {});

// Create an array to hold the names of platforms that had no games
const emptyPlatforms = [];

// 2. Process each platform sequentially
for (const script of scripts) {
  const name      = NAMES[script] || script;
  const dbFile    = DB_FILES[script];
  const startTime = Date.now();

  const countBefore = await countClaimed(dbFile);
  logger.info(`→ ${name}`);

  const code       = await runScript(script);
  const countAfter = await countClaimed(dbFile);
  const newGames   = countAfter - countBefore;

  if (code !== 0 && NONZERO_IS_EMPTY.has(script)) {
    logger.info(`ℹ ${name}: exited with code ${code} (treated as nothing to claim)`);
    emptyPlatforms.push(name); // Add to our list instead of notifying immediately
  } else if (code !== 0) {
    const screenshot = await findRecentScreenshot(startTime);
    logger.warn(`✗ ${name} exited with code ${code}${screenshot ? ' (screenshot attached)' : ''}`);
    await notifyErrorWithScreenshot(
      name,
      new Error(`Script exited with code ${code}`),
      screenshot,
    ).catch(() => {});

  } else if (newGames <= 0) {
    logger.info(`ℹ ${name}: no new games`);
    emptyPlatforms.push(name); // Add to our list instead of notifying immediately

  } else {
    logger.info(`✓ ${name}: ${newGames} new games (notification sent by script)`);
  }
}

// 3. Send a single batch notification for all platforms that had no games
if (emptyPlatforms.length > 0) {
  await notifyEmpty(emptyPlatforms).catch(() => {});
}

logger.info('All platforms checked.');