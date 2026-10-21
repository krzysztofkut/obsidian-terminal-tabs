// Integration test for src/pty_helper.py (macOS / Linux).
// Run: node test/pty-helper.test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const helper = path.join(here, '..', 'src', 'pty_helper.py');
const python = process.env.PYTHON || 'python3';

function frame(type, payload) {
  const body = Buffer.from(payload);
  const out = Buffer.alloc(5 + body.length);
  out[0] = type;
  out.writeUInt32BE(body.length, 1);
  body.copy(out, 5);
  return out;
}
const data = (s) => frame(0, s);
const resize = (c, r) => { const b = Buffer.alloc(4); b.writeUInt16BE(c, 0); b.writeUInt16BE(r, 2); return frame(1, b); };

function start(shell, args = [], cols = 100, rows = 30) {
  const p = spawn(python, ['-u', helper, String(cols), String(rows), shell, ...args], {
    env: { ...process.env, TERM: 'xterm-256color', PS1: '$ ' },
  });
  let out = '';
  p.stdout.on('data', (d) => { out += d.toString('utf8'); });
  p.stderr.on('data', (d) => { out += d.toString('utf8'); });
  const closed = new Promise((res) => p.on('close', (code) => res(code)));
  return {
    p, closed,
    get out() { return out; },
    send: (buf) => p.stdin.write(buf),
    waitFor: async (re, ms = 5000) => {
      const t0 = Date.now();
      while (!re.test(out)) {
        if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${re}; got:\n${JSON.stringify(out.slice(-500))}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
  };
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
}

await test('is a real tty and gets initial size', async () => {
  const s = start('bash', ['--norc', '--noprofile', '-i'], 100, 30);
  s.send(data('tty -s && echo IS_TTY; stty size\r'));
  await s.waitFor(/IS_TTY/);
  await s.waitFor(/30 100/);
  s.send(data('exit\r'));
  assert.equal(await s.closed, 0);
});

await test('resize frame updates winsize (SIGWINCH)', async () => {
  const s = start('bash', ['--norc', '--noprofile', '-i']);
  s.send(data('trap "echo GOT_WINCH" WINCH\r'));
  s.send(resize(132, 43));
  await new Promise((r) => setTimeout(r, 200));
  s.send(data('stty size\r'));
  await s.waitFor(/43 132/);
  s.send(data('exit\r'));
  await s.closed;
});

await test('utf-8 roundtrip (Polish chars)', async () => {
  const s = start('bash', ['--norc', '--noprofile', '-i']);
  s.send(data('echo "zażółć gęślą jaźń"\r'));
  await s.waitFor(/zażółć gęślą jaźń\r?\n/);
  s.send(data('exit\r'));
  await s.closed;
});

await test('Ctrl+C interrupts foreground job', async () => {
  const s = start('bash', ['--norc', '--noprofile', '-i']);
  s.send(data('sleep 30; echo SHOULD_NOT\r'));
  await new Promise((r) => setTimeout(r, 300));
  s.send(data('\x03'));
  s.send(data('echo AFTER_INT\r'));
  await s.waitFor(/AFTER_INT\r?\n/);
  assert.ok(!/SHOULD_NOT\r?\n/.test(s.out.replace(/echo SHOULD_NOT/g, '')));
  s.send(data('exit\r'));
  await s.closed;
});

await test('exit code is propagated', async () => {
  const s = start('bash', ['--norc', '--noprofile', '-i']);
  s.send(data('exit 7\r'));
  assert.equal(await s.closed, 7);
});

await test('large paste does not deadlock', async () => {
  const s = start('bash', ['--norc', '--noprofile', '-i']);
  s.send(data('stty -echo; cat > /dev/null; echo PASTE_DONE\r'));
  await new Promise((r) => setTimeout(r, 200));
  const line = 'x'.repeat(200) + '\n';
  s.send(data(line.repeat(2000))); // ~400 KB
  s.send(data('\x04'));
  await s.waitFor(/PASTE_DONE/, 15000);
  s.send(data('exit\r'));
  await s.closed;
});

await test('closing stdin kills the shell (tab closed)', async () => {
  const s = start('bash', ['--norc', '--noprofile', '-i']);
  s.send(data('echo READY\r'));
  await s.waitFor(/READY\r?\n/);
  const t0 = Date.now();
  s.p.stdin.end();
  const code = await s.closed;
  assert.ok(Date.now() - t0 < 3000, 'took too long');
  assert.ok(code !== null);
});

await test('missing shell prints readable error', async () => {
  const s = start('/no/such/shell');
  const code = await s.closed;
  assert.equal(code, 127);
  assert.match(s.out, /Cannot start/);
});

await test('full-screen app output (tput) works', async () => {
  const s = start('bash', ['--norc', '--noprofile', '-i'], 80, 24);
  s.send(data('tput cols; tput lines\r'));
  await s.waitFor(/80\r?\n24/);
  s.send(data('exit\r'));
  await s.closed;
});

for (const r of results) console.log(r.join('  '));
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
