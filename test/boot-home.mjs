// Create (or refresh) a throwaway DSH home for the boot rehearsal and print its path.
// Its Desktop profile = the live profile's manifests with this plugin added as a
// bundle (linked from this checkout), node_modules by junction to the live ones.
//   ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" test/boot-home.mjs
// Remove it by deleting the two junctions first (cmd /c rmdir <path>): profiles/desktop/node_modules
// (→ the live profile's packages) and profiles/node_modules/dsh-agent-guardrails (→ this checkout).
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = join(repo, '.scratch', 'boot-home');
const profile = join(home, 'profiles', 'desktop');
const live = join(homedir(), '.dsh', 'profiles', 'desktop');
if (!existsSync(join(live, 'package.json'))) throw new Error(`no Desktop profile at ${live}`);
mkdirSync(profile, { recursive: true });
for (const file of ['cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
  if (existsSync(join(live, file))) copyFileSync(join(live, file), join(profile, file));
}
const manifest = JSON.parse(readFileSync(join(live, 'package.json'), 'utf8'));
const own = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).name;
manifest.dependencies = { ...manifest.dependencies, [own]: `link:${repo.replace(/\\/g, '/')}` };
const bundles = manifest.dsh?.profile?.bundles ?? [];
if (!bundles.includes(own)) manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, own] } };
writeFileSync(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const modules = join(profile, 'node_modules');
let linked = false;
try {
  linked = lstatSync(modules).isSymbolicLink();
} catch {}
if (!linked) {
  if (existsSync(modules)) throw new Error(`${modules} exists and is not a link`);
  symlinkSync(join(live, 'node_modules'), modules, 'junction');
}
// This plugin resolves through Node's parent-directory lookup (<home>/profiles/node_modules/<name>),
// so the live profile's node_modules is never written to.
const parentModules = join(home, 'profiles', 'node_modules');
mkdirSync(parentModules, { recursive: true });
const self = join(parentModules, own);
let selfLinked = false;
try {
  selfLinked = lstatSync(self).isSymbolicLink();
} catch {}
if (!selfLinked) symlinkSync(repo, self, 'junction');
console.log(home);
