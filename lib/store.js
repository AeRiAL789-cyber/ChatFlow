'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Append-only JSONL message store with in-memory dedupe.
 * WhatsApp delivers the same message more than once (history sync, reconnects,
 * retries), so the message id is the identity key.
 */
class MessageStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.seen = new Set();
    this.dirty = false;
    this.count = 0;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this._loadIndex();
  }

  _loadIndex() {
    if (!fs.existsSync(this.filePath)) return;
    const raw = fs.readFileSync(this.filePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && rec.id) this.seen.add(rec.id);
      } catch {
        /* skip corrupt line */
      }
    }
    this.count = this.seen.size;
  }

  has(id) {
    return this.seen.has(id);
  }

  add(rec) {
    if (!rec || !rec.id || this.seen.has(rec.id)) return false;
    this.seen.add(rec.id);
    fs.appendFileSync(this.filePath, JSON.stringify(rec) + '\n', 'utf8');
    this.count = this.seen.size;
    this.dirty = true;
    return true;
  }

  addMany(recs) {
    let n = 0;
    for (const r of recs) if (this.add(r)) n++;
    return n;
  }

  readAll() {
    if (!fs.existsSync(this.filePath)) return [];
    const out = [];
    const raw = fs.readFileSync(this.filePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
    return out;
  }
}

module.exports = { MessageStore };
