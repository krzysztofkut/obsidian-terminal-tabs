import { FileSystemAdapter, FuzzySuggestModal, MarkdownView, Notice, Platform, Plugin, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import { t } from './i18n';
import { PythonInfo, detectPython, ensureHelper } from './pty';
import { DEFAULT_SETTINGS, ShellProfile, VaultTerminalSettingTab, VaultTerminalSettings, detectProfiles } from './settings';
import { TerminalView, TerminalViewState, VIEW_TYPE } from './view';
import { EMPTY_ACTION_CLS, createEmptyTabAction } from './empty-tab';

type Loc = VaultTerminalSettings['location'];

export interface NewTerminalOptions {
	profileId?: string;
	cwd?: string;
	/** open as a tab right after this leaf (same tab group) */
	near?: WorkspaceLeaf | null;
	/** ignore existing terminals and open at this location */
	location?: Loc;
}


export default class VaultTerminalPlugin extends Plugin {
	settings!: VaultTerminalSettings;
	/** undefined = not checked yet, null = not found */
	python: PythonInfo | null | undefined;
	lastTerminalView: TerminalView | null = null;
	private lastEditorLeaf: WorkspaceLeaf | null = null;
	private helperFile: string | null = null;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE, (leaf) => new TerminalView(leaf, this));
		this.addSettingTab(new VaultTerminalSettingTab(this.app, this));

		this.addCommand({
			id: 'toggle',
			name: t('cmdToggle'),
			icon: 'terminal',
			callback: () => void this.toggleTerminal(),
		});
		this.addCommand({
			id: 'new-tab',
			name: t('cmdNewTab'),
			icon: 'plus',
			callback: () => void this.newTerminal(),
		});
		this.addCommand({
			id: 'new-tab-profile',
			name: t('cmdNewTabProfile'),
			icon: 'terminal',
			callback: () => new ProfileModal(this, (p) => void this.newTerminal({ profileId: p.id })).open(),
		});
		this.addCommand({
			id: 'new-editor-tab',
			name: t('cmdNewView'),
			icon: 'terminal',
			callback: () => void this.newTerminal({ location: 'tab' }),
		});
		this.addCommand({
			id: 'open-in-active-folder',
			name: t('cmdActiveFolder'),
			icon: 'folder-open',
			callback: () => {
				const f = this.app.workspace.getActiveFile();
				void this.newTerminal({ cwd: f?.parent ? this.absPath(f.parent.path) : this.vaultPath() });
			},
		});
		this.addCommand({
			id: 'focus',
			name: t('cmdFocus'),
			callback: () => void this.focusTerminal(),
		});
		const withView = (fn: (v: TerminalView) => void) => (checking: boolean) => {
			const v = this.findView();
			if (!v?.session) return false;
			if (!checking) fn(v);
			return true;
		};
		this.addCommand({ id: 'close-tab', name: t('cmdCloseTab'), checkCallback: withView((v) => v.closeSession()) });
		this.addCommand({ id: 'rename-tab', name: t('cmdRenameTab'), checkCallback: withView((v) => v.renameSession()) });
		this.addCommand({ id: 'clear', name: t('cmdClear'), checkCallback: withView((v) => v.session!.clear()) });
		this.addCommand({
			id: 'run-selection',
			name: t('cmdSendSelection'),
			icon: 'play',
			editorCallback: async (editor) => {
				const text = editor.getSelection() || editor.getLine(editor.getCursor().line);
				if (!text.trim()) return;
				const view = await this.focusTerminal();
				const s = view?.session;
				if (!s) return;
				// give a freshly started shell a moment to print its prompt
				window.setTimeout(() => s.write(text.replace(/\r?\n/g, '\r').replace(/\r?$/, '\r')), s.isRunning ? 0 : 600);
			},
		});

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				const dir = file instanceof TFolder ? file : file instanceof TFile ? file.parent : null;
				if (!dir) return;
				menu.addItem((i) =>
					i
						.setSection('open')
						.setTitle(t('openInTerminal'))
						.setIcon('terminal')
						.onClick(() => void this.newTerminal({ cwd: this.absPath(dir.path) })),
				);
			}),
		);

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf && this.isEditorLeaf(leaf)) this.lastEditorLeaf = leaf;
				this.decorateEmptyTabs();
			}),
		);
		this.registerEvent(this.app.workspace.on('layout-change', () => this.decorateEmptyTabs()));
		this.registerEvent(this.app.workspace.on('css-change', () => this.forEachView((v) => v.applyTheme())));
		this.app.workspace.onLayoutReady(() => this.decorateEmptyTabs());
		this.register(() => document.querySelectorAll(`.${EMPTY_ACTION_CLS}`).forEach((el) => el.remove()));
	}

	onunload() {
		// Terminal tabs are closed by Obsidian, which disposes every shell (TerminalView.onClose).
	}

	// -------------------------------------------------------------- settings

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (!Array.isArray(this.settings.profiles) || !this.settings.profiles.length) {
			this.settings.profiles = detectProfiles();
			this.settings.defaultProfile = this.settings.profiles[0]?.id ?? '';
			await this.saveData(this.settings);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	applySettingsToViews() {
		this.forEachView((v) => v.applySettings());
		this.decorateEmptyTabs(true);
	}

	openSettings() {
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}

	runCommand(id: string) {
		(this.app as unknown as { commands?: { executeCommandById(id: string): boolean } }).commands?.executeCommandById(id);
	}

	// ------------------------------------------------------------ environment

	vaultPath(): string {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : process.cwd();
	}

	absPath(vaultRelative: string): string {
		return vaultRelative === '/' ? this.vaultPath() : path.join(this.vaultPath(), vaultRelative);
	}

	helperPath(): string {
		if (!this.helperFile) {
			const dir = this.manifest.dir ? path.join(this.vaultPath(), this.manifest.dir) : path.join(this.vaultPath(), this.app.vault.configDir, 'plugins', this.manifest.id);
			this.helperFile = ensureHelper(dir);
		}
		return this.helperFile;
	}

	getPython(): PythonInfo | null {
		if (!this.python) this.python = detectPython(this.settings.pythonPath, this.baseEnv());
		return this.python;
	}

	/** process.env with a sane PATH even when Obsidian was started from the macOS Dock. */
	baseEnv(): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = { ...process.env };
		if (!Platform.isWin) {
			const parts = (env.PATH || '').split(':').filter(Boolean);
			for (const p of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) if (!parts.includes(p)) parts.push(p);
			env.PATH = parts.join(':');
		}
		delete env.ELECTRON_RUN_AS_NODE;
		return env;
	}

	shellEnv(): NodeJS.ProcessEnv {
		const env = this.baseEnv();
		env.TERM = 'xterm-256color';
		env.COLORTERM = 'truecolor';
		env.TERM_PROGRAM = 'vault-terminal';
		env.TERM_PROGRAM_VERSION = this.manifest.version;
		env.OBSIDIAN_VAULT = this.vaultPath();
		if (!Platform.isWin && !env.LANG && !env.LC_ALL) env.LANG = 'en_US.UTF-8';
		for (const line of this.settings.env.split(/\r?\n/)) {
			const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
			if (m) env[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
		}
		return env;
	}

	getProfile(id?: string): ShellProfile {
		const ps = this.settings.profiles.filter((p) => p.command.trim());
		return (
			ps.find((p) => p.id === id) ??
			ps.find((p) => p.id === this.settings.defaultProfile) ??
			ps[0] ?? {
				id: 'fallback',
				name: 'Local',
				command: Platform.isWin ? 'powershell.exe' : process.env.SHELL || '/bin/zsh',
				args: Platform.isWin ? '-NoLogo' : '-l',
			}
		);
	}

	startDirectory(): string {
		const s = this.settings;
		if (s.startDir === 'activeFolder') {
			const parent = this.app.workspace.getActiveFile()?.parent;
			if (parent) return this.absPath(parent.path);
		}
		if (s.startDir === 'custom' && s.customStartDir.trim()) {
			const p = s.customStartDir.trim().replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || '~');
			return path.isAbsolute(p) ? p : path.join(this.vaultPath(), p);
		}
		return this.vaultPath();
	}

	/** "Local", "Local (2)"… unique across all terminal tabs. */
	nextTerminalName(profileId: string): string {
		const profile = this.getProfile(profileId);
		const base = profile.id === this.settings.defaultProfile || profile.id === 'fallback' ? 'Local' : profile.name || 'Shell';
		const used = new Set<string>();
		this.forEachView((v) => v.session && used.add(v.session.name));
		if (!used.has(base)) return base;
		for (let i = 2; ; i++) if (!used.has(`${base} (${i})`)) return `${base} (${i})`;
	}

	// ---------------------------------------------------------------- views

	/** A note/editor tab in the main area - not a terminal, not an empty tab, not in the terminals' tab group. */
	private isEditorLeaf(leaf: WorkspaceLeaf): boolean {
		const type = leaf.view?.getViewType();
		if (type === VIEW_TYPE || type === 'empty' || leaf.getRoot() !== this.app.workspace.rootSplit) return false;
		const siblings = (leaf.parent as unknown as { children?: WorkspaceLeaf[] } | null)?.children ?? [];
		return !siblings.some((l) => l.view instanceof TerminalView);
	}

	forEachView(fn: (v: TerminalView) => void) {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof TerminalView) fn(leaf.view);
		}
	}

	findView(): TerminalView | null {
		const views: TerminalView[] = [];
		this.forEachView((v) => views.push(v));
		if (this.lastTerminalView && views.includes(this.lastTerminalView)) return this.lastTerminalView;
		return views.sort((a, b) => b.lastFocused - a.lastFocused)[0] ?? null;
	}

	private async reveal(leaf: WorkspaceLeaf) {
		await this.app.workspace.revealLeaf(leaf);
		const l = leaf as WorkspaceLeaf & { loadIfDeferred?: () => Promise<void> };
		await l.loadIfDeferred?.();
	}

	/** A new tab right after `near`, in the same tab group. */
	private leafNextTo(near: WorkspaceLeaf): WorkspaceLeaf {
		const ws = this.app.workspace;
		const parent = near.parent as unknown as { children?: unknown[] } | null;
		const idx = parent?.children?.indexOf(near) ?? -1;
		if (parent && idx >= 0) {
			try {
				return ws.createLeafInParent(parent as never, idx + 1);
			} catch {
				/* fall through */
			}
		}
		ws.setActiveLeaf(near, { focus: false });
		return ws.getLeaf('tab');
	}

	/** The editor tab to go back to / open notes in (never a terminal or the terminals' group). */
	findEditorLeaf(): WorkspaceLeaf | null {
		const ws = this.app.workspace;
		let attached = false;
		const last = this.lastEditorLeaf;
		if (last) ws.iterateAllLeaves((l) => {
			if (l === last) attached = true;
		});
		if (last && attached && this.isEditorLeaf(last)) return last;
		const recent = ws.getMostRecentLeaf(ws.rootSplit);
		if (recent && this.isEditorLeaf(recent)) return recent;
		let found: WorkspaceLeaf | null = null;
		ws.iterateRootLeaves((l) => {
			if (!found && this.isEditorLeaf(l)) found = l;
		});
		return found;
	}

	private createLeaf(loc: Loc): WorkspaceLeaf {
		const ws = this.app.workspace;
		if (loc === 'right') return ws.getRightLeaf(false) ?? ws.getLeaf('tab');

		const base = this.findEditorLeaf() ?? ws.getMostRecentLeaf(ws.rootSplit);
		if (loc === 'tab') return base ? this.leafNextTo(base) : ws.getLeaf('tab');

		// bottom: split the editor area horizontally, terminal below
		if (!base) return ws.getLeaf('tab');
		const leaf = ws.createLeafBySplit(base, 'horizontal', false);
		try {
			type Sized = { setDimension?: (n: number) => void };
			(leaf.parent as unknown as Sized).setDimension?.(35);
			(base.parent as unknown as Sized).setDimension?.(65);
		} catch {
			/* private API changed - default 50/50 split is fine */
		}
		return leaf;
	}

	async openTerminalInLeaf(leaf: WorkspaceLeaf, opts: { profileId?: string; cwd?: string } = {}): Promise<TerminalView | null> {
		const state: TerminalViewState = { fresh: true, profileId: opts.profileId, cwd: opts.cwd };
		await leaf.setViewState({ type: VIEW_TYPE, active: true, state: state as Record<string, unknown> });
		await this.reveal(leaf);
		const view = leaf.view instanceof TerminalView ? leaf.view : null;
		if (view) {
			this.lastTerminalView = view;
			view.focusTerminal();
		}
		return view;
	}

	/**
	 * Opens a new terminal tab. Next to the most recent terminal when there is one
	 * (so all terminals share the bottom tab group), otherwise at the configured location.
	 */
	async newTerminal(opts: NewTerminalOptions = {}): Promise<TerminalView | null> {
		const near = opts.location ? null : (opts.near ?? this.findView()?.leaf ?? null);
		const leaf = near ? this.leafNextTo(near) : this.createLeaf(opts.location ?? this.settings.location);
		return this.openTerminalInLeaf(leaf, opts);
	}

	/** Toggle: open/focus the terminal; when it is focused, go back to the editor. */
	async toggleTerminal() {
		const view = this.findView();
		if (!view) {
			await this.newTerminal();
			return;
		}
		const doc = view.containerEl.doc;
		if (view.containerEl.contains(doc.activeElement)) {
			const ws = this.app.workspace;
			if (view.leaf.getRoot() === ws.rightSplit) ws.rightSplit.collapse();
			else if (view.leaf.getRoot() === ws.leftSplit) ws.leftSplit.collapse();
			const back = this.findEditorLeaf();
			if (back && back !== view.leaf) {
				ws.setActiveLeaf(back, { focus: true });
				const md = back.view instanceof MarkdownView ? back.view : null;
				md?.editor?.focus();
			}
			return;
		}
		await this.reveal(view.leaf);
		view.focusTerminal();
	}

	async focusTerminal(): Promise<TerminalView | null> {
		const view = this.findView();
		if (!view) return this.newTerminal();
		await this.reveal(view.leaf);
		view.focusTerminal();
		return view;
	}

	/** Cmd/Ctrl+click on a path in the terminal: open the note in the editor area (Shift = new tab). */
	openVaultFile(file: TFile, newTab: boolean) {
		const editor = this.findEditorLeaf();
		let target: WorkspaceLeaf;
		if (editor && !newTab) target = editor;
		else if (editor) target = this.leafNextTo(editor);
		else target = this.app.workspace.getLeaf('split', 'horizontal');
		target.openFile(file, { active: true }).catch((e) => new Notice(String(e)));
	}

	// ------------------------------------------------- Obsidian's empty "New tab"

	/** Adds "Open terminal" to the actions of empty tabs (the page Obsidian's + button opens). */
	decorateEmptyTabs(rebuild = false) {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view?.getViewType() !== 'empty') return;
			const list = leaf.view.containerEl.querySelector('.empty-state-action-list');
			if (!(list instanceof HTMLElement)) return;
			if (rebuild) list.querySelectorAll(`.${EMPTY_ACTION_CLS}`).forEach((el) => el.remove());
			if (list.querySelector(`.${EMPTY_ACTION_CLS}`)) return;
			const open = (profileId?: string) => () => void this.openTerminalInLeaf(leaf, { profileId });
			createEmptyTabAction(list, t('openTerminal'), null, open());
			for (const p of this.settings.profiles.filter((p) => p.command.trim() && p.id !== this.settings.defaultProfile)) {
				createEmptyTabAction(list, t('openTerminalWith', { name: p.name || p.command }), null, open(p.id));
			}
		});
	}
}

class ProfileModal extends FuzzySuggestModal<ShellProfile> {
	constructor(
		private plugin: VaultTerminalPlugin,
		private onPick: (p: ShellProfile) => void,
	) {
		super(plugin.app);
		this.setPlaceholder(t('pickProfile'));
	}
	getItems(): ShellProfile[] {
		return this.plugin.settings.profiles.filter((p) => p.command.trim());
	}
	getItemText(p: ShellProfile): string {
		return `${p.name || p.command}  —  ${[p.command, p.args].filter(Boolean).join(' ')}`;
	}
	onChooseItem(p: ShellProfile): void {
		this.onPick(p);
	}
}
