// Boot the real Desktop composition plus dsh-agent-guardrails in a throwaway DSH home and check:
// the prompt section is assembled, the pwsh gate refuses a known-bad command and lets a good one
// through, and guardrail_add_lesson writes the lessons file.
//   ELECTRON_RUN_AS_NODE=1 DSH_ROOT=<dsh runtime> "DeepSeek Harness.exe" test/boot-home.mjs   (prints <home>)
//   DSH_HOME=<home> "DeepSeek Harness.exe" --expose-internals --import ./test/resolve-boot.mjs \
//     test/boot.mjs <home>/profiles/desktop <cwd>
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadLayeredEnv, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';

const [projectDir, cwd] = process.argv.slice(2);
const installAnchor = join(process.env.DSH_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
const app = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: 'desktop',
  resolvedProfile: { profile: loadProfileDirectory('dsh', projectDir, installAnchor), installAnchor },
  patchFiles: [],
  args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
});
const { ctx } = app;
let failed = false;
try {
  const gateway = ctx.get('typertGateway');
  const peer = ctx.get('connection').browserPeer;
  const created = await gateway.dispatchRpc('session/create', { args: { request: { cwd } } }, new AbortController().signal, peer);
  assert.ok(created.ok, JSON.stringify(created.error));
  const agent = await ctx.get('agents').resolve?.(created.value.sessionId) ?? ctx.get('agents').get(created.value.sessionId);
  assert.ok(agent, 'agent');

  // 1. Prompt section.
  const assembly = await ctx.get('systemPrompt').assemble({ scope: agent });
  const section = assembly.sections.find((entry) => entry.name === 'guardrails:lessons');
  assert.ok(section, `section present; got ${assembly.sections.map((entry) => entry.name).join(', ')}`);
  console.log('--- section ---\n' + section.text + '\n---');
  assert.match(section.text, /read it with the read tool/);

  // 2. Gate: through the real tool pipeline.
  const tools = ctx.get('tools');
  const run = (name, args) => tools.execute({ name, arguments: args, agent, callId: `t-${Math.random().toString(36).slice(2)}`, signal: new AbortController().signal });
  const bad = await run('pwsh', { description: 'bad', command: `wsl -d Ubuntu-26.04 -e sh -c 'echo "x"; for a in b; do echo "$a"; done'` });
  console.log('bad ->', bad.isError, JSON.stringify(bad.content).slice(0, 240));
  assert.equal(bad.isError, true);
  assert.match(JSON.stringify(bad.content), /native-embedded-quotes/);
  const good = await run('pwsh', { description: 'good', command: 'Write-Output guardrails-ok' });
  console.log('good ->', good.isError, JSON.stringify(good.content).slice(0, 160));
  // The gate let it through: it ran (or failed inside the shell/sandbox), not refused by guardrails.
  assert.doesNotMatch(JSON.stringify(good.content), /not run because it fails every time/);

  // 3. Learning tool.
  const file = join(process.env.DSH_HOME, 'guardrails', 'lessons.json');
  const learned = await run('guardrail_add_lesson', { rule: 'Close the headless Chrome you started with Browser.close before you finish the task.', why: 'a test browser was left running', scope: 'global' });
  console.log('learn ->', learned.isError, JSON.stringify(learned.content).slice(0, 300));
  assert.equal(learned.isError, false);
  assert.ok(existsSync(file), 'lessons file written');
  assert.match(readFileSync(file, 'utf8'), /headless Chrome/);
  const after = await ctx.get('systemPrompt').assemble({ scope: agent });
  assert.match(after.sections.find((entry) => entry.name === 'guardrails:lessons').text, /headless Chrome/, 'learned rule is in the next prompt');
  console.log('GUARDRAILS BOOT PASSED');
} catch (error) {
  failed = true;
  console.error('GUARDRAILS BOOT FAILED', error);
} finally {
  await Promise.race([app.shutdown.shutdown(0), new Promise((r) => setTimeout(r, 10000))]);
  process.exit(failed ? 1 : 0);
}
