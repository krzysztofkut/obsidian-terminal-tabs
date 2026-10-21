import { App, PluginSettingTab, Setting, SettingDefinitionItem } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { t } from './i18n';
import { detectPython } from './pty';
import { monospaceFont } from './theme';
import type TerminalTabsPlugin from './main';

export interface ShellProfile {
	id: string;
	name: string;
	command: string;
	args: string;
}

export type StartDir = 'vault' | 'activeFolder' | 'custom';
export type Location = 'bottom' | 'right' | 'tab';
export type ColorScheme = 'auto' | 'dark' | 'light';

export interface TerminalTabsSettings {
	profiles: ShellProfile[];
	defaultProfile: string;
	pythonPath: string;
	env: string;

	startDir: StartDir;
	customStartDir: string;
	location: Location;
	closeOnExit: boolean;
	copyOnSelect: boolean;
	overrideHotkeys: boolean;
	macOptionIsMeta: boolean;
	linkVaultFiles: boolean;
	showViewHeader: boolean;

	fontFamily: string;
	fontSize: number;
	lineHeight: number;
	cursorStyle: 'block' | 'bar' | 'underline';
	cursorBlink: boolean;
	scrollback: number;
	colorScheme: ColorScheme;
}

export const DEFAULT_SETTINGS: TerminalTabsSettings = {
	profiles: [],
	defaultProfile: '',
	pythonPath: '',
	env: '',

	startDir: 'vault',
	customStartDir: '',
	location: 'bottom',
	closeOnExit: true,
	copyOnSelect: false,
	overrideHotkeys: true,
	macOptionIsMeta: false,
	linkVaultFiles: true,
	showViewHeader: false,

	fontFamily: '',
	fontSize: 13,
	lineHeight: 1.2,
	cursorStyle: 'block',
	cursorBlink: true,
	scrollback: 10000,
	colorScheme: 'auto',
};

export function newId(): string {
	return Math.random().toString(36).slice(2, 10);
}

/** Shells that exist on this machine, in the order they are offered. */
export function detectProfiles(): ShellProfile[] {
	const out: ShellProfile[] = [];
	const add = (name: string, command: string, args: string) => out.push({ id: newId(), name, command, args });
	const exists = (p: string) => {
		try {
			return fs.existsSync(p);
		} catch {
			return false;
		}
	};

	if (process.platform === 'win32') {
		const sysRoot = process.env.SystemRoot || 'C:\\Windows';
		const pf = process.env.ProgramFiles || 'C:\\Program Files';
		const pwsh = path.join(pf, 'PowerShell', '7', 'pwsh.exe');
		if (exists(pwsh)) add('PowerShell 7', pwsh, '-NoLogo');
		add('Windows PowerShell', 'powershell.exe', '-NoLogo');
		add('Command Prompt', path.join(sysRoot, 'System32', 'cmd.exe'), '');
		const gitBash = path.join(pf, 'Git', 'bin', 'bash.exe');
		if (exists(gitBash)) add('Git Bash', gitBash, '--login -i');
		const wsl = path.join(sysRoot, 'System32', 'wsl.exe');
		if (exists(wsl)) add('WSL', wsl, '');
		return out;
	}

	const userShell = process.env.SHELL;
	const seen = new Set<string>();
	const addUnix = (p: string) => {
		if (seen.has(path.basename(p)) || !exists(p)) return;
		seen.add(path.basename(p));
		const base = path.basename(p);
		// Login shell, so PATH from ~/.zprofile / ~/.bash_profile is loaded
		// even when Obsidian was started from the Dock.
		const args = base === 'fish' || base === 'zsh' || base === 'bash' || base === 'sh' ? '-l' : '';
		add(base, p, args);
	};
	if (userShell) addUnix(userShell);
	for (const p of ['/bin/zsh', '/bin/bash', '/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish', '/opt/homebrew/bin/nu']) addUnix(p);
	if (!out.length) add('sh', '/bin/sh', '');
	return out;
}

export class TerminalTabsSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: TerminalTabsPlugin) {
		super(app, plugin);
		this.containerEl.addClass('terminal-tabs-settings');
	}

	/** Settings that change how open terminals look; the rest apply to new tabs. */
	private static readonly LIVE = new Set<string>(['colorScheme', 'fontFamily', 'fontSize', 'lineHeight', 'cursorStyle', 'cursorBlink', 'showViewHeader', 'scrollback', 'copyOnSelect', 'overrideHotkeys', 'linkVaultFiles', 'macOptionIsMeta', 'closeOnExit']);

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings as unknown as Record<string, unknown>;
		s[key] = value;
		if (key === 'pythonPath') this.plugin.python = undefined;
		await this.save(TerminalTabsSettingTab.LIVE.has(key));
		if (key === 'startDir') this.update();
	}

	private async save(refresh: boolean) {
		await this.plugin.saveSettings();
		if (refresh) this.plugin.applySettingsToViews();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		const profileOptions = Object.fromEntries(s.profiles.map((p) => [p.id, p.name || p.command]));
		return [
			{
				type: 'group',
				heading: t('setShell'),
				items: [
					{ name: t('setDefaultProfile'), desc: t('setDefaultProfileDesc'), control: { type: 'dropdown', key: 'defaultProfile', options: profileOptions } },
					{ name: t('setPython'), desc: t('setPythonDesc'), aliases: ['python3', 'pywinpty'], render: (setting) => this.renderPython(setting) },
					{ name: t('setEnv'), desc: t('setEnvDesc'), control: { type: 'textarea', key: 'env', rows: 3 } },
				],
			},
			{
				type: 'list',
				heading: t('setProfiles'),
				emptyState: t('setProfilesDesc'),
				items: s.profiles.map((profile) => ({ name: profile.name || profile.command, render: (setting: Setting) => this.renderProfile(setting, profile) })),
				onDelete: (index) => void this.deleteProfile(index),
				addItem: { name: t('setAddProfile'), action: () => void this.changeProfiles(() => s.profiles.push({ id: newId(), name: 'Shell', command: '', args: '' })) },
				extraButtons: [
					(b) =>
						b
							.setIcon('rotate-ccw')
							.setTooltip(t('setResetProfiles'))
							.onClick(() => void this.changeProfiles(() => {
								s.profiles = detectProfiles();
								s.defaultProfile = s.profiles[0]?.id ?? '';
							})),
				],
			},
			{
				type: 'group',
				heading: t('setBehaviour'),
				items: [
					{ name: t('setLocation'), desc: t('setLocationDesc'), control: { type: 'dropdown', key: 'location', options: { bottom: t('locBottom'), right: t('locRight'), tab: t('locTab') } } },
					{ name: t('setStartDir'), desc: t('setStartDirDesc'), control: { type: 'dropdown', key: 'startDir', options: { vault: t('startVault'), activeFolder: t('startActive'), custom: t('startCustom') } } },
					{ name: t('setCustomDir'), desc: t('setCustomDirDesc'), visible: () => s.startDir === 'custom', control: { type: 'text', key: 'customStartDir' } },
					{ name: t('setCloseOnExit'), desc: t('setCloseOnExitDesc'), control: { type: 'toggle', key: 'closeOnExit' } },
					{ name: t('setCopyOnSelect'), control: { type: 'toggle', key: 'copyOnSelect' } },
					{ name: t('setOverrideHotkeys'), desc: t('setOverrideHotkeysDesc'), control: { type: 'toggle', key: 'overrideHotkeys' } },
					{ name: t('setLinkFiles'), desc: t('setLinkFilesDesc'), control: { type: 'toggle', key: 'linkVaultFiles' } },
					{ name: t('setMacOptionMeta'), desc: t('setMacOptionMetaDesc'), visible: process.platform === 'darwin', control: { type: 'toggle', key: 'macOptionIsMeta' } },
				],
			},
			{
				type: 'group',
				heading: t('setAppearance'),
				items: [
					{ name: t('setColors'), control: { type: 'dropdown', key: 'colorScheme', options: { auto: t('colorsAuto'), dark: t('colorsDark'), light: t('colorsLight') } } },
					{ name: t('setFontFamily'), desc: t('setFontFamilyDesc'), control: { type: 'text', key: 'fontFamily', placeholder: monospaceFont(this.containerEl) } },
					{ name: t('setFontSize'), control: { type: 'slider', key: 'fontSize', min: 8, max: 28, step: 1 } },
					{ name: t('setLineHeight'), control: { type: 'slider', key: 'lineHeight', min: 1, max: 2, step: 0.05 } },
					{ name: t('setCursorStyle'), control: { type: 'dropdown', key: 'cursorStyle', options: { block: t('cursorBlock'), bar: t('cursorBar'), underline: t('cursorUnderline') } } },
					{ name: t('setCursorBlink'), control: { type: 'toggle', key: 'cursorBlink' } },
					{ name: t('setShowHeader'), desc: t('setShowHeaderDesc'), control: { type: 'toggle', key: 'showViewHeader' } },
					{ name: t('setScrollback'), control: { type: 'number', key: 'scrollback', min: 0, max: 1_000_000, step: 1 } },
				],
			},
		];
	}

	/** Runs a change to the profile list, keeps the default profile valid and re-renders. */
	private async changeProfiles(change: () => void) {
		change();
		const s = this.plugin.settings;
		if (!s.profiles.some((p) => p.id === s.defaultProfile)) s.defaultProfile = s.profiles[0]?.id ?? '';
		await this.save(false);
		this.update();
	}

	private async deleteProfile(index: number) {
		const s = this.plugin.settings;
		if (s.profiles.length <= 1) return; // at least one shell must stay
		await this.changeProfiles(() => s.profiles.splice(index, 1));
	}

	private renderProfile(setting: Setting, profile: ShellProfile) {
		setting.setClass('terminal-tabs-profile-row');
		const field = (placeholder: string, key: 'name' | 'command' | 'args', cls?: string) =>
			setting.addText((tx) => {
				if (cls) tx.inputEl.addClass(cls);
				tx.setPlaceholder(placeholder)
					.setValue(profile[key])
					.onChange(async (v) => {
						profile[key] = v;
						await this.save(false);
					});
			});
		field(t('setProfileName'), 'name');
		field(t('setProfileCommand'), 'command', 'terminal-tabs-profile-command');
		field(t('setProfileArgs'), 'args');
	}

	private renderPython(setting: Setting) {
		const s = this.plugin.settings;
		const status = setting.descEl.createDiv({ cls: 'terminal-tabs-python-status' });
		const check = () => {
			const info = detectPython(s.pythonPath, this.plugin.baseEnv());
			this.plugin.python = info;
			status.removeClass('mod-ok', 'mod-warn');
			if (!info) {
				status.setText(t('setPythonNotFound'));
				status.addClass('mod-warn');
			} else {
				const command = [info.command, ...info.args].join(' ');
				const noWinpty = process.platform === 'win32' && !info.hasWinpty;
				status.setText(t(noWinpty ? 'setPythonFoundNoWinpty' : 'setPythonFound', { version: info.version, command }));
				status.addClass(noWinpty ? 'mod-warn' : 'mod-ok');
			}
		};
		setting.addText((tx) =>
			tx
				.setPlaceholder(process.platform === 'win32' ? 'py -3' : '/usr/bin/python3')
				.setValue(s.pythonPath)
				.onChange((v) => void this.setControlValue('pythonPath', v)),
		);
		setting.addButton((b) => b.setButtonText(t('setPythonCheck')).onClick(check));
	}
}
