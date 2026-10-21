import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import helperSource from './pty_helper.py';

const T_DATA = 0;
const T_RESIZE = 1;

export interface PythonInfo {
	command: string;
	args: string[];
	version: string;
	/** Windows only: is the `pywinpty` package importable */
	hasWinpty: boolean;
}

/** Splits a command line into arguments, honouring "double" and 'single' quotes. */
export function splitArgs(input: string): string[] {
	const out: string[] = [];
	let cur = '';
	let quote: string | null = null;
	let has = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === '\\' && quote === '"' && (input[i + 1] === '"' || input[i + 1] === '\\')) cur += input[++i];
			else cur += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			has = true;
		} else if (/\s/.test(ch)) {
			if (has || cur) out.push(cur);
			cur = '';
			has = false;
		} else {
			cur += ch;
			has = true;
		}
	}
	if (has || cur) out.push(cur);
	return out;
}

function probePython(command: string, args: string[], env: NodeJS.ProcessEnv): PythonInfo | null {
	const isWin = process.platform === 'win32';
	const code = isWin
		? 'import sys\ntry:\n import winpty\n w=1\nexcept Exception:\n w=0\nprint("%d.%d.%d %d" % (sys.version_info[:3] + (w,)))'
		: 'import sys, pty, termios, fcntl\nprint("%d.%d.%d 0" % sys.version_info[:3])';
	try {
		const res = spawnSync(command, [...args, '-c', code], { env, timeout: 5000, windowsHide: true, encoding: 'utf8' });
		if (res.error || res.status !== 0) return null;
		const m = /^(3)\.(\d+)\.(\d+) ([01])/m.exec(res.stdout ?? '');
		if (!m || Number(m[2]) < 6) return null;
		return { command, args, version: `${m[1]}.${m[2]}.${m[3]}`, hasWinpty: m[4] === '1' };
	} catch {
		return null;
	}
}

/** Finds a usable Python 3 interpreter. `custom` may contain arguments, e.g. `py -3`. */
export function detectPython(custom: string, env: NodeJS.ProcessEnv): PythonInfo | null {
	const candidates: [string, string[]][] = [];
	if (custom.trim()) {
		const parts = splitArgs(custom.trim());
		candidates.push([parts[0], parts.slice(1)]);
	} else if (process.platform === 'win32') {
		candidates.push(['py', ['-3']], ['python', []], ['python3', []]);
	} else {
		// Obsidian started from the Dock gets a minimal PATH, so try absolute paths too.
		candidates.push(
			['python3', []],
			['/opt/homebrew/bin/python3', []],
			['/usr/local/bin/python3', []],
			['/usr/bin/python3', []],
		);
	}
	let fallback: PythonInfo | null = null;
	for (const [cmd, args] of candidates) {
		if (path.isAbsolute(cmd) && !fs.existsSync(cmd)) continue;
		const info = probePython(cmd, args, env);
		if (!info) continue;
		if (process.platform !== 'win32' || info.hasWinpty) return info;
		fallback ??= info; // Windows: python found, but pywinpty missing
	}
	return fallback;
}

/** Writes the bridge script next to the plugin (community installs ship only main.js). */
export function ensureHelper(pluginDir: string): string {
	const file = path.join(pluginDir, 'pty_helper.py');
	try {
		if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === helperSource) return file;
	} catch {
		/* rewrite below */
	}
	fs.mkdirSync(pluginDir, { recursive: true });
	fs.writeFileSync(file, helperSource, { encoding: 'utf8', mode: 0o644 });
	return file;
}

export interface PtyOptions {
	python: PythonInfo;
	helperPath: string;
	shell: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	cols: number;
	rows: number;
}

/** A shell running inside a pseudo-terminal created by pty_helper.py. */
export class PtyProcess {
	private proc: ChildProcessWithoutNullStreams;
	private exited = false;
	private killTimer: number | null = null;

	onData: (data: Uint8Array) => void = () => {};
	onExit: (code: number) => void = () => {};

	constructor(opts: PtyOptions) {
		this.proc = spawn(
			opts.python.command,
			[...opts.python.args, '-u', opts.helperPath, String(opts.cols), String(opts.rows), opts.shell, ...opts.args],
			{ cwd: opts.cwd, env: opts.env, windowsHide: true, stdio: 'pipe' },
		);
		this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
		this.proc.stderr.on('data', (chunk: Buffer) => {
			// Python tracebacks etc. - make them visible and readable in the terminal.
			const text = chunk.toString('utf8').replace(/\r?\n/g, '\r\n');
			this.onData(Buffer.from(`\x1b[31m${text}\x1b[0m`, 'utf8'));
		});
		this.proc.stdin.on('error', () => {});
		this.proc.on('error', (err) => {
			this.onData(Buffer.from(`\r\n\x1b[31m[Terminal Tabs] ${err.message}\x1b[0m\r\n`, 'utf8'));
			this.finish(-1);
		});
		this.proc.on('close', (code, signal) => this.finish(code ?? (signal ? 128 : -1)));
	}

	get pid(): number | undefined {
		return this.proc.pid;
	}

	get alive(): boolean {
		return !this.exited;
	}

	private finish(code: number) {
		if (this.exited) return;
		this.exited = true;
		if (this.killTimer !== null) window.clearTimeout(this.killTimer);
		this.onExit(code);
	}

	private send(type: number, payload: Uint8Array) {
		if (this.exited || !this.proc.stdin.writable) return;
		const head = Buffer.alloc(5);
		head[0] = type;
		head.writeUInt32BE(payload.length, 1);
		this.proc.stdin.write(Buffer.concat([head, payload]));
	}

	write(data: string | Uint8Array) {
		this.send(T_DATA, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
	}

	resize(cols: number, rows: number) {
		const b = Buffer.alloc(4);
		b.writeUInt16BE(Math.max(1, Math.min(cols, 65535)), 0);
		b.writeUInt16BE(Math.max(1, Math.min(rows, 65535)), 2);
		this.send(T_RESIZE, b);
	}

	/** Closing stdin makes the helper hang up the shell; force-kill if it does not go away. */
	kill() {
		if (this.exited) return;
		try {
			this.proc.stdin.end();
		} catch {
			/* ignore */
		}
		this.killTimer = window.setTimeout(() => {
			if (!this.exited) this.proc.kill('SIGKILL');
		}, 3000);
	}
}
