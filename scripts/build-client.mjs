import { readFileSync, writeFileSync } from 'node:fs'

const file = 'lib/client.js'
const source = readFileSync(file, 'utf8')
  .replace(/^import .* from ['"].*['"];?\n/gm, '')
  .replace(/^export const inject/gm, 'exports.inject')
  .replace(/^export function apply/gm, 'exports.apply = function apply')

const bundle = `window.__ModuleLoader__.load({
  id: '@vincent-raffin/dsh-llm-github-copilot',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const jsxRuntime = require('react/jsx-runtime');
    const react = require('react');
    const runtime = require('@deepseek-ai/dsh-client-runtime/client');
    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;
    const React = react;
    const createSnapshotStore = runtime.createSnapshotStore;
${source.replaceAll('React.', 'React.')}
    return module.exports;
  }
});
`
writeFileSync(file, bundle)