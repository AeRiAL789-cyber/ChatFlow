# ChatFlow

Archive WhatsApp group chats into readable Markdown files, continuously and
unattended.

ChatFlow links to your WhatsApp once as a companion device (the same mechanism
WhatsApp Web and Desktop use), then records every message in the group chats you
choose and writes them out as plain Markdown — one file per chat per day, plus a
cumulative transcript. No cloud service, no account, no upload: everything runs
locally and lands in a folder you pick.

Part of the FlowSuite family of tools.

## What you get

```
exports/
  _index.md                                  overview of every chat
  Site Crew/
    Site Crew 2026-10-06.md                  that day's messages
    Site Crew - full transcript.md           everything, cumulative
```

Each message is written with a local timestamp, the sender, and a tag for
non-text content:

```markdown
**09:14 — Alex Brown**
Start is Thursday 0900

**09:16 — You** _(you)_
Copy that.
  I will confirm the crew.

**09:22 — Alex Brown**
[photo] anchor pad poured
```

## Quickstart

Requires **Node 18 or newer**.

```bash
git clone https://github.com/AeRiAL789-cyber/ChatFlow.git
cd ChatFlow
npm install
npm run setup
```

`npm run setup` is a short interactive wizard:

1. **Pick an output folder** for the Markdown files.
2. **Link your phone** — it prints a QR code. On your phone open
   *WhatsApp → Settings → Linked devices → Link a device* and scan it.
3. **Choose your chats** — ChatFlow lists every group on the account and you
   pick by number (`1,4,7-9`, or `all`). No need to type exact group names.

Then start capturing:

```bash
npm start
```

Leave that running. Messages are written to disk as they arrive, and the
Markdown is rebuilt every 15 minutes. To rebuild it by hand at any time:

```bash
npm run render
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run setup` | First run: link the device and choose chats |
| `npm start` | Capture continuously (leave running) |
| `npm run render` | Rebuild the Markdown from what is stored |
| `npm run backfill` | Ask WhatsApp for older history, text only |
| `npm test` | Run the offline test suite |

On Windows there are also double-click wrappers (`Start WhatsApp Export.cmd`,
`WhatsApp Export Status.cmd`, `Stop WhatsApp Export.cmd`, `Render now.cmd`) and
`service-run.cmd`, a watchdog loop that restarts capture if it ever dies.

## Configuration

`config.json` is created by the setup wizard and is **gitignored** — it is yours,
and it names your own chats and folders.

```json
{
  "groups": ["Site Crew", "QA Team"],
  "outputDir": "C:/Users/you/Documents/ChatFlow exports",
  "myName": "You",
  "renderEveryMinutes": 15,
  "timezone": "Pacific/Auckland"
}
```

- `groups` — chat subjects to archive. Matched loosely, so punctuation and
  capitalisation differences between clients don't matter.
- `myName` — how your own messages are labelled.
- `renderEveryMinutes` — how often the Markdown is rebuilt.

Copy `config.example.json` to `config.json` if you'd rather edit it by hand.

## How it works

```
phone --linked device--> listener.js --> data/messages.jsonl --> render.js --> *.md
                             |                                       |
                       contact names,                         group / day
                       LID to phone map                       bucketing
```

- `listener.js` holds the connection open and appends each message to an
  append-only JSONL store, de-duplicated by message id (WhatsApp redelivers
  constantly, so this matters).
- Names are resolved at **render** time, not capture time, so a name learned
  later is applied retroactively to messages already stored.
- Sender identifiers are WhatsApp LIDs. Group metadata supplies a LID to phone
  number map, and contact updates supply real names, so exports show people
  rather than numbers.

## Known limits

These are WhatsApp's behaviour, not bugs in ChatFlow.

- **History sync does not say who sent a message.** For any group message sent
  *before* you linked, WhatsApp sends the text, the timestamp and the group, but
  no sender. Those are labelled `Unknown sender` and each file header says how
  many it affects. Re-linking does not change this — the phone genuinely does
  not send it. Everything captured from the moment you link is fully attributed.
- **Only recent history is sent.** `npm run backfill` can pull older messages on
  demand, but text only.
- **Nobody can guarantee an unofficial client won't break.** WhatsApp changes
  its protocol; if capture stops, check `npm test` and update Baileys.
- Deleting `data/` loses anything not yet rendered into Markdown.

## Security and privacy

Read this before you run it.

- **`auth/` is a live WhatsApp session**, equivalent to a logged-in device. It
  contains your credentials, pre-keys, session records and an address-book-wide
  LID to phone-number map. Anyone who copies that folder can read your chats.
  It is gitignored. Keep it that way, and don't back it up to shared storage.
- **`data/` holds everything you archived**, including other people's messages
  and phone numbers. Also gitignored for good reason.
- ChatFlow only ever writes the chats you selected. Other conversations are
  ignored and never hit the disk.
- It never sends anything. There is no code path that posts a message.
- Your archived output is plain text on your own machine. Treat it like any
  other record of a private conversation.

## Disclaimer

This is an **unofficial** client. It is not affiliated with, endorsed by, or
supported by WhatsApp or Meta, and it uses an undocumented protocol. Using it
may violate WhatsApp's Terms of Service and carries a risk of the linked number
being restricted or banned. A throwaway or secondary number is safer than your
primary one. Use at your own risk.

## License

MIT
