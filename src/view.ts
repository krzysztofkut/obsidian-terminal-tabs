import { ItemView, Menu, Modal, Setting, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import { t } from './i18n';
import { SessionHost, SessionState, TerminalSession } from './session';
import type VaultTerminalPlugin from './main';

export const VIEW_TYPE = 'vault-terminal-view';

export interface TerminalViewState {
	name?: string;
	cwd?: string;
	profileId?: string;
	customName?: boolean;
	/** set by the plugin when it opens a brand new terminal (not a restore after restart) */
	fresh?: boolean;
}

/** Private bits of WorkspaceLeaf we use for the tab title (guarded, all optional). */
interface LeafInternals {
	tabHeaderEl?: HTMLElement;
	tabHeaderInnerTitleEl?: HTMLElement;
	updateHeader?: () => void;
}

/** One terminal = one Obsidian tab. The tab title is the terminal's name. */
export class TerminalView extends ItemView implements SessionHost {
	session: TerminalSession | null = null;
	lastFocused = 0;

	private plugin: VaultTerminalPlugin;
	private bodyEl!: HTMLElement;
	private closing = false;
	private resizeObserver: ResizeObserver | null = null;
	private fitFrame: number | null = null;
	private headerHooked: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: VaultTerminalPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.navigation = false;
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.session?.name ?? t('viewTitle');
	}

	getIcon(): string {
		return 'terminal';
	}

	// ------------------------------------------------------------ lifecycle

	async onOpen(): Promise<void> {
		this.containerEl.addClass('vault-terminal-leaf');
		this.applyHeaderSetting();
		const root = this.contentEl;
		root.empty();
		root.addClass('vault-terminal');
		this.bodyEl = root.createDiv({ cls: 'vault-terminal-body' });

		this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
		this.resizeObserver.observe(this.bodyEl);

		// Fallback if Obsidian never hands us a state.
		window.setTimeout(() => {
			if (!this.session && !this.closing) this.init({});
		}, 400);
	}

	async onClose(): Promise<void> {
		this.closing = true;
		this.resizeObserver?.disconnect();
		this.session?.dispose();
		this.session = null;
	}

	onResize(): void {
		this.scheduleFit();
	}

	getState(): Record<string, unknown> {
		return (this.session?.toState() ?? {}) as unknown as Record<string, unknown>;
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		if (!this.session && !this.closing) this.init((state ?? {}) as TerminalViewState);
		await super.setState(state, result);
	}

	private init(st: TerminalViewState) {
		const profile = this.plugin.getProfile(st.profileId);
		const full: SessionState = {
			name: st.name || this.plugin.nextTerminalName(profile.id),
			customName: !!st.customName,
			cwd: st.cwd || this.plugin.startDirectory(),
			profileId: profile.id,
		};
		this.session = new TerminalSession(this.plugin, this, this.bodyEl, full);
		this.session.show();
		this.refreshHeader();
		this.requestSave();
		if (this.app.workspace.getActiveViewOfType(TerminalView) === this) window.setTimeout(() => this.session?.focus(), 0);
	}

	requestSave() {
		const ws = this.app.workspace as unknown as { requestSaveLayout?: () => void };
		ws.requestSaveLayout?.();
	}

	// ------------------------------------------------------- SessionHost

	onSessionChange() {
		const header = (this.leaf as unknown as LeafInternals).tabHeaderEl;
		header?.toggleClass('vault-terminal-exited', !!this.session && !this.session.isRunning);
	}

	onSessionFocus() {
		this.lastFocused = Date.now();
		this.plugin.lastTerminalView = this;
	}

	closeSession() {
		this.closing = true;
		this.leaf.detach();
	}

	newSession(opts: { profileId?: string; cwd?: string } = {}) {
		void this.plugin.newTerminal({ ...opts, near: this.leaf });
	}

	renameSession() {
		const s = this.session;
		if (!s) return;
		const title = (this.leaf as unknown as LeafInternals).tabHeaderInnerTitleEl;
		if (title && title.isShown()) this.renameInline(title, s);
		else new RenameModal(this.plugin, s.name, (v) => this.setName(v)).open();
	}

	// ------------------------------------------------------------ name & header

	setName(name: string) {
		const s = this.session;
		const v = name.trim();
		if (!s || !v || v === s.name) return;
		s.name = v;
		s.customName = true;
		this.refreshHeader();
		this.requestSave();
	}

	/** Re-renders the Obsidian tab title and hooks double-click-to-rename on it. */
	refreshHeader() {
		const leaf = this.leaf as unknown as LeafInternals;
		try {
			leaf.updateHeader?.();
		} catch {
			/* private API */
		}
		const title = leaf.tabHeaderInnerTitleEl;
		if (title && this.session && title.textContent !== this.session.name) title.setText(this.session.name);
		const header = leaf.tabHeaderEl;
		if (header && this.headerHooked !== header) {
			this.headerHooked = header;
			header.addClass('vault-terminal-tab-header');
			this.registerDomEvent(header, 'dblclick', (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.renameSession();
			});
		}
		this.onSessionChange();
	}

	private renameInline(title: HTMLElement, s: TerminalSession) {
		const input = createEl('input', { cls: 'vault-terminal-tab-rename', type: 'text', value: s.name });
		input.size = Math.max(6, s.name.length + 1);
		title.empty();
		title.appendChild(input);
		input.focus();
		input.select();
		let done = false;
		const finish = (commit: boolean) => {
			if (done) return;
			done = true;
			input.remove();
			if (commit) this.setName(input.value);
			title.setText(s.name);
			this.refreshHeader();
			s.focus();
		};
		input.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Enter') finish(true);
			else if (e.key === 'Escape') finish(false);
		});
		input.addEventListener('input', () => (input.size = Math.max(6, input.value.length + 1)));
		input.addEventListener('blur', () => finish(true));
		for (const ev of ['mousedown', 'click', 'dblclick', 'dragstart'] as const) input.addEventListener(ev, (e) => e.stopPropagation());
	}

	applyHeaderSetting() {
		this.containerEl.toggleClass('vault-terminal-hide-header', !this.plugin.settings.showViewHeader);
	}

	// ------------------------------------------------------------ menus

	/** Items in the tab's right-click menu and in "More options". */
	onPaneMenu(menu: Menu, source: string): void {
		const s = this.session;
		if (s) {
			menu.addItem((i) =>
				i
					.setSection('action')
					.setTitle(t('renameTab'))
					.setIcon('pencil')
					.onClick(() => this.renameSession()),
			);
			menu.addItem((i) =>
				i
					.setSection('action')
					.setTitle(t('duplicateTab'))
					.setIcon('copy-plus')
					.onClick(async () => this.newSession({ profileId: s.profileId, cwd: await s.refreshCwd() })),
			);
			menu.addItem((i) =>
				i
					.setSection('action')
					.setTitle(t('restart'))
					.setIcon('rotate-ccw')
					.onClick(() => s.restart()),
			);
			menu.addItem((i) =>
				i
					.setSection('action')
					.setTitle(t('clear'))
					.setIcon('eraser')
					.onClick(() => s.clear()),
			);
		}
		menu.addItem((i) =>
			i
				.setSection('open')
				.setTitle(t('newTab'))
				.setIcon('plus')
				.onClick(() => this.newSession()),
		);
		for (const p of this.plugin.settings.profiles.filter((p) => p.command.trim())) {
			if (p.id === this.plugin.settings.defaultProfile) continue;
			menu.addItem((i) =>
				i
					.setSection('open')
					.setTitle(t('newTabWithProfile', { name: p.name || p.command }))
					.setIcon('terminal')
					.onClick(() => this.newSession({ profileId: p.id })),
			);
		}
		super.onPaneMenu(menu, source);
	}

	// ------------------------------------------------------------ misc

	focusTerminal() {
		this.session?.focus();
	}

	applySettings() {
		this.applyHeaderSetting();
		this.session?.applySettings();
	}

	applyTheme() {
		this.session?.applyTheme();
	}

	private scheduleFit() {
		if (this.fitFrame !== null) return;
		this.fitFrame = window.requestAnimationFrame(() => {
			this.fitFrame = null;
			this.session?.fitNow();
		});
	}
}

class RenameModal extends Modal {
	constructor(
		plugin: VaultTerminalPlugin,
		private value: string,
		private onSubmit: (v: string) => void,
	) {
		super(plugin.app);
	}

	onOpen() {
		this.titleEl.setText(t('renameTab'));
		let input: HTMLInputElement | null = null;
		new Setting(this.contentEl).addText((tx) => {
			input = tx.inputEl;
			tx.setValue(this.value).onChange((v) => (this.value = v));
			tx.inputEl.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					this.submit();
				}
			});
		});
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText('OK')
				.setCta()
				.onClick(() => this.submit()),
		);
		window.setTimeout(() => {
			(input as HTMLInputElement | null)?.focus();
			(input as HTMLInputElement | null)?.select();
		}, 0);
	}

	private submit() {
		this.onSubmit(this.value);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}
