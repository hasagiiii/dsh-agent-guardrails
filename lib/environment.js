/**
 * Facts about the machine the agent's commands run on, detected once at
 * startup instead of written into rules: which PowerShell the pwsh tool runs,
 * whether `node` is on PATH and how to run Node otherwise, whether unsigned
 * local scripts are refused, and the WSL distributions.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const run = (file, args, timeoutMs = 8000) => new Promise((resolve) => {
  execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: 'buffer' }, (error, stdout) => {
    resolve(error ? undefined : stdout);
  });
});

const onPath = (names, env) => {
  for (const dir of String(env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) if (existsSync(join(dir, name))) return join(dir, name);
  }
  return undefined;
};

/** The shell the pwsh tool resolves first: PowerShell 7 if installed, else Windows PowerShell 5.1. */
function pwshPath(env) {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  for (const candidate of [join(programFiles, 'PowerShell', '7', 'pwsh.exe'), join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe')]) {
    if (existsSync(candidate)) return candidate;
  }
  return onPath(['pwsh.exe'], env);
}

/**
 * @returns {Promise<import('./checks.js').Environment & { platform: string, shell: string, distros: string[], nodeRunner?: string }>}
 */
export async function detectEnvironment({ env = process.env, platform = process.platform, execPath = process.execPath } = {}) {
  if (platform !== 'win32') {
    return { platform, shell: 'bash', windowsPowerShell: false, nodeOnPath: Boolean(onPath(['node'], env)), scriptsBlocked: false, distros: [] };
  }
  const pwsh = pwshPath(env);
  const windowsPowerShell = pwsh === undefined;
  const nodeOnPath = Boolean(onPath(['node.exe'], env));
  // Inside DeepSeek Harness Desktop the Host itself is an Electron binary that runs as Node.
  const electron = /\.exe$/i.test(execPath) && !/[\\/]node\.exe$/i.test(execPath) ? execPath : undefined;
  const nodeCommand = nodeOnPath ? 'node' : electron ? `$env:ELECTRON_RUN_AS_NODE='1'; & '${electron}'` : undefined;
  let scriptsBlocked = false;
  const policy = await run(windowsPowerShell ? 'powershell.exe' : pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy']);
  // RemoteSigned refuses only downloaded (zone-marked) scripts; local files run. Restricted and AllSigned refuse local ones.
  if (policy !== undefined) scriptsBlocked = /^(Restricted|AllSigned)\b/i.test(policy.toString('utf8').trim());
  let distros = [];
  const list = await run('wsl.exe', ['--list', '--quiet']);
  if (list !== undefined) {
    const text = list.includes(0) ? list.toString('utf16le') : list.toString('utf8');
    distros = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^docker-desktop/.test(line));
  }
  return {
    platform,
    shell: windowsPowerShell ? 'Windows PowerShell 5.1' : `PowerShell 7 (${pwsh})`,
    windowsPowerShell,
    nodeOnPath,
    ...(nodeCommand ? { nodeCommand } : {}),
    scriptsBlocked,
    distros,
  };
}

/** Environment facts as prompt lines. */
export function environmentLines(environment) {
  if (environment.platform !== 'win32') return [];
  const lines = [`The pwsh tool runs ${environment.shell}.`];
  if (environment.windowsPowerShell) lines.push('Windows PowerShell 5.1 has no &&, ||, ??, <<< or -Encoding utf8NoBOM, and passes double quotes inside native-program arguments unescaped.');
  if (!environment.nodeOnPath && environment.nodeCommand) lines.push(`There is no node on PATH; run Node as: ${environment.nodeCommand} script.mjs (a GUI executable: let the command wait for it).`);
  if (environment.scriptsBlocked) lines.push('The execution policy refuses unsigned local .ps1 files: do not write .ps1 scripts to run.');
  if (environment.distros.length > 0) lines.push(`WSL distributions: ${environment.distros.join(', ')} (wsl -d <name> -e sh /mnt/<drive>/…/script.sh).`);
  return lines;
}
