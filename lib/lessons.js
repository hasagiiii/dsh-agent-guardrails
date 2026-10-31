/**
 * Lessons: short rules the agent follows, injected into its system prompt.
 *
 * - Built-in lessons ship with this plugin (`DEFAULT_LESSONS`).
 * - Learned lessons live in one local file, `<DSH home>/guardrails/lessons.json`,
 *   and grow when an agent records a new avoidable mistake through the
 *   `guardrail_add_lesson` tool. The file is plain JSON the user can edit.
 *
 * A lesson: { id, scope, rule, why?, source?, addedAt?, sessionId? }.
 * `scope` is `global` or a project root (absolute path); project lessons are
 * shown only in sessions whose working directory is inside that root.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Rules learned the hard way; each names the failure it prevents. */
export const DEFAULT_LESSONS = [
  {
    id: 'paths-copy-verbatim',
    rule: 'Use a file path only if it appeared verbatim in a tool result of this session; otherwise find it with Glob first. Never rebuild a path from memory or from sibling files.',
    why: 'A path typed from memory dropped a directory segment and the read failed.',
  },
  {
    id: 'read-before-edit',
    rule: 'Before edit/write on an existing file, read it with the read tool in this session (a few lines suffice); shell output such as Get-Content or cat does not count.',
    why: 'edit/write refused with "file has not been read" many times.',
  },
  {
    id: 'scripts-in-files',
    rule: 'Anything with quotes, $ or more than one statement that goes to another program (wsl, sh -c, node, python) is written to a file with the write tool and run as that file — never inline, never piped.',
    why: 'Inline scripts lost their quotes or gained CRLF and failed with syntax errors.',
  },
  {
    id: 'check-step-results',
    rule: 'When a step uses the output of an earlier step, confirm the earlier step succeeded and its value is non-empty first; stop at the first failure.',
    why: 'A failed step left a variable empty and the next command ran against a wrong path.',
  },
  {
    id: 'look-before-guessing',
    rule: 'Inspect before acting: dump the real DOM before clicking UI, read an API\'s generated descriptor or call it once before coding against it, and reproduce a reported bug before reading code to explain it.',
    why: 'Guessed selectors and API shapes caused long retry loops.',
  },
  {
    id: 'stuck-stop',
    rule: 'The same error twice in a row means stop, state the cause and change approach; after ~20 minutes without progress on one sub-problem, tell the user what is known and ask how to proceed.',
    why: 'Silent retries burned long stretches of time.',
  },
  {
    id: 'scratch-not-temp',
    rule: 'Keep scratch files inside the project (e.g. a gitignored .scratch/), not in TEMP; TEMP can differ between sandbox modes, so never reuse an expanded TEMP path.',
    why: 'TEMP changed with the sandbox mode and earlier paths no longer matched.',
  },
  {
    id: 'links-before-delete',
    rule: 'Before a recursive delete, check for junctions/symlinks to real data and remove the link itself first; never kill processes you did not start.',
    why: 'Test directories linked to the live profile\'s node_modules.',
  },
  {
    id: 'record-lessons',
    rule: 'After you hit an error that a known rule would have avoided, or a new avoidable mistake (wrong path, wrong syntax for this shell, missing prerequisite), call guardrail_add_lesson with a one-line rule, then tell the user what was added and where.',
    why: 'The same mistakes recurred across sessions.',
  },
];

/** `<DSH home>/guardrails/lessons.json`. */
export function lessonsFile(env = process.env) {
  const home = (env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh');
  return join(home, 'guardrails', 'lessons.json');
}

/** The learned lessons on disk; a missing or unreadable file reads as none. */
export function readLessons(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(value?.lessons) ? value.lessons : [];
    return list.filter((lesson) => typeof lesson?.rule === 'string' && lesson.rule.trim() && typeof lesson.id === 'string');
  } catch {
    return [];
  }
}

function writeLessons(file, lessons) {
  mkdirSync(dirname(file), { recursive: true });
  const body = {
    $comment: 'Rules DeepSeek Harness agents learned on this machine (dsh-agent-guardrails). Edit or delete entries freely; scope is "global" or a project root.',
    lessons,
  };
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
}

const normalize = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Word-set overlap of two rules, 0..1. */
function similarity(a, b) {
  const left = new Set(normalize(a).split(' ').filter((word) => word.length > 2));
  const right = new Set(normalize(b).split(' ').filter((word) => word.length > 2));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.min(left.size, right.size);
}

/** Same-path comparison across Windows spellings. */
const samePath = (a, b) => a.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase() === b.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
const inside = (path, root) => {
  const p = path.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const r = root.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  return p === r || p.startsWith(`${r}/`);
};

/**
 * Add one learned lesson. Near-duplicates of a built-in or learned lesson in
 * the same scope are refused, so the file does not fill with rephrasings.
 * @returns {{ added: boolean, lesson?: object, duplicateOf?: object, file: string }}
 */
export function addLesson(file, input, now = new Date()) {
  const rule = String(input.rule ?? '').trim().replace(/\s+/g, ' ');
  if (rule.length < 12) throw new Error('rule must be one complete sentence');
  if (rule.length > 400) throw new Error('rule must be at most 400 characters; keep it to one actionable sentence');
  const scope = input.scope && input.scope !== 'global' ? String(input.scope) : 'global';
  const learned = readLessons(file);
  const candidates = [...DEFAULT_LESSONS.map((lesson) => ({ ...lesson, scope: 'global', builtIn: true })), ...learned];
  const duplicate = candidates.find((lesson) => (lesson.scope === 'global' || samePath(lesson.scope, scope)) && similarity(lesson.rule, rule) >= 0.8);
  if (duplicate !== undefined) return { added: false, duplicateOf: duplicate, file };
  const lesson = {
    id: `learned-${now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`,
    scope,
    rule,
    ...(input.why ? { why: String(input.why).trim().slice(0, 400) } : {}),
    ...(input.sessionId ? { sessionId: String(input.sessionId) } : {}),
    addedAt: now.toISOString(),
  };
  writeLessons(file, [...learned, lesson]);
  return { added: true, lesson, file };
}

/** Lessons that apply to a working directory: built-ins, global learned ones, and those of an enclosing project. */
export function applicableLessons(file, cwd) {
  const learned = readLessons(file).filter((lesson) => lesson.scope === 'global' || (typeof cwd === 'string' && inside(cwd, lesson.scope)));
  return { builtIn: DEFAULT_LESSONS, learned };
}
