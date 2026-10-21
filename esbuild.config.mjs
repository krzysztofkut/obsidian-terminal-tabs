import esbuild from 'esbuild';
import builtins from 'builtin-modules';
import fs from 'node:fs';
import path from 'node:path';

const prod = process.argv[2] === 'production';
const outDir = process.env.OUT_DIR || '.';

// styles.css = xterm.css + our own styles (Obsidian loads only one stylesheet per plugin)
const cssPlugin = {
  name: 'styles',
  setup(build) {
    build.onEnd(() => {
      const css = [
        '/* ---- xterm.js ---- */',
        fs.readFileSync('node_modules/@xterm/xterm/css/xterm.css', 'utf8'),
        '/* ---- Terminal Tabs ---- */',
        fs.readFileSync('src/styles.css', 'utf8'),
      ].join('\n');
      fs.writeFileSync(path.join(outDir, 'styles.css'), css);
      if (outDir !== '.') fs.copyFileSync('manifest.json', path.join(outDir, 'manifest.json'));
    });
  },
};

const ctx = await esbuild.context({
  banner: { js: '/* Terminal Tabs - bundled by esbuild. Source: src/ */' },
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', ...builtins, ...builtins.map((m) => `node:${m}`)],
  format: 'cjs',
  target: 'es2020',
  platform: 'browser',
  loader: { '.py': 'text' },
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  minify: prod,
  outfile: path.join(outDir, 'main.js'),
  plugins: [cssPlugin],
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
