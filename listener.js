'use strict';

/**
 * WhatsApp group exporter — always-on listener.
 *
 * Links once as a companion device (QR scan), then records every message in the
 * configured group chats to data/messages.jsonl and periodically renders
 * markdown exports into the folder set in config.json.
 */

const fs = require('fs');
const path = require('path');
const NodeQR = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const { DisconnectReason, isJidGroup } = require('@whiskeysockets/baileys');

const { extractContent, toMillis, normaliseName, jidUser } = require('./lib/wa');
const { MessageStore } = require('./lib/store');
const { ContactBook } = require('./lib/contacts');
const { loadConfig } = require('./lib/config');
const { createSocket } = require('./lib/socket');
const { main: renderAll } = require('./render');

const ROOT = __dirname;
const cfg = loadConfig(ROOT);
const AUTH_DIR = path.join(ROOT, 'auth');
const QR_PNG = path.join(ROOT, 'qr.png');
const QR_PAYLOAD = path.join(ROOT, 'qr-payload.txt');
const LOG_FILE = path.join(ROOT, 'listener.log');

const wantedGroups = new Map(cfg.groups.map((g) => [normaliseName(g), g]));
const store = new MessageStore(path.join(ROOT, 'data', 'messages.jsonl'));
const contacts = new ContactBook(path.join(ROOT, 'data', 'contacts.json'));

// LID -> phone-number JID, so exports never show an opaque LID as a sender.
const LID_MAP_FILE = path.join(ROOT, 'data', 'lid-pn.json');
const lidToPn = new Map();
let dumpedShape = false;

function loadLidMap() {
  try {
    const raw = JSON.parse(fs.readFileSync(LID_MAP_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) lidToPn.set(k, v);
  } catch {
    /* nothing mapped yet */
  }
}

function saveLidMap() {
  try {
    const obj = {};
    for (const [k, v] of [...lidToPn.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) obj[k] = v;
    fs.writeFileSync(LID_MAP_FILE, JSON.stringify(obj, null, 1), 'utf8');
  } catch {
    /* non-fatal */
  }
}

loadLidMap();

// jid -> canonical configured group name (filled in as we discover them)
const groupNames = new Map();

let sock = null;
let stopping = false;
let renderTimer = null;
let groupRefreshTimer = null;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* non-fatal */
  }
}

// ---- group name resolution ----------------------------------------------

function canonFor(subject) {
  return wantedGroups.get(normaliseName(subject)) || null;
}

function rememberGroup(jid, subject) {
  const canon = canonFor(subject);
  if (canon) groupNames.set(jid, canon);
  return canon;
}

async function refreshGroups() {
  if (!sock) return;
  try {
    const all = await sock.groupFetchAllParticipating();
    let matched = 0;
    let mapped = 0;
    for (const [jid, meta] of Object.entries(all || {})) {
      if (rememberGroup(jid, meta && meta.subject)) matched++;
      // Group metadata is a live source of LID -> phone-number mappings.
      for (const p of (meta && meta.participants) || []) {
        if (p && p.id && p.phoneNumber) {
          if (lidToPn.get(p.id) !== p.phoneNumber) mapped++;
          lidToPn.set(p.id, p.phoneNumber);
          lidToPn.set(jidUser(p.id), p.phoneNumber);
          lidToPn.set(jidUser(p.phoneNumber), p.phoneNumber);
        }
      }
    }
    if (mapped) saveLidMap();
    log(`group refresh: ${Object.keys(all || {}).length} groups visible, ${matched} match config, ${lidToPn.size} lid->pn entries`);
  } catch (err) {
    log('group refresh failed:', err.message);
  }
}

// One-shot diagnostic kept for reference: is a display name obtainable for
// senders we only know by LID? Answer (Oct 2026): no — WhatsApp's history sync
// omits the sender entirely for group messages, and USync returns only
// usernames. Group metadata DOES give LID -> phone number, which we use.
async function probeNameSources() {
  try {
    const all = await sock.groupFetchAllParticipating();
    for (const [jid, meta] of Object.entries(all || {})) {
      if (!groupNames.has(jid)) continue;
      const sample = (meta.participants || []).slice(0, 4);
      log(`PROBE participants for "${meta.subject}": ${JSON.stringify(sample)}`);
      break;
    }
  } catch (err) {
    log('PROBE group metadata failed:', err.message);
  }

  try {
    const lids = [...new Set(
      store.readAll().map((r) => r.senderJid).filter((j) => j && j.includes('@lid'))
    )].slice(0, 8);
    if (!lids.length) {
      log('PROBE: no LID senders in store');
      return;
    }
    const { USyncQuery, USyncUser } = require('@whiskeysockets/baileys');
    const q = new USyncQuery().withContactProtocol();
    for (const lid of lids) q.withUser(new USyncUser().withId(lid));
    const res = await sock.executeUSyncQuery(q);
    log(`PROBE usync(${lids.length} lids) -> ${JSON.stringify(res).slice(0, 700)}`);
  } catch (err) {
    log('PROBE usync failed:', err.message);
  }
}

// ---- message capture ------------------------------------------------------

function recordFrom(msg, chatNameHint) {
  try {
    const key = msg.key || {};
    if (!key.remoteJid || !isJidGroup(key.remoteJid)) return null;
    if (!key.id) return null;

    let canon = groupNames.get(key.remoteJid);
    if (!canon && chatNameHint) canon = rememberGroup(key.remoteJid, chatNameHint);
    if (!canon) return null; // not one of the groups we were asked to export

    const raw = msg.message;
    if (!raw) return null;
    const { text, kind } = extractContent(raw);
    if (kind === 'unknown' || kind === 'unsupported') return null;
    if (kind === 'reaction' || kind === 'poll vote') return null;

    const fromMe = !!key.fromMe;
    const participantRaw = key.participant || key.participantAlt || null;
    const participantPn = key.participantPn || key.senderPn || null;
    // Prefer the phone-number form when the client supplies both.
    const senderJid = fromMe ? 'me' : participantPn || participantRaw || key.remoteJid;
    const pushName = msg.pushName ? String(msg.pushName).trim() : '';
    if (!fromMe && pushName) {
      if (contacts.learnName(senderJid, pushName)) log(`learned name: ${pushName}`);
      if (participantRaw) contacts.learnName(participantRaw, pushName);
      if (participantPn) contacts.learnName(participantPn, pushName);
    }
    // Opportunistically grow the LID -> phone map from live traffic.
    if (participantRaw && participantPn && lidToPn.get(participantRaw) !== participantPn) {
      lidToPn.set(participantRaw, participantPn);
      lidToPn.set(jidUser(participantRaw), participantPn);
      saveLidMap();
    }

    return {
      id: key.id,
      groupJid: key.remoteJid,
      groupName: canon,
      ts: toMillis(msg.messageTimestamp),
      fromMe,
      // For our own messages the display name comes from config at render time,
      // so nothing identity-specific is baked into the stored data.
      sender: fromMe ? null : pushName,
      senderJid,
      participantJid: participantRaw || null,
      kind,
      text: typeof text === 'string' ? text : '',
    };
  } catch (err) {
    log('record error:', err.message);
    return null;
  }
}

function ingest(msgs, hint) {
  const recs = [];
  for (const m of msgs || []) {
    const r = recordFrom(m, hint);
    if (r) recs.push(r);
  }
  const added = store.addMany(recs);
  if (added) log(`captured ${added} new message(s) [store=${store.count}]`);
  return added;
}

// ---- rendering ------------------------------------------------------------

function runRender(reason) {
  try {
    log(`rendering (${reason})`);
    renderAll();
  } catch (err) {
    log('render failed:', err.message);
  }
}

// ---- connection -----------------------------------------------------------

async function start() {
  const created = await createSocket({ authDir: AUTH_DIR });
  sock = created.sock;
  const saveCreds = created.saveCreds;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcodeTerminal.generate(qr, { small: true });
      try {
        // Raw payload so the local QR page can regenerate a fresh code on demand.
        fs.writeFileSync(QR_PAYLOAD, qr, 'utf8');
      } catch {
        /* non-fatal */
      }
      try {
        await NodeQR.toFile(QR_PNG, qr, { width: 512, margin: 2 });
        log(`QR written to ${QR_PNG} — scan it with WhatsApp > Linked devices`);
      } catch (err) {
        log('could not write QR png:', err.message);
      }
    }

    if (connection === 'open') {
      log('LINKED / connected OK');
      try {
        fs.rmSync(QR_PNG, { force: true });
        fs.rmSync(QR_PAYLOAD, { force: true });
      } catch {
        /* ignore */
      }
      await refreshGroups();
      runRender('post-connect');
      if (!groupRefreshTimer) {
        groupRefreshTimer = setInterval(refreshGroups, 30 * 60 * 1000);
      }
    }

    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode
        : undefined;
      if (code === DisconnectReason.loggedOut) {
        log('LOGGED OUT — the device link was removed. Delete ./auth and re-run to link again.');
        process.exit(1);
      }
      log(`connection closed (code=${code}); reconnecting in 5s`);
      setTimeout(() => {
        if (!stopping) start();
      }, 5000);
    }
  });

  sock.ev.on('messaging-history.set', ({ messages, chats, contacts: cts, lidPnMappings }) => {
    const nameFor = new Map();
    for (const c of chats || []) if (c && c.id) nameFor.set(c.id, c.name || c.subject);

    // Map any LID sender onto a real phone number so exports never show a LID.
    for (const m of lidPnMappings || []) {
      if (m && m.lid && m.pn) lidToPn.set(m.lid, m.pn);
      if (m && m.lid && m.pn) lidToPn.set(jidUser(m.lid), m.pn);
    }
    saveLidMap();

    const learned = contacts.learnFromContacts(cts);
    log(`contact snapshot: ${(cts || []).length} offered, ${learned} new names (book=${contacts.size}), ${(lidPnMappings || []).length} lid->pn mappings`);
    contacts.save();

    // One-off shape dump so the sender field can be fixed with evidence.
    if (!dumpedShape && (messages || []).length) {
      dumpedShape = true;
      const sample = (messages || [])
        .filter((m) => m && m.key && isJidGroup(m.key.remoteJid))
        .slice(0, 3)
        .map((m) => ({ key: m.key, pushName: m.pushName }));
      log('RAW KEY SAMPLE: ' + JSON.stringify(sample).slice(0, 1800));
    }

    let n = 0;
    for (const m of messages || []) {
      const hint = nameFor.get(m.key && m.key.remoteJid);
      n += ingest([m], hint);
    }
    log(`history sync: ${(messages || []).length} msgs offered, ${n} stored`);
    contacts.save();
    runRender('history sync');
  });

  sock.ev.on('contacts.upsert', (list) => {
    const learned = contacts.learnFromContacts(list);
    if (learned) log(`contacts.upsert: ${learned} new names (book=${contacts.size})`);
    contacts.save();
  });

  sock.ev.on('contacts.update', (list) => {
    const learned = contacts.learnFromContacts(list);
    if (learned) log(`contacts.update: ${learned} new names (book=${contacts.size})`);
    contacts.save();
  });

  sock.ev.on('messages.upsert', ({ messages }) => {
    ingest(messages);
  });

  if (!renderTimer) {
    const every = Math.max(1, cfg.renderEveryMinutes || 15) * 60 * 1000;
    renderTimer = setInterval(() => {
      if (store.dirty) {
        store.dirty = false;
        runRender('scheduled');
      }
    }, every);
  }

  log(`listener up — watching for: ${cfg.groups.join(' | ')}`);
}

function shutdown(sig) {
  log(`shutting down (${sig})`);
  stopping = true;
  try {
    renderAll();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Only connect when run directly, so the test suite can require() this file to
// prove it loads. A deleted import is a runtime ReferenceError that `node
// --check` happily accepts, so a load test is the only cheap guard against it.
if (require.main === module) {
  start().catch((err) => {
    log('fatal:', err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}

module.exports = { start };
