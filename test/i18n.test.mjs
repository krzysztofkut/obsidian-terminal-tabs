// Translations: every locale keeps the {placeholders} of English; language codes pick the right locale.
// Run: node test/i18n.test.mjs
import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const obsidianMock = {
  name: 'obsidian-mock',
  setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'mock' }));
    build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: "export const getLanguage = () => 'en';" }));
  },
};
const { outputFiles } = await esbuild.build({
  entryPoints: [path.join(root, 'src/i18n.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node', plugins: [obsidianMock],
});
const { en, locales, pickLocale } = await import('data:text/javascript,' + encodeURIComponent(outputFiles[0].text));

const results = [];
const test = (name, fn) => {
  try { fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
};
const vars = (s) => (s.match(/\{\w+\}/g) ?? []).sort().join(' ');

test('every locale keeps the placeholders of English', () => {
  for (const [code, dict] of Object.entries(locales)) {
    for (const [key, s] of Object.entries(dict)) assert.equal(vars(s), vars(en[key]), `${code}.${key}`);
  }
});
test('every locale translates every key', () => {
  for (const [code, dict] of Object.entries(locales)) {
    const missing = Object.keys(en).filter((k) => !(k in dict));
    assert.deepEqual(missing, [], code);
  }
});
test('language codes pick the right locale', () => {
  assert.equal(pickLocale('zh-TW'), locales['zh-tw']);
  assert.equal(pickLocale('zh'), locales.zh);
  assert.equal(pickLocale('pt-BR'), locales['pt-br']);
  assert.equal(pickLocale('pt-PT'), locales.pt);
  assert.equal(pickLocale('de'), locales.de);
  assert.deepEqual(pickLocale('en'), {});
  assert.deepEqual(pickLocale('xx'), {});
});

for (const [status, name, err] of results) console.log(`${status}  ${name}${err ? '  ' + err : ''}`);
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
