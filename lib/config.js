'use strict';

/**
 * Loads config.json, with a readable message when it is missing.
 *
 * config.json is deliberately gitignored: it names the operator's real group
 * subjects and output folder. A fresh clone only has config.example.json.
 */

const fs = require('fs');
const path = require('path');

function loadConfig(root) {
  const file = process.env.WA_EXPORT_CONFIG || path.join(root, 'config.json');

  if (!fs.existsSync(file)) {
    console.error('');
    console.error('No config file found at:');
    console.error('  ' + file);
    console.error('');
    console.error('Create one by copying the example:');
    console.error('  copy config.example.json config.json      (Windows)');
    console.error('  cp config.example.json config.json        (bash)');
    console.error('');
    console.error('Then edit it: list the exact WhatsApp group subjects you want,');
    console.error('and the folder the markdown exports should be written to.');
    console.error('');
    process.exit(1);
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`Config file is not valid JSON (${file}):`);
    console.error('  ' + err.message);
    process.exit(1);
  }
}

module.exports = { loadConfig };
