'use strict';

/**
 * Backfill older history on demand, straight from the phone.
 *
 * WhatsApp delivers past messages in response to fetchMessageHistory(), via the
 * same messaging-history.set event used at link time. This walks backwards
 * through each configured group and stores whatever comes back.
 *
 * Usage:
 *   node backfill.js --probe          one call per group, dumps raw key shape
 *   node backfill.js                  paginate backwards until exhausted
 *   node backfill.js --group="Name"   restrict to one group
 *   node backfill.js --rounds=20      cap calls per group (default 12)
 */

const fs = require('fs');
const path = require('path');
const pino = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidGroup,
  Browsers,
} = require('@whiskeysockets/baileys');

const { extractContent, toMillis, normaliseName, jidUser } = require('./lib/wa');
const { MessageStore } = require('./lib/store');
const { ContactBook } = require('./lib/contacts');
const { loadConfig } = require('./lib/config');
const { main: renderAll } = require('./render');

const ROOT = __dirname;
const cfg = loadConfig(ROOT);
const logger = pino({ level: 'silent' });

const PROBE = process.argv.includes('--probe');
const onlyArg = process.argv.find((a) => a.startsWith('--group='));
const roundsArg = process.argv.find((a) => a.startsWith('--rounds='));
const MAX_ROUNDS = PROBE ? 1 : (roundsArg ? Number(roundsArg.split('=')[1]) : 12);

const wanted = new Map(cfg.groups.map((g) => [normaliseName(g), g]));
const store = new MessageStore(path.join(ROOT, 'data', 'messages.jsonl'));
const contacts = new ContactBook(path.join(ROOT, 'data', 'contacts.json'));
const LID_MAP_FILE = path.join(ROOT, 'data', 'lid-pn.json');
const lidToPn = new Map();
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(LID_MAP_FILE, 'utf8')))) lidToPn.set(k, v);
} catch { /* none yet */ }

function saveLidMap() {
  const obj = {};
  for (const [k, v] of [...lidToPn.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) obj[k] = v;
  fs.writeFileSync(LID_MAP_FILE, JSON.stringify(obj, null, 1), 'utf8');
}

const groupNames = new Map();
let inbox = [];
let wake = null;

function log(...a) {
  console.log(`[backfill] ${a.join(' ')}`);
}

function toRecord(m, canon) {
  const key = m.key || {};
  if (!key.id) return null;
  const raw = m.message;
  if (!raw) return null;
  const { text, kind } = extractContent(raw);
  if (kind === 'unknown' || kind === 'unsupported' || kind === 'reaction' || kind === 'poll vote') return null;

  const fromMe = !!key.fromMe;
  const participantRaw = key.participant || key.participantAlt || null;
  const participantPn = key.participantPn || key.senderPn || null;
  const senderJid = fromMe ? 'me' : participantPn || participantRaw || key.remoteJid;
  const pushName = m.pushName ? String(m.pushName).trim() : '';
  if (!fromMe && pushName) {
    contacts.learnName(senderJid, pushName);
    if (participantRaw) contacts.learnName(participantRaw, pushName);
    if (participantPn) contacts.learnName(participantPn, pushName);
  }
  if (participantRaw && participantPn) {
    lidToPn.set(participantRaw, participantPn);
    lidToPn.set(jidUser(participantRaw), participantPn);
  }
  return {
    id: key.id,
    groupJid: key.remoteJid,
    groupName: canon,
    ts: toMillis(m.messageTimestamp),
    fromMe,
    sender: fromMe ? null : pushName,
    senderJid,
    participantJid: participantRaw || null,
    kind,
    text: typeof text === 'string' ? text : '',
  };
}

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(ROOT, 'auth'));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    browser: Browsers.appropriate('Chrome'),
    syncFullHistory: true,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messaging-history.set', ({ messages, chats, contacts: cts, lidPnMappings, syncType }) => {
    for (const c of chats || []) {
      if (c && c.id && c.name) {
        const canon = wanted.get(normaliseName(c.name));
        if (canon) groupNames.set(c.id, canon);
      }
    }
    contacts.learnFromContacts(cts);
    for (const m of lidPnMappings || []) {
      if (m && m.lid && m.pn) {
        lidToPn.set(m.lid, m.pn);
        lidToPn.set(jidUser(m.lid), m.pn);
      }
    }
    const msgs = messages || [];
    log(`history chunk: syncType=${syncType} messages=${msgs.length} contacts=${(cts || []).length}`);
    if (PROBE) {
      const sample = msgs.filter((m) => m.key && isJidGroup(m.key.remoteJid)).slice(0, 3)
        .map((m) => ({ key: m.key, pushName: m.pushName }));
      log('RAW ON-DEMAND KEY SAMPLE: ' + JSON.stringify(sample).slice(0, 1600));
    }
    inbox.push(...msgs);
    contacts.save();
    if (wake) { const w = wake; wake = null; w(); }
  });

  await new Promise((resolve, reject) => {
    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open') resolve();
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== 408 && code !== 428 && code !== 515) reject(new Error('closed: ' + code));
      }
    });
  });

  const all = await sock.groupFetchAllParticipating();
  for (const [jid, meta] of Object.entries(all || {})) {
    const canon = wanted.get(normaliseName(meta && meta.subject));
    if (canon) groupNames.set(jid, canon);
    for (const p of (meta && meta.participants) || []) {
      if (p && p.id && p.phoneNumber) {
        lidToPn.set(p.id, p.phoneNumber);
        lidToPn.set(jidUser(p.id), p.phoneNumber);
      }
    }
  }
  saveLidMap();
  log(`groups resolved: ${groupNames.size}; lid->pn entries: ${lidToPn.size}`);

  const targets = [...groupNames.entries()].filter(([, canon]) => !onlyArg || onlyArg === `--group=${canon}`);

  for (const [gjid, canon] of targets) {
    log(`--- ${canon} (${gjid}) ---`);
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const mine = store.readAll().filter((r) => r.groupName === canon);
      if (!mine.length) { log('  nothing stored yet for this group; skipping'); break; }
      const oldest = mine.reduce((a, b) => (b.ts < a.ts ? b : a));

      inbox = [];
      const before = store.count;
      try {
        await sock.fetchMessageHistory(50, { remoteJid: gjid, id: oldest.id, fromMe: !!oldest.fromMe }, Math.floor(oldest.ts / 1000));
      } catch (err) {
        log(`  round ${round}: request failed: ${err.message}`);
        break;
      }

      await new Promise((res) => {
        wake = res;
        setTimeout(res, 15000);
      });

      const got = inbox.filter((m) => m.key && m.key.remoteJid === gjid);
      const recs = got.map((m) => toRecord(m, canon)).filter(Boolean);
      const added = store.addMany(recs);
      saveLidMap();
      contacts.save();

      log(`  round ${round}: received ${got.length}, stored ${added} (store=${store.count}, was ${before})`);
      if (!got.length || added === 0) {
        const anyOlder = got.some((m) => toMillis(m.messageTimestamp) < oldest.ts);
        if (!anyOlder) { log('  no older messages returned — at the start of available history'); break; }
      }
    }
  }

  contacts.save();
  saveLidMap();
  log('rendering...');
  try { renderAll(); } catch (e) { log('render failed: ' + e.message); }
  log(`done. store=${store.count} contacts=${contacts.size} lidmap=${lidToPn.size}`);
  process.exit(0);
}

// Only run when invoked directly, so the test suite can require() this file.
if (require.main === module) {
  main().catch((e) => {
    console.error('[backfill] fatal:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}
