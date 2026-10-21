import { App, PluginSettingTab, Setting } from 'obsidian';
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
	}

	private async save(refresh = true) {
		await this.plugin.saveSettings();
		if (refresh) this.plugin.applySettingsToViews();
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();
		containerEl.addClass('terminal-tabs-settings');

		// ---------------------------------------------------------------- shell
		new Setting(containerEl).setName(t('setShell')).setHeading();

		new Setting(containerEl)
			.setName(t('setDefaultProfile'))
			.setDesc(t('setDefaultProfileDesc'))
			.addDropdown((dd) => {
				for (const p of s.profiles) dd.addOption(p.id, p.name || p.command);
				dd.setValue(s.defaultProfile).onChange(async (v) => {
					s.defaultProfile = v;
					await this.save(false);
				});
			});

		new Setting(containerEl).setName(t('setProfiles')).setDesc(t('setProfilesDesc'));
		for (const profile of s.profiles) {
			const row = new Setting(containerEl).setClass('terminal-tabs-profile-row');
			row.addText((tx) =>
				tx
					.setPlaceholder(t('setProfileName'))
					.setValue(profile.name)
					.onChange(async (v) => {
						profile.name = v;
						await this.save(false);
					}),
			);
			row.addText((tx) => {
				tx.inputEl.addClass('terminal-tabs-profile-command');
				tx.setPlaceholder(t('setProfileCommand'))
					.setValue(profile.command)
					.onChange(async (v) => {
						profile.command = v;
						await this.save(false);
					});
			});
			row.addText((tx) =>
				tx
					.setPlaceholder(t('setProfileArgs'))
					.setValue(profile.args)
					.onChange(async (v) => {
						profile.args = v;
						await this.save(false);
					}),
			);
			row.addExtraButton((b) =>
				b
					.setIcon('trash-2')
					.setTooltip(t('setDeleteProfile'))
					.setDisabled(s.profiles.length <= 1)
					.onClick(async () => {
						s.profiles = s.profiles.filter((p) => p !== profile);
						if (s.defaultProfile === profile.id) s.defaultProfile = s.profiles[0]?.id ?? '';
						await this.save(false);
						this.display();
					}),
			);
		}
		new Setting(containerEl)
			.addButton((b) =>
				b.setButtonText(t('setAddProfile')).onClick(async () => {
					s.profiles.push({ id: newId(), name: 'Shell', command: '', args: '' });
					await this.save(false);
					this.display();
				}),
			)
			.addButton((b) =>
				b.setButtonText(t('setResetProfiles')).onClick(async () => {
					s.profiles = detectProfiles();
					s.defaultProfile = s.profiles[0]?.id ?? '';
					await this.save(false);
					this.display();
				}),
			);

		const py = new Setting(containerEl).setName(t('setPython')).setDesc(t('setPythonDesc'));
		const status = py.descEl.createDiv({ cls: 'terminal-tabs-python-status' });
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
		py.addText((tx) =>
			tx
				.setPlaceholder(process.platform === 'win32' ? 'py -3' : '/usr/bin/python3')
				.setValue(s.pythonPath)
				.onChange(async (v) => {
					s.pythonPath = v;
					this.plugin.python = undefined;
					await this.save(false);
				}),
		);
		py.addButton((b) => b.setButtonText(t('setPythonCheck')).onClick(check));

		new Setting(containerEl)
			.setName(t('setEnv'))
			.setDesc(t('setEnvDesc'))
			.addTextArea((ta) => {
				ta.inputEl.rows = 3;
				ta.inputEl.addClass('terminal-tabs-mono');
				ta.setValue(s.env)
					.onChange(async (v) => {
						s.env = v;
						await this.save(false);
					});
			});

		// ------------------------------------------------------------ behaviour
		new Setting(containerEl).setName(t('setBehaviour')).setHeading();

		new Setting(containerEl)
			.setName(t('setLocation'))
			.setDesc(t('setLocationDesc'))
			.addDropdown((dd) =>
				dd
					.addOption('bottom', t('locBottom'))
					.addOption('right', t('locRight'))
					.addOption('tab', t('locTab'))
					.setValue(s.location)
					.onChange(async (v) => {
						s.location = v as Location;
						await this.save(false);
					}),
			);

		new Setting(containerEl)
			.setName(t('setStartDir'))
			.setDesc(t('setStartDirDesc'))
			.addDropdown((dd) =>
				dd
					.addOption('vault', t('startVault'))
					.addOption('activeFolder', t('startActive'))
					.addOption('custom', t('startCustom'))
					.setValue(s.startDir)
					.onChange(async (v) => {
						s.startDir = v as StartDir;
						await this.save(false);
						this.display();
					}),
			);
		if (s.startDir === 'custom') {
			new Setting(containerEl)
				.setName(t('setCustomDir'))
				.setDesc(t('setCustomDirDesc'))
				.addText((tx) =>
					tx.setValue(s.customStartDir).onChange(async (v) => {
						s.customStartDir = v;
						await this.save(false);
					}),
				);
		}

		this.toggle(containerEl, 'setCloseOnExit', 'closeOnExit', 'setCloseOnExitDesc');
		this.toggle(containerEl, 'setCopyOnSelect', 'copyOnSelect');
		this.toggle(containerEl, 'setOverrideHotkeys', 'overrideHotkeys', 'setOverrideHotkeysDesc');
		this.toggle(containerEl, 'setLinkFiles', 'linkVaultFiles', 'setLinkFilesDesc');
		if (process.platform === 'darwin') this.toggle(containerEl, 'setMacOptionMeta', 'macOptionIsMeta', 'setMacOptionMetaDesc');

		// ----------------------------------------------------------- appearance
		new Setting(containerEl).setName(t('setAppearance')).setHeading();

		new Setting(containerEl).setName(t('setColors')).addDropdown((dd) =>
			dd
				.addOption('auto', t('colorsAuto'))
				.addOption('dark', t('colorsDark'))
				.addOption('light', t('colorsLight'))
				.setValue(s.colorScheme)
				.onChange(async (v) => {
					s.colorScheme = v as ColorScheme;
					await this.save();
				}),
		);

		new Setting(containerEl)
			.setName(t('setFontFamily'))
			.setDesc(t('setFontFamilyDesc'))
			.addText((tx) =>
				tx
					.setPlaceholder(monospaceFont(containerEl))
					.setValue(s.fontFamily)
					.onChange(async (v) => {
						s.fontFamily = v;
						await this.save();
					}),
			);

		new Setting(containerEl).setName(t('setFontSize')).addSlider((sl) =>
			sl
				.setLimits(8, 28, 1)
				.setValue(s.fontSize)
				.onChange(async (v) => {
					s.fontSize = v;
					await this.save();
				}),
		);

		new Setting(containerEl).setName(t('setLineHeight')).addSlider((sl) =>
			sl
				.setLimits(1, 2, 0.05)
				.setValue(s.lineHeight)
				.onChange(async (v) => {
					s.lineHeight = v;
					await this.save();
				}),
		);

		new Setting(containerEl).setName(t('setCursorStyle')).addDropdown((dd) =>
			dd
				.addOption('block', t('cursorBlock'))
				.addOption('bar', t('cursorBar'))
				.addOption('underline', t('cursorUnderline'))
				.setValue(s.cursorStyle)
				.onChange(async (v) => {
					s.cursorStyle = v as TerminalTabsSettings['cursorStyle'];
					await this.save();
				}),
		);
		this.toggle(containerEl, 'setCursorBlink', 'cursorBlink');
		this.toggle(containerEl, 'setShowHeader', 'showViewHeader', 'setShowHeaderDesc');

		new Setting(containerEl).setName(t('setScrollback')).addText((tx) => {
			tx.inputEl.type = 'number';
			tx.setValue(String(s.scrollback)).onChange(async (v) => {
				const n = Number(v);
				if (Number.isFinite(n) && n >= 0) {
					s.scrollback = Math.min(1_000_000, Math.round(n));
					await this.save();
				}
			});
		});
	}

	private toggle(
		el: HTMLElement,
		name: Parameters<typeof t>[0],
		key: { [K in keyof TerminalTabsSettings]: TerminalTabsSettings[K] extends boolean ? K : never }[keyof TerminalTabsSettings],
		desc?: Parameters<typeof t>[0],
	) {
		const st = new Setting(el).setName(t(name));
		if (desc) st.setDesc(t(desc));
		st.addToggle((tg) =>
			tg.setValue(this.plugin.settings[key]).onChange(async (v) => {
				this.plugin.settings[key] = v;
				await this.save();
			}),
		);
	}
}
