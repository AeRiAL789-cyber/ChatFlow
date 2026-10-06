'use strict';

// Unwrap the container messages WhatsApp uses, then pull out something human-readable.
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
  'deviceSentMessage',
];

function unwrap(msg) {
  let cur = msg;
  let guard = 0;
  while (cur && guard++ < 10) {
    const hit = WRAPPERS.find((w) => cur[w] && cur[w].message);
    if (!hit) break;
    cur = cur[hit].message;
  }
  return cur;
}

// Returns { text, kind } — kind is a short tag used in the markdown output.
function extractContent(rawMsg) {
  if (!rawMsg) return { text: '', kind: 'unknown' };
  const m = unwrap(rawMsg);
  if (!m) return { text: '', kind: 'unknown' };

  if (typeof m.conversation === 'string' && m.conversation.length) {
    return { text: m.conversation, kind: 'text' };
  }
  if (m.extendedTextMessage && typeof m.extendedTextMessage.text === 'string') {
    return { text: m.extendedTextMessage.text, kind: 'text' };
  }
  if (m.imageMessage) return { text: m.imageMessage.caption || '', kind: 'photo' };
  if (m.videoMessage) return { text: m.videoMessage.caption || '', kind: 'video' };
  if (m.audioMessage) {
    return { text: '', kind: m.audioMessage.ptt ? 'voice note' : 'audio' };
  }
  if (m.stickerMessage) return { text: '', kind: 'sticker' };
  if (m.documentMessage) {
    return { text: m.documentMessage.caption || '', kind: `document (${m.documentMessage.fileName || 'file'})` };
  }
  if (m.contactMessage) return { text: m.contactMessage.displayName || '', kind: 'contact card' };
  if (m.contactsArrayMessage) return { text: '', kind: 'contact cards' };
  if (m.locationMessage) return { text: m.locationMessage.name || m.locationMessage.address || '', kind: 'location' };
  if (m.liveLocationMessage) return { text: '', kind: 'live location' };
  if (m.pollCreationMessage) return { text: m.pollCreationMessage.name || '', kind: 'poll' };
  if (m.pollUpdateMessage) return { text: '', kind: 'poll vote' };
  if (m.reactionMessage) {
    return { text: m.reactionMessage.text || '', kind: 'reaction' };
  }
  if (m.protocolMessage) {
    const sys = m.protocolMessage.type === 0 ? 'message deleted' : 'system';
    return { text: '', kind: sys };
  }
  if (m.eventMessage) return { text: m.eventMessage.name || '', kind: 'event' };
  return { text: '', kind: 'unsupported' };
}

// Baileys timestamps are sometimes Long objects, sometimes numbers.
function toMillis(ts) {
  if (ts === null || ts === undefined) return Date.now();
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts;
  if (typeof ts === 'object') {
    if (typeof ts.toNumber === 'function') return ts.toNumber() * 1000;
    if (typeof ts.valueOf === 'function') return Number(ts.valueOf()) * 1000;
    if (typeof ts.low === 'number') return ts.low * 1000;
  }
  const n = Number(ts);
  return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.now();
}

function tzParts(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date(ms))) p[type] = value;
  const day = `${p.year}-${p.month}-${p.day}`;
  const hour = p.hour === '24' ? '00' : p.hour;
  return { day, time: `${hour}:${p.minute}` };
}

// Loose matching, so "Project_Trust - Comms" == "Project Trust, Comms" etc.
// Keeps unicode letters (macrons, CJK) and collapses all punctuation to spaces.
function normaliseName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function safeFileName(s) {
  return String(s)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 90);
}

// Deterministic short name for a chat, used for folder and file names.
function jidUser(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

module.exports = {
  extractContent,
  toMillis,
  tzParts,
  normaliseName,
  safeFileName,
  jidUser,
};
