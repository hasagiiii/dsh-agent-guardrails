// Test-only resolver for boot rehearsals: modules under this repository's test/
// directory resolve bare imports against the installed DeepSeek Harness; the
// booted profile resolves everything else itself, as the Desktop does.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = (process.env.DSH_ROOT ?? 'D:/dsh/resources/app.asar/dsh').replace(/\\/g, '/');
const anchor = pathToFileURL(`${root}/package.json`).href;
const tests = pathToFileURL(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href;
register(`data:text/javascript,${encodeURIComponent(`
  const anchor = ${JSON.stringify(anchor)};
  const tests = ${JSON.stringify(tests)}.toLowerCase();
  export async function resolve(specifier, context, next) {
    const bare = !specifier.startsWith('.') && !specifier.startsWith('/') && !/^[a-z]+:/i.test(specifier);
    if (bare && context.parentURL && context.parentURL.toLowerCase().startsWith(tests)) {
      return next(specifier, { ...context, parentURL: anchor });
    }
    try {
      return await next(specifier, context);
    } catch (error) {
      if (bare && specifier.startsWith('@deepseek-ai/')) return next(specifier, { ...context, parentURL: anchor });
      throw error;
    }
  }
`)}`);
