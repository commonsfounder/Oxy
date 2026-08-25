// Undefined-identifier check only. Run it with `npm run check:undef`.
//
// This exists because Node does not catch a ReferenceError until the line actually runs,
// and this codebase keeps hitting that: a name used without being imported, or copied
// across scopes where it does not resolve. AGENTS.md rule 4 already mandates the check;
// this makes it one command instead of a remembered incantation.
//
// Most recently it would have caught `decryptTokens` being used in api/index.js while only
// `encryptTokens` was imported. The call sat inside a try/catch, so the ReferenceError was
// swallowed and read as "this session has no detail" -- three deploys before the real cause
// surfaced from a log line.
//
// Browser globals are declared because `page.evaluate` bodies run inside the page, not in
// Node. That exception is documented in AGENTS.md rule 4 and is the only one.

export default [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly',
        console: 'readonly', __dirname: 'readonly', __filename: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', setImmediate: 'readonly', queueMicrotask: 'readonly',
        fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', AbortController: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly', structuredClone: 'readonly',
        globalThis: 'readonly', performance: 'readonly', crypto: 'readonly',
        FormData: 'readonly', Blob: 'readonly',

        // Inside page.evaluate only -- these run in the browser, not in Node.
        document: 'readonly', window: 'readonly', navigator: 'readonly', location: 'readonly',
        getComputedStyle: 'readonly', CSS: 'readonly', Event: 'readonly'
      }
    },
    rules: { 'no-undef': 'error' }
  }
];
