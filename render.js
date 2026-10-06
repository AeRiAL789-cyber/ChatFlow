'use strict';

const fs = require('fs');
const path = require('path');
const { tzParts, normaliseName, safeFileName } = require('./lib/wa');
const { MessageStore } = require('./lib/store');
const { ContactBook, resolveSender } = require('./lib/contacts');
const { loadConfig } = require('./lib/config');

const ROOT = __dirname;
const CONFIG_PATH = process.env.WA_EXPORT_CONFIG || path.join(ROOT, 'config.json');
const DATA_PATH = process.env.WA_EXPORT_DATA || path.join(ROOT, 'data', 'messages.jsonl');
const CONTACTS_PATH = process.env.WA_EXPORT_CONTACTS || path.join(ROOT, 'data', 'contacts.json');
const LID_MAP_PATH = process.env.WA_EXPORT_LIDMAP || path.join(ROOT, 'data', 'lid-pn.json');
const cfg = loadConfig(ROOT);
const TZ = cfg.timezone || 'Pacific/Auckland';
// How your own messages are labelled in the exports.
const MY_NAME = cfg.myName || 'Me';

function loadLidMap() {
  const m = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(LID_MAP_PATH, 'utf8'));
    for (const [k, v] of Object.entries(raw)) m.set(k, v);
  } catch {
    /* none yet */
  }
  return m;
}

// ---- helpers -------------------------------------------------------------

function writeIfChanged(file, content) {
  if (fs.existsSync(file)) {
    try {
      if (fs.readFileSync(file, 'utf8') === content) return false;
    } catch {
      /* rewrite below */
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

function fmtDayHeading(day) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'UTC',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(dt);
}

function renderBlock(rec, book, lidMap) {
  const { day, time } = tzParts(rec.ts, TZ);
  const who = resolveSender(book, rec, lidMap, MY_NAME);
  const mine = rec.fromMe ? ' _(you)_' : '';
  let body;
  if (rec.kind && rec.kind !== 'text') {
    const label = `[${rec.kind}]`;
    body = rec.text ? `${label} ${rec.text}` : label;
  } else {
    body = rec.text || '';
  }
  const lines = body.split('\n');
  const quoted = lines.map((l, i) => (i === 0 ? l : `  ${l}`)).join('\n');
  return { day, time, text: `**${time} — ${who}**${mine}\n${quoted}` };
}

function header(groupName, subtitle, count, unattributed = 0) {
  const lines = [
    `# ${groupName} — WhatsApp export`,
    '',
    `- **Group:** ${groupName}`,
    `- **${subtitle}:** ${count} message${count === 1 ? '' : 's'}`,
    `- **Timezone:** ${TZ}`,
    `- **Source:** locally linked WhatsApp companion device (read-only export)`,
    `- **Generated:** ${new Date().toISOString()}`,
  ];
  if (unattributed) {
    lines.push(
      `- **Note:** ${unattributed} of these came from WhatsApp's history sync, which does not include the sender. ` +
      'They are marked "Unknown sender". Messages captured live from the linked device show full names.'
    );
  }
  lines.push('', '---', '');
  return lines.join('\n');
}

// ---- main ----------------------------------------------------------------

function main() {
  const only = process.argv.find((a) => a.startsWith('--group='));
  const store = new MessageStore(DATA_PATH);
  const book = new ContactBook(CONTACTS_PATH);
  const lidMap = loadLidMap();
  const all = store.readAll();

  if (!all.length) {
    console.log('No messages stored yet. Run listener.js and let it sync first.');
    return;
  }

  // Reduce stored group names onto the configured set.
  const wanted = new Map(cfg.groups.map((g) => [normaliseName(g), g]));
  const groupMessages = new Map();
  const stats = [];

  for (const rec of all) {
    const canon = wanted.get(normaliseName(rec.groupName));
    if (!canon) continue;
    if (rec.kind === 'system') continue; // joins/leaves/admin noise
    if (only && only !== `--group=${canon}`) continue;
    if (!groupMessages.has(canon)) groupMessages.set(canon, []);
    groupMessages.get(canon).push(rec);
  }

  const dayIndex = [];

  for (const [group, recs] of groupMessages) {
    recs.sort((a, b) => a.ts - b.ts);
    const dir = path.join(cfg.outputDir, safeFileName(group));
    const byDay = new Map();
    for (const r of recs) {
      const { day } = tzParts(r.ts, TZ);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(r);
    }

    // Daily files
    for (const [day, dayRecs] of [...byDay.entries()].sort()) {
      const blocks = dayRecs.map((r) => renderBlock(r, book, lidMap));
      const unattr = dayRecs.filter((r) => resolveSender(book, r, lidMap) === 'Unknown sender').length;
      const body = [header(group, 'Day', dayRecs.length, unattr), `## ${fmtDayHeading(day)}`, '', ...blocks.map((b) => b.text + '\n'), ''].join('\n');
      writeIfChanged(path.join(dir, `${safeFileName(group)} ${day}.md`), body);
    }

    // Full transcript
    const unattrAll = recs.filter((r) => resolveSender(book, r, lidMap) === 'Unknown sender').length;
    const parts = [header(group, 'Total messages', recs.length, unattrAll)];
    for (const [day, dayRecs] of [...byDay.entries()].sort()) {
      parts.push(`## ${fmtDayHeading(day)}`, '');
      for (const r of dayRecs) parts.push(renderBlock(r, book, lidMap).text + '\n');
    }
    writeIfChanged(path.join(dir, `${safeFileName(group)} - full transcript.md`), parts.join('\n'));

    const first = tzParts(recs[0].ts, TZ).day;
    const last = tzParts(recs[recs.length - 1].ts, TZ).day;
    stats.push({ group, count: recs.length, days: byDay.size, first, last });
  }

  // Index of everything we know about
  const missing = cfg.groups.filter((g) => !groupMessages.has(g));
  const idx = [
    '# WhatsApp export — index',
    '',
    `Generated: ${new Date().toISOString()} (${TZ})`,
    '',
    '| Group | Messages | Days | First | Last |',
    '| --- | --- | --- | --- | --- |',
    ...stats.map((s) => `| ${s.group} | ${s.count} | ${s.days} | ${s.first} | ${s.last} |`),
    '',
  ];
  if (missing.length) {
    idx.push('## Configured groups with no messages yet', '', ...missing.map((m) => `- ${m}`), '', '_Name mismatch or not linked yet — check config.json against the exact WhatsApp group subject._', '');
  }
  idx.push('Each group has its own folder containing a per-day file and a cumulative full transcript.', '');
  writeIfChanged(path.join(cfg.outputDir, '_index.md'), idx.join('\n'));

  for (const s of stats) console.log(`  ${s.group}: ${s.count} msgs across ${s.days} day(s) [${s.first} .. ${s.last}]`);
  if (missing.length) console.log(`  NOT FOUND: ${missing.join(' | ')}`);
  console.log(`Rendered to: ${cfg.outputDir}`);

  dayIndex.push(...stats);
  return dayIndex;
}

if (require.main === module) main();

module.exports = { main };
