#!/usr/bin/env node
'use strict';

/**
 * ChatFlow setup - first run.
 *
 *   1. Link this tool to WhatsApp (scan a QR, same as WhatsApp Web)
 *   2. Pick which group chats to archive from a list
 *   3. Choose where the markdown exports go
 *
 * Writes config.json, which is gitignored and stays on this machine.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const qrcodeTerminal = require('qrcode-terminal');
const NodeQR = require('qrcode');
const { isJidGroup } = require('@whiskeysockets/baileys');

const { createSocket, waitForOpen, isLinked, linkedAs } = require('./lib/socket');

const ROOT = __dirname;
const AUTH_DIR = path.join(ROOT, 'auth');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const QR_PNG = path.join(ROOT, 'qr.png');

// Created inside main() rather than at import time, so that requiring this file
// for the load test does not grab stdin or keep the process alive.
let rl = null;
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const OFF = '\x1b[0m';

function banner() {
  console.log('');
  console.log(`${CYAN}${BOLD}  ChatFlow${OFF}`);
  console.log(`${DIM}  Archive WhatsApp group chats to readable markdown files.${OFF}`);
  console.log('');
}

function requireNewEnoughNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(`${RED}Node ${process.versions.node} is too old. ChatFlow needs Node 18 or newer.${OFF}`);
    process.exit(1);
  }
}

function openPrompt() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
}

/**
 * Turns "1,3,5-8" into [1,3,5,6,7,8]. Returns null if anything is unparseable.
 */
function parseSelection(input, max) {
  const picked = new Set();
  for (const chunk of input.split(',')) {
    const part = chunk.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from < 1 || to > max || from > to) return null;
      for (let i = from; i <= to; i++) picked.add(i);
      continue;
    }
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 1 || n > max) return null;
    picked.add(n);
  }
  return picked.size ? [...picked].sort((a, b) => a - b) : null;
}

async function stepOutputFolder() {
  console.log(`${BOLD}Where should the exports go?${OFF}`);
  console.log(`${DIM}One markdown file per group per day, plus a full transcript.${OFF}`);
  const fallback = path.join(ROOT, 'exports');
  const answer = await ask(`  Folder [${fallback}]: `);
  const dir = answer ? path.resolve(answer.replace(/^"|"$/g, '')) : fallback;
  try {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`  ${GREEN}ok${OFF} ${dir}`);
  } catch (err) {
    console.log(`  ${RED}Could not create that folder: ${err.message}${OFF}`);
    return stepOutputFolder();
  }
  console.log('');
  return dir;
}

async function stepLink() {
  if (isLinked(AUTH_DIR)) {
    console.log(`${GREEN}Already linked${OFF} as ${linkedAs(AUTH_DIR)}`);
    console.log(`${DIM}Delete the auth/ folder if you want to link a different account.${OFF}`);
    console.log('');
    return;
  }

  console.log(`${BOLD}Link this tool to WhatsApp${OFF}`);
  console.log('');
  console.log('  On your phone:  WhatsApp > Settings > Linked devices > Link a device');
  console.log(`  ${DIM}The code below refreshes every ~20 seconds - scan whenever you're ready.${OFF}`);
  console.log(`  ${DIM}This uses one of your four linked-device slots.${OFF}`);
  console.log('');

  const { sock, saveCreds } = await createSocket({ authDir: AUTH_DIR });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, qr }) => {
    if (qr) {
      qrcodeTerminal.generate(qr, { small: true });
      try {
        await NodeQR.toFile(QR_PNG, qr, { width: 512, margin: 2 });
      } catch {
        /* the terminal code is enough */
      }
    }
    if (connection === 'open') {
      console.log(`\n  ${GREEN}Linked.${OFF}\n`);
      fs.rmSync(QR_PNG, { force: true });
      fs.rmSync(path.join(ROOT, 'qr-payload.txt'), { force: true });
    }
  });

  await waitForOpen(sock, { timeoutMs: 300000 });
  return sock;
}

async function stepPickGroups(sock) {
  console.log(`${BOLD}Which group chats do you want to archive?${OFF}`);
  console.log(`${DIM}Fetching your groups...${OFF}`);

  const all = await sock.groupFetchAllParticipating();
  const groups = Object.entries(all || {})
    .filter(([jid]) => isJidGroup(jid))
    .map(([jid, meta]) => ({ jid, subject: (meta && meta.subject) || '(no name)' }))
    .sort((a, b) => a.subject.localeCompare(b.subject));

  if (!groups.length) {
    console.log(`  ${YELLOW}No group chats found on this account.${OFF}`);
    console.log('  Join at least one group, then run setup again.');
    console.log('');
    return [];
  }

  console.log('');
  groups.forEach((g, i) => {
    console.log(`  ${String(i + 1).padStart(3)}. ${g.subject}`);
  });
  console.log('');
  console.log(`${DIM}  Enter numbers, ranges or a mix - e.g.  1,4,7-9${OFF}`);

  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await ask('  Chats to archive: ');
    if (answer.toLowerCase() === 'all') return groups.map((g) => g.subject);
    const picked = parseSelection(answer, groups.length);
    if (picked) {
      const chosen = picked.map((n) => groups[n - 1].subject);
      console.log('');
      chosen.forEach((c) => console.log(`  ${GREEN}+${OFF} ${c}`));
      console.log('');
      return chosen;
    }
    console.log(`  ${YELLOW}Didn't understand that. Use numbers between 1 and ${groups.length}, or "all".${OFF}`);
  }

  console.log(`  ${RED}Giving up on selection.${OFF}`);
  return [];
}

function writeConfig(groups, outputDir) {
  const cfg = {
    groups,
    outputDir: outputDir.split(path.sep).join('/'),
    myName: 'Me',
    renderEveryMinutes: 15,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };

  if (fs.existsSync(CONFIG_FILE)) {
    const backup = CONFIG_FILE + '.bak';
    fs.copyFileSync(CONFIG_FILE, backup);
    console.log(`${DIM}Existing config backed up to ${path.basename(backup)}${OFF}`);
  }

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log('');
  console.log(`${GREEN}Wrote config.json${OFF}`);
  console.log(`  ${DIM}groups       ${groups.length}${OFF}`);
  console.log(`  ${DIM}outputDir    ${cfg.outputDir}${OFF}`);
  console.log(`  ${DIM}timezone     ${cfg.timezone}${OFF}`);
  console.log('');
  console.log(`${DIM}  "myName" is how your own messages are labelled. Edit config.json to change it.${OFF}`);
  console.log('');
}

async function main() {
  requireNewEnoughNode();
  openPrompt();
  banner();

  const outputDir = await stepOutputFolder();
  const sock = await stepLink();
  const groups = await stepPickGroups(sock);

  if (!groups.length) {
    console.log(`${YELLOW}Nothing selected, so config.json was not written.${OFF}`);
    console.log(`${DIM}Run "npm run setup" again when you're ready.${OFF}`);
    console.log('');
    rl.close();
    process.exit(0);
  }

  writeConfig(groups, outputDir);

  console.log(`${BOLD}Next${OFF}`);
  console.log('  npm start          start capturing (leave it running)');
  console.log('  npm run status     check it is alive and what it has captured');
  console.log('  npm run render     rebuild the markdown from what is stored');
  console.log('');
  console.log(`${DIM}  Messages are captured from now on. WhatsApp does not tell a linked`);
  console.log(`  device who sent messages that were sent before you linked, so those`);
  console.log(`  appear as "Unknown sender" - that is a WhatsApp limit, not a bug.${OFF}`);
  console.log('');

  try {
    sock.end(undefined);
  } catch {
    /* ignore */
  }
  rl.close();
  process.exit(0);
}

// Only run when invoked directly, so the test suite can require() this file.
if (require.main === module) {
  main().catch((err) => {
    console.error(`\n${RED}Setup failed:${OFF} ${err && err.message ? err.message : err}`);
    if (rl) rl.close();
    process.exit(1);
  });
}
