'use strict';

/**
 * Persistent contact name book.
 *
 * WhatsApp identifies group participants by JID or LID; display names arrive
 * separately in the contact snapshot / push names. Names are also learned from
 * every message's pushName. Resolution happens at RENDER time so that messages
 * captured before a name was known still get labelled correctly.
 */

const fs = require('fs');
const path = require('path');

function norm(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

class ContactBook {
  constructor(file) {
    this.file = file;
    this.byKey = new Map();
    this.dirty = false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(raw)) if (v) this.byKey.set(k, v);
    } catch {
      /* start fresh on corrupt file */
    }
  }

  // A contact object may carry an address-book name, a self-set push name,
  // a business name, and one or more identifiers.
  learnFromContact(c) {
    if (!c) return false;
    const name =
      (c.name && String(c.name).trim()) ||
      (c.verifiedName && String(c.verifiedName).trim()) ||
      (c.notify && String(c.notify).trim()) ||
      '';
    if (!name) return false;
    let learned = false;
    // WhatsApp's history sync reports groups in the same list as people —
    // a group's subject must never end up in the name book.
    for (const id of [c.id, c.lid]) {
      if (!id) continue;
      if (String(id).endsWith('@g.us')) continue;
      if (this._set(id, name)) learned = true;
    }
    return learned;
  }

  learnFromContacts(list) {
    let n = 0;
    for (const c of list || []) if (this.learnFromContact(c)) n++;
    return n;
  }

  // pushName on a message is the sender's own display name — always useful.
  learnName(jid, name) {
    if (!jid || !name) return false;
    return this._set(jid, String(name).trim());
  }

  _set(jid, name) {
    // Group ids are never people — never index them, or a group's numeric part
    // could later resolve to somebody's name.
    if (String(jid).endsWith('@g.us')) return false;
    const keys = new Set([String(jid)]);
    const u = norm(jid);
    if (u) keys.add(u);
    let changed = false;
    for (const k of keys) {
      if (!k) continue;
      const prev = this.byKey.get(k);
      // Prefer a real address-book name over a self-chosen push name.
      if (!prev || prev.length <= name.length || prev === norm(k)) {
        if (prev !== name) {
          this.byKey.set(k, name);
          changed = true;
        }
      }
    }
    if (changed) this.dirty = true;
    return changed;
  }

  resolve(...jids) {
    for (const jid of jids) {
      if (!jid) continue;
      if (String(jid).endsWith('@g.us')) continue; // groups are not senders
      const hit = this.byKey.get(String(jid)) || this.byKey.get(norm(jid));
      if (hit) return hit;
    }
    return null;
  }

  save() {
    if (!this.dirty) return false;
    const obj = {};
    for (const [k, v] of [...this.byKey.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
      obj[k] = v;
    }
    fs.writeFileSync(this.file, JSON.stringify(obj, null, 1), 'utf8');
    this.dirty = false;
    return true;
  }

  get size() {
    return this.byKey.size;
  }
}

/**
 * Final display name for a stored message record.
 * Order: contact book -> stored push name -> LID->phone map -> raw id.
 * A group JID is never used as a person's name.
 */
function formatPhone(jid) {
  const d = String(jid || '').split('@')[0].replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('64') && d.length >= 10 && d.length <= 12) {
    const rest = d.slice(2);
    return `+64 ${rest.slice(0, 2)} ${rest.slice(2, 5)} ${rest.slice(5)}`;
  }
  return `+${d}`;
}

function resolveSender(book, rec, lidToPn, myName = 'Me') {
  if (rec.fromMe) return myName;

  const fromBook = book ? book.resolve(rec.senderJid, rec.participantJid) : null;
  if (fromBook) return fromBook;

  const stored = rec.sender || rec.pushName;
  // A bare numeric id is not a name — don't pretend it is.
  if (stored && !/^\d{6,}$/.test(String(stored).trim())) return String(stored).trim();

  if (lidToPn) {
    for (const jid of [rec.participantJid, rec.senderJid]) {
      if (!jid) continue;
      const pn = lidToPn.get(String(jid)) || lidToPn.get(norm(jid));
      if (pn) {
        const pretty = formatPhone(pn);
        if (pretty) return pretty;
      }
    }
  }

  // Last resort: never label a message with the group's own id.
  const u = norm(rec.senderJid);
  if (u && !String(rec.senderJid).includes('@g.us')) return `Unknown (${u})`;
  return 'Unknown sender';
}

module.exports = { ContactBook, resolveSender, norm, formatPhone };
