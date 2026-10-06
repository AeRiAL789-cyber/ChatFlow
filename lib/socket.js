'use strict';

/**
 * Shared WhatsApp socket construction.
 *
 * Used by setup.js (first-run linking), listener.js (continuous capture) and
 * backfill.js (on-demand history). Keeping it in one place means the linking
 * behaviour cannot drift between them.
 */

const fs = require('fs');
const path = require('path');
const pino = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');

// Baileys is extremely chatty. Silence it unless the caller asks for noise.
const silentLogger = pino({ level: 'silent' });

function credsPath(authDir) {
  return path.join(authDir, 'creds.json');
}

/** True once the device has been paired and credentials contain our own JID. */
function isLinked(authDir) {
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath(authDir), 'utf8'));
    return !!(creds && creds.me && creds.me.id);
  } catch {
    return false;
  }
}

/** The linked account's own JID, or null. */
function linkedAs(authDir) {
  try {
    return JSON.parse(fs.readFileSync(credsPath(authDir), 'utf8')).me.id;
  } catch {
    return null;
  }
}

async function createSocket({ authDir, logger = silentLogger, syncFullHistory = true } = {}) {
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: Browsers.appropriate('Chrome'),
    syncFullHistory,
    // Do not mark the account as online just because this tool is running.
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
  });

  return { sock, saveCreds, version };
}

/** Resolves on 'open', rejects on a terminal close or timeout. */
function waitForOpen(sock, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for the connection to open.'));
    }, timeoutMs);

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        clearTimeout(timer);
        resolve();
        return;
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        // 428/408/515 are normal during QR churn and reconnects.
        if (code !== 408 && code !== 428 && code !== 515) {
          clearTimeout(timer);
          reject(new Error(`Connection closed (status ${code}).`));
        }
      }
    });
  });
}

module.exports = {
  createSocket,
  waitForOpen,
  isLinked,
  linkedAs,
  credsPath,
  silentLogger,
};
