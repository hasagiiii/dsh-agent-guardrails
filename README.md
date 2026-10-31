# dsh-agent-guardrails

A DeepSeek Harness plugin that keeps agents from repeating the same mistakes.

## What it does

1. **Rules in every system prompt** (section `guardrails:lessons`):
   - built-in lessons (`lib/lessons.js`), each written after a real, repeated failure: copy paths instead of reconstructing them, read before edit, scripts go into files, check a step before using its result, look before guessing, stop when stuck, keep scratch files in the project, mind junctions before deleting, record new lessons;
   - lessons learned on this machine, from `<DSH home>/guardrails/lessons.json` (`~/.dsh/guardrails/lessons.json`); project-scoped ones only in sessions inside that project;
   - environment facts detected at startup instead of written by hand: which PowerShell the `pwsh` tool runs (Windows PowerShell 5.1 or PowerShell 7), whether `node` is on PATH and how to run Node otherwise, whether the execution policy blocks local `.ps1` files, and the WSL distributions.
2. **A gate before shell commands run** (`tools/pre-execute` on `pwsh`/`bash`): forms that fail every time here are refused, with the reason and the form that works. The command never runs. Current checks (`lib/checks.js`):

   | id | refuses | when |
   |---|---|---|
   | `ps51-operators` | `&&`, `\|\|`, `??`, `<<<`, `<<EOF` | Windows PowerShell 5.1 |
   | `ps51-utf8nobom` | `-Encoding utf8NoBOM` | Windows PowerShell 5.1 |
   | `native-embedded-quotes` | a single-quoted argument containing `"` passed to `wsl`, `sh`, `bash`, `cmd`, `node`, `python`, `git` | Windows PowerShell 5.1 |
   | `node-inline` | `node -e …` or an Electron binary run as Node with `-e` | always |
   | `node-not-on-path` | `node …` | no `node` on PATH |
   | `pipe-script-to-wsl` | `… \| wsl …` | always |
   | `run-new-ps1` | running a `.ps1` without `-ExecutionPolicy Bypass` | the policy refuses local scripts (`Restricted`, `AllSigned`; not `RemoteSigned`) |

   A command that a check refuses wrongly can opt out of that one check with a trailing comment, `# guardrails: allow <id>`; the refusal tells the agent to do this only after verifying, and to tell the user why.

3. **Self-evolution**: the `guardrail_add_lesson` tool. After an avoidable mistake the agent records a one-line rule (global, or for the current project). Near-duplicates of an existing rule are refused. The tool result names the rule and the file, and tells the agent to report both to the user; the rule is in the prompt of every later session. The file is plain JSON: edit or delete entries freely.

## Install

```powershell
git clone <this repository> F:\proj\dsh-agent-guardrails
dsh plugin --profile desktop add F:\proj\dsh-agent-guardrails
```

It replaces no built-in component, so enabling or disabling it in the plugin manager takes effect without a restart.

## Configuration

| field | default | meaning |
|---|---|---|
| `checks` | `true` | refuse commands that fail every time here |
| `disabledChecks` | `[]` | check ids to skip |
| `learning` | `true` | offer `guardrail_add_lesson` and the rule to use it |
| `sectionOrder` | `9000` | prompt section order |

## Development

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'; $env:DSH_ROOT = 'D:/dsh/resources/app.asar/dsh'
$dsh = 'D:\dsh\DeepSeek Harness.exe'
& $dsh --import ./test/stub.mjs test/unit.mjs        # checks, lessons, prompt text
# boot the real Desktop composition with this plugin in a throwaway DSH home
$h = & $dsh test/boot-home.mjs
$env:DSH_HOME = $h; $env:DSH_TELEMETRY_DISABLED = '1'; $env:DSH_CLIENT_VERSION = '0.2.1-rc.5'
& $dsh --expose-internals --import ./test/resolve-boot.mjs test/boot.mjs "$h\profiles\desktop" (Get-Location).Path
```

Add a check: write it in `lib/checks.js` with the exact failing command as a unit test case, plus a working form that must stay allowed. A check refuses only forms that fail every time; anything situational belongs in a lesson instead.
