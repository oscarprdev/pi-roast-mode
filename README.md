# 🔥 pi-roast-mode — Read-only Roast for Pi

[![npm](https://img.shields.io/npm/v/@oprdev/pi-roast-mode)](https://www.npmjs.com/package/@oprdev/pi-roast-mode) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@oprdev/pi-roast-mode` adds a read-only `/roast` collaboration mode to Pi. Roast mode questions, criticizes, and ranks the real flaws in a codebase — from the repository, with evidence — and produces an actionable hit list before any code mutation happens.

## ✨ Features

- Adds a state-aware `/roast` launch and management menu, plus `/roast start` for direct activation.
- Adds `--roast` to start a session in Roast mode.
- Enables built-in read-only tools by default while Roast mode is active.
- Disables extension and custom tools by default, with persistent pre-start Settings and a staged `/roast tools` compatibility shortcut for explicit user-risk opt-in.
- Blocks `update_plan`, mutating built-in tools, and unsafe `bash` forms such as writes, substitutions, background jobs, dependency installs, and mutating Git commands.
- Injects Roast mode instructions: ground every finding in evidence, rank by impact, propose the minimal concrete fix, and never pad a roast.
- Adds required `roast_mode_question` and `roast_mode_complete` tools for structured questions and a decision-complete roast.
- Presents the complete roast and lets you act on it, start a fresh linked session carrying only the approved roast, or export, save, stay, or discard.
- Exports ready, saved, or active roast outcomes with `/roast export [path]`.
- Shows Roast mode state in Pi's statusline as `roast active`, `roast ready`, `roast saved`, or `roast acting`.
- Persists Roast mode, one session-local saved outcome, and active follow-up state so resume and compaction retain the exact accepted roast.

## 📦 Install

```bash
pi install npm:@oprdev/pi-roast-mode
```

Try without installing permanently:

```bash
pi -e npm:@oprdev/pi-roast-mode
```

Try this package locally from the repository root:

```bash
pi -e ./package.json
```

## 🚀 Usage

```text
/roast
/roast start
/roast <prompt>
/roast tools
/roast show
/roast finish
/roast implement
/roast save
/roast export [path]
/roast exit
```

In TUI and RPC, use bare `/roast` to open the menu for the current Roast state. When Roast mode is off and no roast is stored, the launch menu shows the effective next-start tools and offers **Start Roast mode**, **Choose tools, then start…**, **Settings**, and **How Roast mode works**. Settings edits the persistent defaults for later workflows.

Use `/roast start` to enter Roast mode directly without sending a model message. Use `/roast <prompt>` to enter Roast mode and immediately submit `<prompt>` as the first Roast user message. `/roast show` displays the stored roast without starting a model turn. `/roast finish` asks the agent to complete the roast or ask one remaining material question; `/roast save` stores a completed roast for later and leaves Roast mode; `/roast export [path]` writes it to Markdown.

When Roast mode is active, the agent reads the files, runs read-only checks, and produces a ranked, evidence-backed roast. It does not edit files or implement a fix.

## ⚙️ Settings

Open **Settings** from an inactive `/roast` menu to edit the flat group of workflow choices: **Roast style**, **Roast thinking**, **Roast tools**, **After Implement**, **Export destination**, and **Roast mode shortcut**. The manual settings file is `$PI_CODING_AGENT_DIR/pi-roast-mode.json`.

**Roast style** sets the tone and depth of the roast. All styles propose fixes; only the strictness and wording differ. Every reply also opens with an acknowledgment phrase (e.g. "Good catch!" or "Absolutely.") regardless of style:

| Style | Tone |
|---|---|
| 🦆 `soft` | Gentle, constructive, educational — every finding is a teaching moment |
| 🧑‍💻 `mid` | Experienced, practical, direct — the balanced default |
| 🔥 `hard` | Deep, uncompromising — hunts edge cases, correctness, and broken invariants |
| 🗿 `linus` | Ruthless, no mercy — brutal but evidence-backed, and the question phrasing bites too. Questions are mandatory before completing: you always get a say on the highest-impact findings |

```json
{
  "thinkingLevel": "inherit",
  "roastStyle": "mid",
  "defaultRoastTools": ["read", "bash", "grep", "find", "ls"],
  "implementationRoastRetention": "keep",
  "defaultRoastExportPath": "ROAST.md"
}
```

## 🗂️ Package layout

```txt
packages/pi-roast-mode/
├── src/
│   ├── index.ts          # Pi package entrypoint
│   ├── roast-mode.ts     # Extension registration, mode state, and UI loading boundary
│   └── *.ts              # Prompt, policy, question, message, and menu modules
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

## 🔎 Keywords

Pi extension, Pi coding agent, roast, code review, evidence-based critique, actionable findings.

## 🙏 Acknowledgments

This project builds on [pi-extensions](https://github.com/narumiruna/pi-extensions), the collection of Pi extensions that served as the base and inspiration for this work. Thank you for the solid foundation.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).