/**
 * dsh-agent-guardrails — keeps DeepSeek Harness agents from repeating mistakes.
 *
 * 1. Rules in the system prompt: built-in lessons, lessons learned on this
 *    machine (`<DSH home>/guardrails/lessons.json`), and environment facts
 *    detected at startup (which PowerShell, how to run Node, execution policy,
 *    WSL distributions).
 * 2. A gate before shell tools run: command forms that fail every time here
 *    are refused with the reason and the form that works.
 * 3. Self-evolution: the `guardrail_add_lesson` tool records a new rule after
 *    an avoidable mistake. Its result names the rule and the file; the agent
 *    is told to report both to the user, and the rule is in every later
 *    session's prompt.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import schema from '@deepseek-ai/schemastery';
import { checkCommand, refusal } from './lib/checks.js';
import { detectEnvironment, environmentLines } from './lib/environment.js';
import { DEFAULT_LESSONS, addLesson, applicableLessons, lessonsFile } from './lib/lessons.js';

export const name = 'dsh-agent-guardrails';

export const Config = schema.object({
  checks: schema.boolean().default(true).description('Refuse shell commands that fail every time in this environment.'),
  disabledChecks: schema.array(schema.string()).default([]).description('Check ids to skip (see lib/checks.js).'),
  learning: schema.boolean().default(true).description('Offer the guardrail_add_lesson tool and the rule to use it.'),
  sectionOrder: schema.number().default(9000).description('Prompt section order (first-party guidance ends near 10000).'),
});

/** Which shell a tool call runs: the built-in pwsh/bash tools and their persistent variants. */
export function shellOf(toolName) {
  if (/^pwsh(_persistent)?$/.test(toolName)) return 'pwsh';
  if (/^bash(_persistent)?$/.test(toolName)) return 'bash';
  return undefined;
}

/** The nearest ancestor holding `.git`, else the directory itself. */
export function projectRoot(cwd) {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

/** The prompt section text for one working directory. */
export function sectionText({ file, cwd, environment, learning }) {
  const { learned } = applicableLessons(file, cwd);
  const lines = ['## Guardrails: rules learned from past mistakes on this machine', ''];
  for (const lesson of DEFAULT_LESSONS) {
    if (lesson.id === 'record-lessons' && !learning) continue;
    lines.push(`- ${lesson.rule}`);
  }
  if (learned.length > 0) {
    lines.push('', `Learned on this machine (${file}):`);
    for (const lesson of learned) lines.push(`- ${lesson.rule}${lesson.scope === 'global' ? '' : ` (project ${lesson.scope})`}`);
  }
  const facts = environmentLines(environment);
  if (facts.length > 0) lines.push('', 'Environment (detected at startup):', ...facts.map((line) => `- ${line}`));
  return lines.join('\n');
}

/** What the model reads after guardrail_add_lesson. */
export function lessonResultText(value) {
  if (value.added) {
    return [
      `Added to ${value.file}:`,
      `- ${value.lesson.rule}${value.lesson.scope === 'global' ? '' : ` (scope: project ${value.lesson.scope})`}`,
      'From now on it is in the system prompt of every new session on this machine.',
      'Now tell the user, in their language: the rule you added, why, and this file path (they can edit or delete it there).',
    ].join('\n');
  }
  return [
    `Not added: an equivalent rule already exists (${value.duplicateOf.builtIn ? 'built into dsh-agent-guardrails' : value.file}):`,
    `- ${value.duplicateOf.rule}`,
    'Follow it. Tell the user which existing rule applied.',
  ].join('\n');
}

export function apply(ctx, config) {
  const file = lessonsFile();
  let environment = { platform: process.platform, windowsPowerShell: false, nodeOnPath: true, scriptsBlocked: false, distros: [] };
  const detected = detectEnvironment().then((value) => {
    environment = value;
    ctx.logger?.info?.(`guardrails: ${value.shell ?? value.platform}; node on PATH: ${value.nodeOnPath}; .ps1 blocked: ${value.scriptsBlocked}; WSL: ${value.distros.join(', ') || 'none'}; lessons: ${file}`);
  }, (error) => ctx.logger?.warn?.(`guardrails: environment detection failed: ${error.message}`));

  const cwdOf = (agent) => {
    try {
      return agent?.session ? ctx.get('workingDirectory')?.get(agent.session) : undefined;
    } catch {
      return undefined;
    }
  };

  // ---- 1. The rules, in every agent's system prompt. ----
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: 'guardrails:lessons',
      order: config.sectionOrder,
      interpolate: false,
      text: (context) => sectionText({ file, cwd: cwdOf(context?.scope), environment, learning: config.learning }),
    });
  });

  // ---- 2. Refuse shell commands that fail every time here. ----
  if (config.checks) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const shell = shellOf(exec.name);
      const command = exec.arguments?.command;
      if (shell !== undefined && typeof command === 'string') {
        await detected;
        const failures = checkCommand(shell, command, environment, config.disabledChecks);
        if (failures.length > 0) {
          ctx.logger?.info?.(`guardrails: refused ${exec.name} (${failures.map((failure) => failure.id).join(', ')})`);
          return { kind: 'deny', reason: refusal(failures) };
        }
      }
      return next();
    });
  }

  // ---- 3. Learn: record a new rule after an avoidable mistake. ----
  if (config.learning) {
    ctx.inject(['tools'], (scope) => {
      scope.tools.register({
        name: 'guardrail_add_lesson',
        description: [
          'Record a rule so that you and future sessions on this machine avoid a mistake that just happened.',
          'Call it right after an avoidable error: a wrong or reconstructed path, a command form this shell rejects, a missing prerequisite, a tool used against its documented contract, a guess that a quick look would have prevented.',
          'Do not record task facts, user preferences, or failures caused by the outside world (network, a real bug in the code).',
          'Write one actionable sentence in English: what to do or never do, and in which situation.',
          'Afterwards tell the user, in their language, the rule you added and the file it was saved to.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            rule: { type: 'string', description: 'One actionable sentence, e.g. "Run Node scripts as files with the Node runner; never inline with -e."' },
            why: { type: 'string', description: 'The mistake that happened, in one short sentence.' },
            scope: { type: 'string', enum: ['global', 'project'], description: '"project" when the rule only applies to the current project, else "global".' },
          },
          required: ['rule', 'why'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: lessonResultText(value) }],
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
          const cwd = cwdOf(exec.agent);
          const scope = args.scope === 'project' && cwd ? projectRoot(cwd) : 'global';
          const result = addLesson(file, { rule: args.rule, why: args.why, scope, sessionId: exec.agent?.id });
          if (result.added) ctx.logger?.info?.(`guardrails: learned "${result.lesson.rule}" → ${file}`);
          return result;
        },
      });
    });
  }
}
