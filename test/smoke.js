'use strict';
/* Smoke test: exercises extractContent + the full render pipeline against a
   SYNTHETIC fixture store, writing to a temp dir. Touches nothing real. */

const fs = require('fs');
const path = require('path');
const { extractContent, toMillis, tzParts, normaliseName } = require('../lib/wa');

const os = require('os');
const SCRATCH = process.env.SCRATCH_DIR || path.join(os.tmpdir(), 'chatflow-test');
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}` + (ok ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`));
}

// ---- 1. content extraction ------------------------------------------------
check('plain text', extractContent({ conversation: 'hello' }), { text: 'hello', kind: 'text' });
check('extended text', extractContent({ extendedTextMessage: { text: 'hi there' } }), { text: 'hi there', kind: 'text' });
check('photo caption', extractContent({ imageMessage: { caption: 'site photo' } }), { text: 'site photo', kind: 'photo' });
check('photo no caption', extractContent({ imageMessage: {} }), { text: '', kind: 'photo' });
check('voice note', extractContent({ audioMessage: { ptt: true } }), { text: '', kind: 'voice note' });
check('document', extractContent({ documentMessage: { fileName: 'plan.pdf', caption: 'rev B' } }), { text: 'rev B', kind: 'document (plan.pdf)' });
check('ephemeral wrapper', extractContent({ ephemeralMessage: { message: { conversation: 'gone soon' } } }), { text: 'gone soon', kind: 'text' });
check('viewOnce wrapper', extractContent({ viewOnceMessageV2: { message: { imageMessage: { caption: 'v1' } } } }), { text: 'v1', kind: 'photo' });
check('deleted message', extractContent({ protocolMessage: { type: 0 } }), { text: '', kind: 'message deleted' });

// ---- 2. timestamp handling ------------------------------------------------
check('number seconds', toMillis(1759700000), 1759700000000);
check('number ms passthrough', toMillis(1759700000000), 1759700000000);
check('Long-like object', toMillis({ toNumber: () => 1759700000 }), 1759700000000);
const tz = tzParts(1759700000000, 'Pacific/Auckland');
check('tz day shape', /^\d{4}-\d{2}-\d{2}$/.test(tz.day), true);
check('tz time shape', /^\d{2}:\d{2}$/.test(tz.time), true);

// ---- 3. name normalisation ------------------------------------------------
// Chat subjects differ in punctuation between clients, so matching must not.
check('punctuation-insensitive matching', normaliseName('Project_Trust - Comms'), normaliseName('Project Trust, Comms'));
check('case and space insensitive', normaliseName('  SITE   CREW '), normaliseName('Site Crew'));

// ---- 4. render pipeline ---------------------------------------------------
const GROUPS = ['Site Crew', 'Project_Trust - Comms', 'Alpha_Team Comms', 'QA Team'];
const outDir = path.join(SCRATCH, 'exports');
const cfgPath = path.join(SCRATCH, 'test-config.json');
fs.writeFileSync(cfgPath, JSON.stringify({
  groups: GROUPS,
  outputDir: outDir,
  myName: 'Test User',
  timezone: 'Pacific/Auckland',
}));

const base = 1759600000; // fixed instant, no dependence on "now"
const fixture = [
  { id: 'm1', groupName: 'Site Crew', fromMe: false, sender: 'Alex Brown', kind: 'text', text: 'Start is Thursday 0900', ts: base * 1000 },
  { id: 'm2', groupName: 'Site Crew', fromMe: true, sender: null, kind: 'text', text: 'Copy that.\nI will confirm the crew.', ts: (base + 600) * 1000 },
  { id: 'm3', groupName: 'Site Crew', fromMe: false, sender: 'Alex Brown', kind: 'photo', text: 'anchor layout', ts: (base + 900) * 1000 },
  { id: 'm4', groupName: 'Alpha_Team Comms', fromMe: false, sender: 'Admin', kind: 'text', text: 'Approved.', ts: (base + 86400) * 1000 },
  { id: 'm5', groupName: 'Not A Configured Group', fromMe: false, sender: 'Nobody', kind: 'text', text: 'should be ignored', ts: (base + 100) * 1000 },
  // sender is an opaque LID but a contact name exists for it
  { id: 'm6', groupName: 'QA Team', fromMe: false, sender: '120363412963990597', senderJid: '120363412963990597@lid', kind: 'text', text: 'Numeric sender with contact name', ts: (base + 1200) * 1000 },
  // opaque LID with NO known contact -> should be labelled Unknown, never faked
  { id: 'm7', groupName: 'QA Team', fromMe: false, sender: '999888777666555', senderJid: '999888777666555@lid', kind: 'text', text: 'Numeric sender unknown', ts: (base + 1300) * 1000 },
  // group join/leave noise -> filtered out of renders
  { id: 'm8', groupName: 'QA Team', fromMe: false, sender: 'sys', senderJid: 'x@s.whatsapp.net', kind: 'system', text: '', ts: (base + 1400) * 1000 },
  // LID with no contact name, but a LID->phone mapping exists
  { id: 'm9', groupName: 'QA Team', fromMe: false, sender: '111222333444555', senderJid: '111222333444555@lid', kind: 'text', text: 'LID resolved via phone map', ts: (base + 1500) * 1000 },
  // shape of a real history-sync record: no sender information at all
  { id: 'm10', groupName: 'QA Team', fromMe: false, sender: '', senderJid: '120363412963990597@g.us', kind: 'text', text: 'History message with no sender', ts: (base + 1600) * 1000 },
];
const dataPath = path.join(SCRATCH, 'messages.jsonl');
fs.writeFileSync(dataPath, fixture.map((f) => JSON.stringify({ groupJid: 'g@g.us', senderJid: 'x@s.whatsapp.net', ...f })).join('\n') + '\n');

const contactsPath = path.join(SCRATCH, 'contacts.json');
fs.writeFileSync(contactsPath, JSON.stringify({
  '120363412963990597@lid': 'Sam Rivers',
  '120363412963990597': 'Sam Rivers',
}));

const lidMapPath = path.join(SCRATCH, 'lid-pn.json');
fs.writeFileSync(lidMapPath, JSON.stringify({
  '111222333444555@lid': '6421234567@s.whatsapp.net',
}));

const { execFileSync } = require('child_process');
const stdout = execFileSync(process.execPath, [path.join(__dirname, '..', 'render.js')], {
  env: {
    ...process.env,
    WA_EXPORT_CONFIG: cfgPath,
    WA_EXPORT_DATA: dataPath,
    WA_EXPORT_CONTACTS: contactsPath,
    WA_EXPORT_LIDMAP: lidMapPath,
  },
  encoding: 'utf8',
});
console.log('--- render.js output ---');
console.log(stdout.trim());

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(path.relative(outDir, p));
  }
  return acc;
}
const files = walk(outDir).sort();
console.log('--- files produced ---');
for (const f of files) console.log('  ' + f);

check('ignores unconfigured group', files.some((f) => f.includes('Not A Configured')), false);
check('index written', files.includes('_index.md'), true);
check('per-day file written', files.some((f) => /Site Crew \d{4}-\d{2}-\d{2}\.md$/.test(f)), true);
check('full transcript written', files.some((f) => f.endsWith('full transcript.md')), true);
check('both active groups have folders', ['Site Crew', 'Alpha_Team Comms'].every((g) => files.some((f) => f.startsWith(g + path.sep))), true);
check('groups with no data reported as missing', stdout.includes('NOT FOUND') && stdout.includes('Project_Trust - Comms') && !stdout.includes('NOT FOUND: QA Team'), true);

const qaDay = files.find((f) => /QA Team \d{4}-\d{2}-\d{2}\.md$/.test(f));
const qaMd = fs.readFileSync(path.join(outDir, qaDay), 'utf8');
check('opaque LID resolves to contact name', qaMd.includes('— Sam Rivers**'), true);
check('unknown numeric sender labelled honestly', qaMd.includes('Unknown (999888777666555)'), true);
check('LID resolved to phone number via map', qaMd.includes('+64 21 234 567'), true);
check('group id never used as a sender name', qaMd.includes('— 1203634') === false, true);
check('history records labelled Unknown sender', qaMd.includes('Unknown sender'), true);
check('unattributed count noted in header', /Note:\*\* \d+ of these came from WhatsApp's history sync/.test(qaMd), true);
check('system noise filtered from render', qaMd.includes('[system]') || qaMd.includes('sys'), false);

const prepDay = files.find((f) => /Site Crew \d{4}-\d{2}-\d{2}\.md$/.test(f));
const md = fs.readFileSync(path.join(outDir, prepDay), 'utf8');
check('day file has sender + time', /\*\*\d{2}:\d{2} — Alex Brown\*\*/.test(md), true);
check('multiline body indented', md.includes('  I will confirm the crew.'), true);
check('fromMe marked', md.includes('_(you)_'), true);
check('own messages use configured myName', md.includes('— Test User**'), true);
check('photo tagged', md.includes('[photo] anchor layout'), true);

// ---- 5. entry points load cleanly -----------------------------------------
// `node --check` validates syntax only. A stale import is a runtime
// ReferenceError that takes the process down at startup and battery-passes
// every syntax check, so require() each entry point and prove it loads.
// They guard their main() behind require.main, so this connects to nothing.
process.env.WA_EXPORT_CONFIG = cfgPath;
process.env.WA_EXPORT_DATA = dataPath;
process.env.WA_EXPORT_CONTACTS = contactsPath;
process.env.WA_EXPORT_LIDMAP = lidMapPath;

for (const entry of ['listener.js', 'render.js', 'setup.js', 'backfill.js']) {
  let err = null;
  try {
    require(path.join(__dirname, '..', entry));
  } catch (e) {
    err = e;
  }
  check(`loads without runtime error: ${entry}`, err ? String(err.message) : null, null);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
