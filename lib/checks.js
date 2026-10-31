/**
 * Command checks run before a shell tool executes: known-bad forms are refused
 * with the reason and the form that works. Each check is a pure function of
 * the command text and the detected environment, so it is unit tested without
 * DeepSeek Harness.
 *
 * Only forms that fail every time are refused; a check never guesses intent.
 */

/** Strip single-quoted literals (PowerShell: '' escapes a quote) so their contents are not mistaken for syntax. */
function withoutSingleQuoted(command) {
  return command.replace(/'(?:[^']|'')*'/g, "''");
}

/** Strip both single- and double-quoted literals. */
function withoutQuoted(command) {
  return withoutSingleQuoted(command).replace(/"(?:[^"`]|`.)*"/g, '""');
}

/** Single-quoted literals of a command, unescaped. */
function singleQuoted(command) {
  return [...command.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1].replace(/''/g, "'"));
}

/** Statements of a command split on `;` and newlines outside quotes. */
function statements(command) {
  const out = [];
  let current = '';
  let quote;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === undefined && (char === ';' || char === '\n')) {
      out.push(current);
      current = '';
      continue;
    }
    if (quote === undefined && (char === "'" || char === '"')) quote = char;
    else if (quote === "'" && char === "'" && command[i + 1] === "'") {
      current += char + command[++i];
      continue;
    } else if (quote === '"' && char === '`') {
      current += char + (command[++i] ?? '');
      continue;
    } else if (char === quote) quote = undefined;
    current += char;
  }
  out.push(current);
  return out.map((statement) => statement.trim()).filter(Boolean);
}

/** Native programs whose argument splitting breaks on embedded double quotes under Windows PowerShell 5.1. */
const NATIVE = /(^|[\s;|(&])(?:wsl(?:\.exe)?|sh|bash|cmd(?:\.exe)?|node(?:\.exe)?|python3?(?:\.exe)?|git)\b/i;

/**
 * @typedef {object} Environment
 * @property {boolean} windowsPowerShell - the pwsh tool runs Windows PowerShell 5.1 (not PowerShell 7).
 * @property {boolean} nodeOnPath - a `node` executable is on PATH.
 * @property {string} [nodeCommand] - how to run Node instead, when it is not on PATH.
 * @property {boolean} scriptsBlocked - the execution policy refuses unsigned local .ps1 files.
 */

/**
 * One check: `match(command, env)` returns undefined when the command is fine,
 * else `{ reason, instead }` naming why it fails and the form that works.
 * @type {{ id: string, shells: string[], match: (command: string, env: Environment) => ({ reason: string, instead: string } | undefined) }[]}
 */
export const CHECKS = [
  {
    id: 'ps51-operators',
    shells: ['pwsh'],
    match(command, env) {
      if (!env.windowsPowerShell) return undefined;
      const code = withoutQuoted(command);
      const found = [];
      if (/&&/.test(code)) found.push('&&');
      if (/\|\|/.test(code)) found.push('||');
      if (/<<<|<<\s*['"]?[A-Za-z_]+['"]?\s*$/m.test(code)) found.push('here-string redirection (<<< / <<EOF)');
      if (/\?\?/.test(code)) found.push('??');
      if (found.length === 0) return undefined;
      return {
        reason: `Windows PowerShell 5.1 has no ${found.join(', ')}: the command will not parse.`,
        instead: 'Separate statements with ";" and test $LASTEXITCODE / $? explicitly; put multi-line input into a file written with the write tool.',
      };
    },
  },
  {
    id: 'ps51-utf8nobom',
    shells: ['pwsh'],
    match(command, env) {
      if (!env.windowsPowerShell || !/-Encoding\s+utf8NoBOM\b/i.test(command)) return undefined;
      return {
        reason: 'Windows PowerShell 5.1 has no -Encoding utf8NoBOM.',
        instead: 'Write the file with the write tool (UTF-8 without BOM), or use -Encoding ascii for ASCII-only content.',
      };
    },
  },
  {
    id: 'native-embedded-quotes',
    shells: ['pwsh'],
    match(command, env) {
      if (!env.windowsPowerShell) return undefined;
      // A single-quoted argument holding a double quote, handed to a native program (wsl, sh -c, node -e, …).
      for (const segment of statements(command)) {
        if (!NATIVE.test(withoutQuoted(segment))) continue;
        if (singleQuoted(segment).some((literal) => literal.includes('"'))) {
          return {
            reason: 'Windows PowerShell 5.1 passes double quotes inside an argument to a native program without escaping them, so the program receives the argument split apart (e.g. `sh -c` reports "unexpected end of file").',
            instead: 'Write the script to a file with the write tool and run the file (wsl -d <distro> -e sh /mnt/…/script.sh, or the Node runner with script.mjs). For one-liners keep arguments free of double quotes.',
          };
        }
      }
      return undefined;
    },
  },
  {
    id: 'node-inline',
    shells: ['pwsh'],
    match(command) {
      // `node -e …`, or a Node runner such as an Electron binary run as Node (`… .exe' -e …`).
      if (!/(?:\bnode(?:\.exe)?|\.exe['"]?)\s+(?:--[\w-]+(?:=\S+)?\s+)*(?:-e|--eval|-p|--print)\s/i.test(`${command} `)) return undefined;
      return {
        reason: 'Inline `-e` scripts lose their quotes on the way through PowerShell 5.1 and fail with syntax errors.',
        instead: 'Write the script to a .mjs/.cjs file with the write tool and run that file.',
      };
    },
  },
  {
    id: 'node-not-on-path',
    shells: ['pwsh'],
    match(command, env) {
      if (env.nodeOnPath || env.nodeCommand === undefined) return undefined;
      if (!/(^|[\s;&|(])node(?:\.exe)?\s/i.test(` ${withoutQuoted(command)}`)) return undefined;
      return {
        reason: 'There is no `node` on PATH here.',
        instead: `Run Node as: ${env.nodeCommand} script.mjs`,
      };
    },
  },
  {
    id: 'pipe-script-to-wsl',
    shells: ['pwsh'],
    match(command) {
      if (!/\|\s*wsl(?:\.exe)?\b/i.test(withoutQuoted(command))) return undefined;
      return {
        reason: 'Piping text from PowerShell 5.1 into wsl adds CRLF line endings and re-encodes it; the shell inside sees a broken script.',
        instead: 'Write the script to a file with the write tool and run it: wsl -d <distro> -e sh /mnt/<drive>/…/script.sh',
      };
    },
  },
  {
    id: 'run-new-ps1',
    shells: ['pwsh'],
    match(command, env) {
      if (!env.scriptsBlocked) return undefined;
      // A statement (or pipeline stage, or assignment's right side) that runs a .ps1: `& x.ps1`, `. x.ps1`, `.\x.ps1`, `x.ps1`.
      const runs = statements(command).some((statement) => {
        if (/-ExecutionPolicy\s+Bypass/i.test(statement)) return false;
        const head = statement.replace(/^\$[\w:]+\s*=\s*/, '').split('|')[0].trim();
        return /^(?:[&.]\s*)?['"]?[^\s'"]*\.ps1['"]?(\s|$)/i.test(head);
      });
      if (!runs) return undefined;
      return {
        reason: 'The execution policy here refuses unsigned local .ps1 scripts ("not digitally signed").',
        instead: 'Write the script as .mjs and run it with the Node runner, or run a .ps1 with: powershell -NoProfile -ExecutionPolicy Bypass -File <script.ps1>',
      };
    },
  },
];

/**
 * Run every check for one shell tool's command.
 * @param {'pwsh' | 'bash'} shell
 * @returns {{ id: string, reason: string, instead: string }[]} the failures, empty when the command is fine.
 */
export function checkCommand(shell, command, env, disabled = []) {
  if (typeof command !== 'string' || command.length === 0) return [];
  const failures = [];
  for (const check of CHECKS) {
    if (!check.shells.includes(shell) || disabled.includes(check.id)) continue;
    const found = check.match(command, env);
    if (found !== undefined) failures.push({ id: check.id, ...found });
  }
  return failures;
}

/** The message the model receives for a refused command. */
export function refusal(failures) {
  const lines = ['This command was not run because it fails every time in this environment (guardrails):'];
  for (const failure of failures) lines.push(`- [${failure.id}] ${failure.reason}\n  Instead: ${failure.instead}`);
  lines.push('Fix the command as described and run it again. If this check is wrong for this command, say so to the user.');
  return lines.join('\n');
}
