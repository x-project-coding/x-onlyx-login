/**
 * Module hooks that point the bare `electron` specifier at electron-stub.js, so `src/main.js` can be
 * imported by a plain `node --test` process. Registered by test/lifecycle.test.js with
 * `module.register`, which is available on every Node this app supports (>=18.19).
 */

const STUB = new URL('./electron-stub.js', import.meta.url).href;

export const resolve = (specifier, context, next) => {
  if (specifier === 'electron') return { url: STUB, shortCircuit: true };
  return next(specifier, context);
};
