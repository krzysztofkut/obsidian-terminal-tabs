import { getLanguage } from 'obsidian';
import { de } from './locales/de';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { it } from './locales/it';
import { ja } from './locales/ja';
import { ko } from './locales/ko';
import { pl } from './locales/pl';
import { ptBR } from './locales/ptBR';
import { ru } from './locales/ru';
import { tr } from './locales/tr';
import { uk } from './locales/uk';
import { zh } from './locales/zh';
import { zhTW } from './locales/zhTW';

export const en = {
	viewTitle: 'Terminal',
	newTab: 'New terminal tab',
	closeTab: 'Close tab',
	renameTab: 'Rename tab',
	duplicateTab: 'Duplicate tab',
	copy: 'Copy',
	paste: 'Paste',
	selectAll: 'Select all',
	clear: 'Clear buffer',
	find: 'Find',
	findPlaceholder: 'Find',
	findPrev: 'Previous match (Shift+Enter)',
	findNext: 'Next match (Enter)',
	findCase: 'Match case',
	findRegex: 'Regex',
	findClose: 'Close (Esc)',
	noMatches: 'No matches',
	restart: 'Restart',
	processExited: 'Process exited with code {code}',
	pressEnterToRestart: 'Press Enter to restart, Esc to close the tab.',
	pythonMissing:
		'Vault Terminal needs Python 3 to create a pseudo-terminal. Install it (e.g. `xcode-select --install` or `brew install python`) or set the Python path in the plugin settings.',
	pythonMissingWin:
		'Vault Terminal needs Python 3 with the "pywinpty" package (python -m pip install pywinpty). You can set the Python path in the plugin settings.',
	openInTerminal: 'Open in Terminal',
	openTerminal: 'Open terminal',
	openTerminalWith: 'Open terminal: {name}',
	newTabWithProfile: 'New terminal tab: {name}',
	pickProfile: 'Shell profile…',
	cmdNewTabProfile: 'New terminal tab with profile…',
	cmdRenameTab: 'Rename terminal tab',
	setShowHeader: 'Show view header',
	setShowHeaderDesc: 'The bar with the title and ⋯ menu above the terminal. The tab itself already shows the name.',

	cmdToggle: 'Toggle terminal',
	cmdNewTab: 'New terminal tab',
	cmdNewView: 'Open terminal as an editor tab',
	cmdActiveFolder: "Open terminal in current file's folder",
	cmdCloseTab: 'Close terminal tab',
	cmdClear: 'Clear terminal',
	cmdSendSelection: 'Run selected text in terminal',
	cmdFocus: 'Focus terminal',

	setShell: 'Shell',
	setProfiles: 'Shell profiles',
	setProfilesDesc: 'Shells you can open from the tab menu, the empty New tab page and “New terminal tab with profile”. Arguments are split like a command line.',
	setProfileName: 'Name',
	setProfileCommand: 'Command',
	setProfileArgs: 'Arguments',
	setAddProfile: 'Add profile',
	setResetProfiles: 'Restore detected profiles',
	setDeleteProfile: 'Delete profile',
	setDefaultProfile: 'Default profile',
	setDefaultProfileDesc: 'Used by “Toggle terminal”, Cmd/Ctrl+Shift+T and “Open terminal”.',
	setPython: 'Python executable',
	setPythonDesc: 'Python 3 runs the small PTY bridge. Leave empty to detect automatically.',
	setPythonCheck: 'Check',
	setPythonFound: 'Found Python {version}: {command}',
	setPythonFoundNoWinpty: 'Found Python {version} but "pywinpty" is missing: {command} -m pip install pywinpty',
	setPythonNotFound: 'Python 3 not found.',
	setEnv: 'Environment variables',
	setEnvDesc: 'One KEY=value per line, added to the shell environment.',

	setBehaviour: 'Behaviour',
	setStartDir: 'Start directory',
	setStartDirDesc: 'Working directory of new tabs.',
	startVault: 'Vault root',
	startActive: "Active file's folder",
	startCustom: 'Custom folder',
	setCustomDir: 'Custom folder',
	setCustomDirDesc: 'Absolute path or a path relative to the vault root.',
	setLocation: 'Open terminal in',
	setLocationDesc: 'Where the first terminal opens. Further terminals open as tabs next to it.',
	locBottom: 'Bottom split',
	locRight: 'Right sidebar',
	locTab: 'New tab',
	setCloseOnExit: 'Close tab when the shell exits',
	setCloseOnExitDesc: 'After `exit` (code 0) the tab closes. Other exit codes keep the tab open.',
	setCopyOnSelect: 'Copy on select',
	setOverrideHotkeys: 'Terminal takes over Obsidian hotkeys',
	setOverrideHotkeysDesc:
		'While the terminal is focused, keys go to the shell (Ctrl+P, Ctrl+W, Esc…). Alt+F12 still returns to the editor.',
	setMacOptionMeta: 'Option key acts as Meta (macOS)',
	setMacOptionMetaDesc: 'Turn off to type characters such as ą, ę, ł with Option.',
	setLinkFiles: 'Clickable vault file paths',
	setLinkFilesDesc: 'Paths of notes printed in the terminal (ls, grep, git status…) open in Obsidian with Cmd/Ctrl+click.',

	setAppearance: 'Appearance',
	setFontFamily: 'Font family',
	setFontFamilyDesc: "Empty = Obsidian's monospace font.",
	setFontSize: 'Font size',
	setLineHeight: 'Line height',
	setCursorStyle: 'Cursor style',
	cursorBlock: 'Block',
	cursorBar: 'Bar',
	cursorUnderline: 'Underline',
	setCursorBlink: 'Blinking cursor',
	setScrollback: 'Scrollback lines',
	setColors: 'Color scheme',
	colorsAuto: 'Follow Obsidian theme',
	colorsDark: 'Dark',
	colorsLight: 'Light',
};

export type I18nKey = keyof typeof en;

export type Locale = Partial<Record<I18nKey, string>>;

// Keys are Obsidian language codes, lower-case; a regional code falls back to its base language (pt-PT → pt).
export const locales: Record<string, Locale> = { de, es, fr, it, ja, ko, pl, pt: ptBR, 'pt-br': ptBR, ru, tr, uk, zh, 'zh-tw': zhTW };

export function pickLocale(lang: string): Locale {
	const l = lang.toLowerCase();
	return locales[l] ?? locales[l.split('-')[0]] ?? {};
}

const dict = pickLocale(getLanguage());

export function t(key: I18nKey, vars?: Record<string, string | number>): string {
	let s = dict[key] ?? en[key];
	if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
	return s;
}
