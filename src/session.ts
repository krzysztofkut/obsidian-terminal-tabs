import { Menu, Platform, Scope, TFile, normalizePath, setIcon } from 'obsidian';
import { Terminal, IDisposable, ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { t } from './i18n';
import { PtyProcess, splitArgs } from './pty';
import { buildTheme, monospaceFont } from './theme';
import type TerminalTabsPlugin from './main';

export interface SessionState {
	name: string;
	cwd: string;
	profileId: string;
	/** true when the user renamed the tab (auto names are re-numbered) */
	customName?: boolean;
}

/** The Obsidian tab hosting a session. */
export interface SessionHost {
	requestSave(): void;
	/** running/exited changed */
	onSessionChange(): void;
	onSessionFocus(): void;
	/** close the tab */
	closeSession(): void;
	renameSession(): void;
	/** open another terminal tab next to this one */
	newSession(opts?: { profileId?: string; cwd?: string }): void;
}

type ExitState = 'running' | 'exited' | 'not-started';

const isMac = Platform.isMacOS;
const isWin = Platform.isWin;

function execOut(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: 2000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
	});
}

function shellQuote(p: string): string {
	if (isWin) return /[\s&()^;,]/.test(p) ? `"${p}"` : p;
	return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

export class TerminalSession {
	readonly id = Math.random().toString(36).slice(2);
	readonly el: HTMLElement;
	readonly term: Terminal;
	name: string;
	customName: boolean;
	cwd: string;
	profileId: string;

	private plugin: TerminalTabsPlugin;
	private host: SessionHost;
	private fit = new FitAddon();
	private search = new SearchAddon();
	private pty: PtyProcess | null = null;
	private state: ExitState = 'not-started';
	private opened = false;
	private disposed = false;
	private disposables: IDisposable[] = [];
	private scope: Scope | null = null;
	private findBar: HTMLElement | null = null;
	private findInput: HTMLInputElement | null = null;
	private findOpts = { caseSensitive: false, regex: false };
	private cwdTimer: number | null = null;

	constructor(plugin: TerminalTabsPlugin, host: SessionHost, parent: HTMLElement, st: SessionState) {
		this.plugin = plugin;
		this.host = host;
		this.name = st.name;
		this.customName = !!st.customName;
		this.cwd = st.cwd;
		this.profileId = st.profileId;

		this.el = parent.createDiv({ cls: 'terminal-tabs-session' });
		this.el.hide();

		const s = plugin.settings;
		this.term = new Terminal({
			allowProposedApi: true, // needed by term.unicode
			fontSize: s.fontSize,
			fontFamily: s.fontFamily || monospaceFont(this.el),
			lineHeight: s.lineHeight,
			cursorStyle: s.cursorStyle,
			cursorBlink: s.cursorBlink,
			scrollback: s.scrollback,
			macOptionIsMeta: s.macOptionIsMeta,
			macOptionClickForcesSelection: true,
			rightClickSelectsWord: false,
			drawBoldTextInBrightColors: true,
			minimumContrastRatio: 1,
			theme: buildTheme(this.el, s.colorScheme),
			windowsPty: isWin ? { backend: 'conpty', buildNumber: Number(os.release().split('.')[2]) || undefined } : undefined,
		});
		this.term.loadAddon(this.fit);
		this.term.loadAddon(this.search);
		// Emoji are 2 cells wide like in other terminals; with the default Unicode 6 widths, TUIs that redraw
		// only changed cells (e.g. status lines) land one column off and leave stale characters.
		this.term.loadAddon(new Unicode11Addon());
		this.term.unicode.activeVersion = '11';
		this.term.loadAddon(
			new WebLinksAddon((ev, uri) => {
				if (ev.metaKey || ev.ctrlKey) window.open(uri);
			}),
		);
		this.disposables.push(
			this.term.registerLinkProvider({ provideLinks: (y, cb) => void this.provideVaultLinks(y).then(cb) }),
			this.term.parser.registerOscHandler(7, (data) => {
				// OSC 7: shell reports its working directory (file://host/path)
				try {
					const p = decodeURIComponent(new URL(data).pathname);
					if (p) this.cwd = isWin ? p.replace(/^\/([A-Za-z]:)/, '$1') : p;
					this.host.requestSave();
				} catch {
					/* ignore */
				}
				return true;
			}),
			this.term.onData((d) => this.onUserData(d)),
			this.term.onBinary((d) => this.pty?.write(Buffer.from(d, 'binary'))),
			this.term.onResize(({ cols, rows }) => this.pty?.resize(cols, rows)),
			this.term.onSelectionChange(() => {
				if (this.plugin.settings.copyOnSelect && this.term.hasSelection()) void this.copySelection();
			}),
		);
		this.term.attachCustomKeyEventHandler((ev) => this.handleKey(ev));

		this.el.addEventListener('contextmenu', (ev) => this.showContextMenu(ev));
		this.el.addEventListener('dragover', (ev) => {
			ev.preventDefault();
			if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
		});
		this.el.addEventListener('drop', (ev) => this.onDrop(ev));
	}

	// ------------------------------------------------------------ lifecycle

	get isRunning(): boolean {
		return this.state === 'running';
	}

	toState(): SessionState {
		return { name: this.name, cwd: this.cwd, profileId: this.profileId, customName: this.customName || undefined };
	}

	show() {
		this.el.show();
		if (!this.opened) {
			this.opened = true;
			this.term.open(this.el);
			const ta = this.term.textarea;
			if (ta) {
				ta.addEventListener('focus', () => this.onFocus());
				ta.addEventListener('blur', () => this.onBlur());
			}
		}
		this.fitNow();
		if (this.state === 'not-started') this.start();
	}

	hide() {
		this.el.hide();
		this.closeFind();
	}

	focus() {
		this.term.focus();
	}

	fitNow() {
		if (!this.opened || this.disposed || !this.el.isShown()) return;
		const { clientWidth, clientHeight } = this.el;
		if (clientWidth < 10 || clientHeight < 10) return;
		try {
			this.fit.fit();
		} catch {
			/* not measurable yet */
		}
	}

	start() {
		if (this.disposed) return;
		const plugin = this.plugin;
		const python = plugin.getPython();
		if (!python) {
			this.state = 'exited';
			this.term.write(`\r\n\x1b[33m${t(isWin ? 'pythonMissingWin' : 'pythonMissing')}\x1b[0m\r\n`);
			this.term.write(`\x1b[2m${t('pressEnterToRestart')}\x1b[0m\r\n`);
			return;
		}
		const profile = plugin.getProfile(this.profileId);
		let cwd = this.cwd;
		try {
			if (!cwd || !fs.statSync(cwd).isDirectory()) cwd = plugin.vaultPath();
		} catch {
			cwd = plugin.vaultPath();
		}
		this.cwd = cwd;

		this.fitNow();
		try {
			this.pty = new PtyProcess({
				python,
				helperPath: plugin.helperPath(),
				shell: profile.command,
				args: splitArgs(profile.args),
				cwd,
				env: plugin.shellEnv(),
				cols: this.term.cols,
				rows: this.term.rows,
			});
		} catch (e) {
			this.state = 'exited';
			this.term.write(`\r\n\x1b[31m[Terminal Tabs] ${(e as Error).message}\x1b[0m\r\n`);
			return;
		}
		this.state = 'running';
		const pty = this.pty;
		pty.onData = (d) => this.term.write(d);
		pty.onExit = (code) => {
			if (this.pty !== pty || this.disposed) return;
			this.pty = null;
			this.state = 'exited';
			this.host.onSessionChange();
			if (code === 0 && this.plugin.settings.closeOnExit) {
				this.host.closeSession();
				return;
			}
			this.term.write(`\r\n\x1b[2m[${t('processExited', { code })}]\x1b[0m\r\n`);
			this.term.write(`\x1b[2m${t('pressEnterToRestart')}\x1b[0m\r\n`);
		};
		this.host.onSessionChange();
	}

	restart() {
		this.pty?.kill();
		this.pty = null;
		this.state = 'not-started';
		this.term.write('\r\n');
		this.start();
		this.focus();
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.onBlur();
		if (this.cwdTimer !== null) window.clearTimeout(this.cwdTimer);
		this.pty?.kill();
		this.pty = null;
		for (const d of this.disposables) d.dispose();
		this.term.dispose();
		this.el.remove();
	}

	applySettings() {
		const s = this.plugin.settings;
		const o = this.term.options;
		o.fontSize = s.fontSize;
		o.fontFamily = s.fontFamily || monospaceFont(this.el);
		o.lineHeight = s.lineHeight;
		o.cursorStyle = s.cursorStyle;
		o.cursorBlink = s.cursorBlink;
		o.scrollback = s.scrollback;
		o.macOptionIsMeta = s.macOptionIsMeta;
		this.applyTheme();
		this.fitNow();
	}

	applyTheme() {
		this.term.options.theme = buildTheme(this.el, this.plugin.settings.colorScheme);
	}

	// ---------------------------------------------------------------- input

	write(text: string) {
		if (this.pty) this.pty.write(text);
	}

	paste(text: string) {
		if (this.state !== 'running') return;
		this.term.paste(text);
	}

	private onUserData(data: string) {
		if (this.state === 'exited') {
			if (data === '\r') this.restart();
			else if (data === '\x1b') this.host.closeSession();
			return;
		}
		this.pty?.write(data);
		if (data.includes('\r')) this.scheduleCwdRefresh();
	}

	/** Terminal hotkeys. Returning false stops xterm from handling the key. */
	private handleKey(ev: KeyboardEvent): boolean {
		if (ev.type !== 'keydown') return true;
		const key = ev.key;
		const lower = key.length === 1 ? key.toLowerCase() : key;
		const mod = isMac ? ev.metaKey : ev.ctrlKey;
		const ctrlShift = ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey;
		const consume = () => {
			ev.preventDefault();
			ev.stopPropagation();
			return false;
		};

		// Alt+F12: hide terminal / go back to the editor
		if (key === 'F12' && ev.altKey && !ev.ctrlKey && !ev.metaKey) {
			void this.plugin.toggleTerminal();
			return consume();
		}
		// Shift+F6: rename tab
		if (key === 'F6' && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
			this.host.renameSession();
			return consume();
		}

		// ---- clipboard
		if ((isMac && ev.metaKey && !ev.shiftKey && lower === 'c') || (!isMac && ctrlShift && lower === 'c')) {
			if (this.term.hasSelection()) void this.copySelection();
			return consume();
		}
		if (!isMac && ev.ctrlKey && !ev.shiftKey && !ev.altKey && lower === 'c' && this.term.hasSelection()) {
			void this.copySelection();
			this.term.clearSelection();
			return consume();
		}
		if (!isMac && ctrlShift && lower === 'v') {
			void this.pasteFromClipboard();
			return consume();
		}
		if ((isMac && ev.metaKey && lower === 'v') || (isWin && ev.ctrlKey && !ev.shiftKey && !ev.altKey && lower === 'v')) {
			// let the native paste event reach xterm (handles bracketed paste)
			return false;
		}

		// ---- tabs
		if ((isMac && ev.metaKey && !ev.shiftKey && lower === 't') || (!isMac && ctrlShift && lower === 't')) {
			this.host.newSession();
			return consume();
		}
		if ((isMac && ev.metaKey && !ev.shiftKey && lower === 'w') || (!isMac && ctrlShift && lower === 'w') || (ev.ctrlKey && key === 'F4')) {
			this.host.closeSession();
			return consume();
		}
		// switching tabs uses Obsidian's own tab commands (terminals are regular Obsidian tabs)
		if (ev.ctrlKey && key === 'Tab') {
			this.plugin.runCommand(ev.shiftKey ? 'workspace:previous-tab' : 'workspace:next-tab');
			return consume();
		}
		if (ev.ctrlKey && !ev.shiftKey && (key === 'PageDown' || key === 'PageUp')) {
			this.plugin.runCommand(key === 'PageDown' ? 'workspace:next-tab' : 'workspace:previous-tab');
			return consume();
		}
		if (isMac && ev.metaKey && ev.shiftKey && (ev.code === 'BracketRight' || ev.code === 'BracketLeft')) {
			this.plugin.runCommand(ev.code === 'BracketRight' ? 'workspace:next-tab' : 'workspace:previous-tab');
			return consume();
		}
		if (mod && !ev.shiftKey && !ev.altKey && /^[1-9]$/.test(key) && isMac) {
			this.plugin.runCommand(key === '9' ? 'workspace:goto-last-tab' : `workspace:goto-tab-${key}`);
			return consume();
		}

		// ---- find / clear
		if ((isMac && ev.metaKey && !ev.shiftKey && lower === 'f') || (!isMac && ctrlShift && lower === 'f')) {
			this.openFind();
			return consume();
		}
		if (isMac && ev.metaKey && !ev.shiftKey && lower === 'k') {
			this.clear();
			return consume();
		}

		// ---- macOS text navigation like Terminal.app / iTerm
		if (isMac && !this.plugin.settings.macOptionIsMeta && ev.altKey && !ev.metaKey && !ev.ctrlKey) {
			if (key === 'ArrowLeft') return this.sendAndConsume('\x1bb', consume);
			if (key === 'ArrowRight') return this.sendAndConsume('\x1bf', consume);
			if (key === 'Backspace') return this.sendAndConsume('\x1b\x7f', consume);
		}
		if (isMac && ev.metaKey && !ev.altKey && !ev.ctrlKey) {
			if (key === 'ArrowLeft') return this.sendAndConsume('\x01', consume);
			if (key === 'ArrowRight') return this.sendAndConsume('\x05', consume);
			if (key === 'Backspace') return this.sendAndConsume('\x15', consume);
			// everything else with Cmd belongs to Obsidian / the OS, never to the shell
			return false;
		}
		return true;
	}

	private sendAndConsume(seq: string, consume: () => boolean): boolean {
		if (this.state === 'running') this.pty?.write(seq);
		return consume();
	}

	private onFocus() {
		this.host.onSessionFocus();
		if (!this.plugin.settings.overrideHotkeys || this.scope) return;
		// An empty scope without parent: Obsidian hotkeys don't fire while the shell is focused.
		const scope = new Scope();
		if (isMac) {
			const run = (id: string) => () => {
				this.plugin.runCommand(id);
				return false;
			};
			scope.register(['Mod'], 'p', run('command-palette:open'));
			scope.register(['Mod'], 'o', run('switcher:open'));
			scope.register(['Mod'], ',', run('app:open-settings'));
		}
		this.scope = scope;
		this.plugin.app.keymap.pushScope(scope);
	}

	private onBlur() {
		if (this.scope) {
			this.plugin.app.keymap.popScope(this.scope);
			this.scope = null;
		}
	}

	// ------------------------------------------------------------ clipboard

	async copySelection() {
		const text = this.term.getSelection();
		if (text) await navigator.clipboard.writeText(text);
	}

	async pasteFromClipboard() {
		const text = await navigator.clipboard.readText();
		if (text) this.paste(text);
		this.focus();
	}

	clear() {
		this.term.clear();
	}

	// ---------------------------------------------------------- context menu

	private showContextMenu(ev: MouseEvent) {
		ev.preventDefault();
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle(t('copy'))
				.setIcon('copy')
				.setDisabled(!this.term.hasSelection())
				.onClick(() => void this.copySelection()),
		);
		menu.addItem((i) => i.setTitle(t('paste')).setIcon('clipboard-paste').onClick(() => void this.pasteFromClipboard()));
		menu.addItem((i) => i.setTitle(t('selectAll')).setIcon('text-select').onClick(() => this.term.selectAll()));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle(t('find')).setIcon('search').onClick(() => this.openFind()));
		menu.addItem((i) => i.setTitle(t('clear')).setIcon('eraser').onClick(() => this.clear()));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle(t('newTab')).setIcon('plus').onClick(() => this.host.newSession()));
		menu.addItem((i) => i.setTitle(t('renameTab')).setIcon('pencil').onClick(() => this.host.renameSession()));
		menu.addItem((i) => i.setTitle(t('restart')).setIcon('rotate-ccw').onClick(() => this.restart()));
		menu.addItem((i) => i.setTitle(t('closeTab')).setIcon('x').onClick(() => this.host.closeSession()));
		menu.showAtMouseEvent(ev);
	}

	// ------------------------------------------------------------------ find

	openFind() {
		if (!this.findBar) this.buildFindBar();
		const bar = this.findBar!;
		bar.show();
		const sel = this.term.getSelection();
		if (sel && !sel.includes('\n')) this.findInput!.value = sel;
		this.findInput!.focus();
		this.findInput!.select();
	}

	closeFind() {
		if (!this.findBar?.isShown()) return;
		this.findBar.hide();
		this.term.clearSelection();
		this.focus();
	}

	private runFind(dir: 1 | -1, incremental = false) {
		const q = this.findInput?.value ?? '';
		if (!q) {
			this.findBar?.removeClass('mod-no-match');
			return;
		}
		const opts = { ...this.findOpts, incremental };
		let ok = false;
		try {
			ok = dir === 1 ? this.search.findNext(q, opts) : this.search.findPrevious(q, opts);
		} catch {
			ok = false; // invalid regex while typing
		}
		this.findBar?.toggleClass('mod-no-match', !ok);
	}

	private buildFindBar() {
		const bar = this.el.createDiv({ cls: 'terminal-tabs-find' });
		const input = bar.createEl('input', { type: 'text', attr: { placeholder: t('findPlaceholder'), spellcheck: 'false' } });
		const mkBtn = (icon: string, label: string, fn: () => void) => {
			const b = bar.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': label } });
			setIcon(b, icon);
			b.addEventListener('mousedown', (e) => e.preventDefault());
			b.addEventListener('click', fn);
			return b;
		};
		const caseBtn = mkBtn('case-sensitive', t('findCase'), () => {
			this.findOpts.caseSensitive = !this.findOpts.caseSensitive;
			caseBtn.toggleClass('is-active', this.findOpts.caseSensitive);
			this.runFind(1, true);
		});
		const reBtn = mkBtn('regex', t('findRegex'), () => {
			this.findOpts.regex = !this.findOpts.regex;
			reBtn.toggleClass('is-active', this.findOpts.regex);
			this.runFind(1, true);
		});
		mkBtn('arrow-up', t('findPrev'), () => this.runFind(-1));
		mkBtn('arrow-down', t('findNext'), () => this.runFind(1));
		mkBtn('x', t('findClose'), () => this.closeFind());
		input.addEventListener('input', () => this.runFind(1, true));
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.runFind(e.shiftKey ? -1 : 1);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				this.closeFind();
			}
		});
		bar.hide();
		this.findBar = bar;
		this.findInput = input;
	}

	// ------------------------------------------------------- vault file links

	private async provideVaultLinks(y: number): Promise<ILink[] | undefined> {
		if (!this.plugin.settings.linkVaultFiles) return undefined;
		const line = this.term.buffer.active.getLine(y - 1);
		if (!line) return undefined;
		const text = line.translateToString(true);
		if (!/[./\\]/.test(text)) return undefined;
		const vault = this.plugin.vaultPath();
		const links: ILink[] = [];
		const re = /[^\s'"`()[\]{}<>|;,*]+/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text))) {
			let token = m[0];
			let start = m.index;
			// strip grep/compiler style suffixes (file.md:12:3) and trailing punctuation
			const colon = token.search(/:\d/);
			if (colon > 0) token = token.slice(0, colon);
			token = token.replace(/[:.!?]+$/, '');
			if (token.startsWith('a/') || token.startsWith('b/')) {
				// git diff headers
				if (!this.resolveVaultFile(token, vault)) {
					token = token.slice(2);
					start += 2;
				}
			}
			if (token.length < 3 || token.includes('://')) continue;
			const file = this.resolveVaultFile(token, vault);
			if (!file) continue;
			links.push({
				text: token,
				range: { start: { x: start + 1, y }, end: { x: start + token.length, y } },
				decorations: { underline: true, pointerCursor: true },
				activate: (ev) => {
					if (ev.metaKey || ev.ctrlKey) this.plugin.openVaultFile(file, ev.shiftKey || ev.altKey);
				},
			});
		}
		return links.length ? links : undefined;
	}

	private resolveVaultFile(token: string, vault: string): TFile | null {
		let p = token;
		if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
		const candidates = path.isAbsolute(p) ? [p] : [path.resolve(this.cwd || vault, p), path.resolve(vault, p)];
		for (const abs of candidates) {
			const rel = path.relative(vault, abs);
			if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
			const f = this.plugin.app.vault.getAbstractFileByPath(normalizePath(rel.split(path.sep).join('/')));
			if (f instanceof TFile) return f;
		}
		return null;
	}

	// ------------------------------------------------------- working directory

	private scheduleCwdRefresh() {
		if (this.cwdTimer !== null) window.clearTimeout(this.cwdTimer);
		this.cwdTimer = window.setTimeout(() => {
			this.cwdTimer = null;
			void this.refreshCwd();
		}, 700);
	}

	/** Reads the shell's real cwd (the shell is the child of the python bridge). */
	async refreshCwd(): Promise<string> {
		const helperPid = this.pty?.pid;
		if (!helperPid || isWin) return this.cwd;
		try {
			const kids = await execOut(fs.existsSync('/usr/bin/pgrep') ? '/usr/bin/pgrep' : 'pgrep', ['-P', String(helperPid)]);
			const shellPid = kids.split('\n')[0]?.trim();
			if (!shellPid) return this.cwd;
			let dir = '';
			if (process.platform === 'linux') {
				dir = await fs.promises.readlink(`/proc/${shellPid}/cwd`).catch(() => '');
			} else {
				const lsof = fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
				const out = await execOut(lsof, ['-a', '-p', shellPid, '-d', 'cwd', '-Fn']);
				dir = out.split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? '';
			}
			if (dir && dir !== this.cwd) {
				this.cwd = dir;
				this.host.requestSave();
			}
		} catch {
			/* keep last known */
		}
		return this.cwd;
	}

	// ------------------------------------------------------------ drag & drop

	private onDrop(ev: DragEvent) {
		ev.preventDefault();
		const paths: string[] = [];
		const vault = this.plugin.vaultPath();
		// From Obsidian's file explorer
		const dragged = (this.plugin.app as unknown as { dragManager?: { draggable?: { file?: { path: string }; files?: { path: string }[] } } })
			.dragManager?.draggable;
		if (dragged?.files?.length) paths.push(...dragged.files.map((f) => path.join(vault, f.path)));
		else if (dragged?.file) paths.push(path.join(vault, dragged.file.path));
		// From Finder / Explorer
		if (!paths.length && ev.dataTransfer?.files?.length) {
			const electron = (window as unknown as { require?: (m: string) => unknown }).require?.('electron') as
				| { webUtils?: { getPathForFile(f: File): string } }
				| undefined;
			for (const f of Array.from(ev.dataTransfer.files)) {
				const p = electron?.webUtils?.getPathForFile(f) || (f as File & { path?: string }).path;
				if (p) paths.push(p);
			}
		}
		if (!paths.length) {
			const text = ev.dataTransfer?.getData('text/plain');
			if (text) this.paste(text);
			return;
		}
		this.paste(paths.map(shellQuote).join(' ') + ' ');
		this.focus();
	}
}
