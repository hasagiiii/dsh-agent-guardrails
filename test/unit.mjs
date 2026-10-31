/**
 * Unit checks without DeepSeek Harness. The command cases are the commands
 * that actually failed in past sessions, plus forms that must keep working.
 *   ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" --import ./test/stub.mjs test/unit.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCommand, refusal } from '../lib/checks.js';
import { environmentLines } from '../lib/environment.js';
import { DEFAULT_LESSONS, addLesson, applicableLessons, readLessons } from '../lib/lessons.js';
import { lessonResultText, sectionText, shellOf } from '../index.js';

let failures = 0;
async function test(name, body) {
  try {
    await body();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}\n     ${error.stack}`);
  }
}

const ps51 = { platform: 'win32', shell: 'Windows PowerShell 5.1', windowsPowerShell: true, nodeOnPath: false, nodeCommand: "$env:ELECTRON_RUN_AS_NODE='1'; & 'D:\\dsh\\DeepSeek Harness.exe'", scriptsBlocked: true, distros: ['Ubuntu-26.04'] };
const ps7 = { ...ps51, shell: 'PowerShell 7', windowsPowerShell: false, nodeOnPath: true, scriptsBlocked: false };
const ids = (command, env = ps51) => checkCommand('pwsh', command, env).map((failure) => failure.id);

await test('refuses the commands that failed in past sessions', () => {
  assert.deepEqual(ids(`wsl -d Ubuntu-26.04 -e sh -c 'cd ~/.dsh/profiles/web/node_modules && for p in a b; do printf "%s " "$p"; grep -m1 "\\"version\\"" "$p/package.json"; done'`), ['native-embedded-quotes']);
  assert.deepEqual(ids(`wsl -d Ubuntu-26.04 -e sh -c 'ls -la --time-style=+%H:%M:%S ~/.dsh/sessions; for d in */; do echo "== $d"; done'`), ['native-embedded-quotes']);
  assert.deepEqual(ids(`$env:ELECTRON_RUN_AS_NODE='1'; & 'D:\\dsh\\DeepSeek Harness.exe' -e "const fs=require('fs');console.log(1)"`), ['node-inline']);
  assert.deepEqual(ids(`$s | wsl -d Ubuntu-26.04 -e bash -lc 'bash -s'`), ['pipe-script-to-wsl']);
  assert.deepEqual(ids(`$h = & .scratch/boot-home.ps1`), ['run-new-ps1']);
  assert.deepEqual(ids(`'{}' | Set-Content x.json -Encoding utf8NoBOM`), ['ps51-utf8nobom']);
  assert.deepEqual(ids(`git add -A && git commit -m x`), ['ps51-operators']);
  assert.deepEqual(ids(`git commit -q -F - <<< $null`), ['ps51-operators']);
});

await test('lets working forms through', () => {
  const fine = [
    `wsl -d Ubuntu-26.04 -e sh /mnt/f/proj/x/.scratch/state.sh`,
    `wsl -d Ubuntu-26.04 -e grep -m1 -H '"version"' /home/me/a/package.json`.replace(`'"version"'`, `version`),
    `wsl -d Ubuntu-26.04 -e ls -la /home/me`,
    `$env:ELECTRON_RUN_AS_NODE='1'; & 'D:\\dsh\\DeepSeek Harness.exe' .scratch/extract.cjs dsh-tools`,
    `powershell -NoProfile -ExecutionPolicy Bypass -File .scratch/x.ps1`,
    `Get-Content 'a && b.txt'`,
    `Write-Output "x || y"`,
    `git log --oneline -3; git status --short`,
    `Get-ChildItem *.ps1`,
  ];
  for (const command of fine) assert.deepEqual(ids(command), [], command);
});

await test('environment decides: PowerShell 7 accepts what 5.1 rejects', () => {
  assert.deepEqual(ids('git add -A && git commit -m x', ps7), []);
  assert.deepEqual(ids(`wsl -e sh -c 'echo "x"'`, ps7), []);
  assert.deepEqual(ids('& ./build.ps1', ps7), [], 'scripts are not blocked there');
  assert.deepEqual(ids('node -e "1"', ps7), ['node-inline'], 'inline -e stays fragile');
  assert.deepEqual(ids('node tools/x.mjs'), ['node-not-on-path']);
  assert.deepEqual(ids('node tools/x.mjs', ps7), []);
  assert.deepEqual(checkCommand('bash', 'a && b', ps51), [], 'bash tool is not PowerShell');
  assert.deepEqual(checkCommand('pwsh', 'a && b', ps51, ['ps51-operators']), [], 'disabled checks');
});

await test('the refusal names the reason and the working form', () => {
  const text = refusal(checkCommand('pwsh', `$s | wsl -e bash -s`, ps51));
  assert.match(text, /not run/);
  assert.match(text, /\[pipe-script-to-wsl\]/);
  assert.match(text, /Instead: Write the script to a file/);
});

await test('environment facts become prompt lines', () => {
  const lines = environmentLines(ps51).join('\n');
  assert.match(lines, /Windows PowerShell 5\.1/);
  assert.match(lines, /no node on PATH; run Node as: \$env:ELECTRON_RUN_AS_NODE='1'/);
  assert.match(lines, /\.ps1/);
  assert.match(lines, /Ubuntu-26\.04/);
  assert.deepEqual(environmentLines({ platform: 'linux' }), []);
});

await test('lessons: learned rules are stored, deduplicated and scoped', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'guardrails-')), 'guardrails', 'lessons.json');
  assert.deepEqual(readLessons(file), [], 'no file yet');
  const added = addLesson(file, { rule: 'Extract a DSH package from app.asar before grepping it; Grep cannot see inside the asar.', why: 'grep on an unextracted package failed', scope: 'global' }, new Date('2026-10-31T00:00:00Z'));
  assert.equal(added.added, true);
  assert.equal(readLessons(file).length, 1);
  assert.match(readFileSync(file, 'utf8'), /\$comment/);
  const again = addLesson(file, { rule: 'Extract the DSH package out of app.asar before you grep it, Grep cannot see inside asar.', scope: 'global' });
  assert.equal(again.added, false, 'a rephrasing is refused');
  const builtIn = addLesson(file, { rule: 'Before edit or write on an existing file, read it with the read tool in this session; shell output does not count.' });
  assert.equal(builtIn.added, false, 'a built-in rule is not re-added');
  assert.equal(builtIn.duplicateOf.builtIn, true);
  const project = addLesson(file, { rule: 'In dsh-wsl-remote, bump AGENT_VERSION whenever server/* or lib/mux.js change.', scope: 'F:\\proj\\dsh-wsl-remote' });
  assert.equal(project.added, true);
  assert.equal(applicableLessons(file, 'F:\\proj\\dsh-wsl-remote\\lib').learned.length, 2, 'inside the project: global + project');
  assert.equal(applicableLessons(file, 'F:\\proj\\other').learned.length, 1, 'elsewhere: global only');
  assert.throws(() => addLesson(file, { rule: 'short' }), /one complete sentence/);
});

await test('prompt section and tool result say what was added and where', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'guardrails-')), 'lessons.json');
  const result = addLesson(file, { rule: 'Close the headless Chrome you started with Browser.close before finishing the task.', scope: 'global' });
  const section = sectionText({ file, cwd: 'F:\\proj\\x', environment: ps51, learning: true });
  for (const lesson of DEFAULT_LESSONS) assert.ok(section.includes(lesson.rule), lesson.id);
  assert.ok(section.includes('Close the headless Chrome'), 'learned rule is in the prompt');
  assert.ok(section.includes(file), 'the prompt names the file');
  assert.match(section, /Environment \(detected at startup\)/);
  assert.ok(!sectionText({ file, cwd: undefined, environment: ps51, learning: false }).includes('guardrail_add_lesson'), 'no learning rule when learning is off');
  const text = lessonResultText(result);
  assert.ok(text.includes(file) && text.includes('tell the user'));
});

await test('which tools are shells', () => {
  assert.equal(shellOf('pwsh'), 'pwsh');
  assert.equal(shellOf('pwsh_persistent'), 'pwsh');
  assert.equal(shellOf('bash'), 'bash');
  assert.equal(shellOf('read'), undefined);
});

process.exitCode = failures === 0 ? 0 : 1;
