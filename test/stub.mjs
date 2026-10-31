// Loader hook for tests run outside DeepSeek Harness: resolves the peer packages to tiny stubs.
import { registerHooks } from 'node:module';

const STUBS = {
  '@deepseek-ai/schemastery': 'const s = new Proxy(function () {}, { get: () => s, apply: () => s }); export default s;',
};

registerHooks({
  resolve(specifier, context, next) {
    if (specifier in STUBS) return { url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, shortCircuit: true };
    return next(specifier, context);
  },
});
