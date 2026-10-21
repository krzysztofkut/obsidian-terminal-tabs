import type { ITheme } from '@xterm/xterm';
import type { ColorScheme } from './settings';

// ANSI palettes for the dark / light terminal schemes.
const DARK_ANSI = {
	black: '#000000',
	red: '#f0524f',
	green: '#5c962c',
	yellow: '#a68a0d',
	blue: '#3993d4',
	magenta: '#a771bf',
	cyan: '#00a3a3',
	white: '#808080',
	brightBlack: '#595959',
	brightRed: '#ff4050',
	brightGreen: '#4fc414',
	brightYellow: '#e5bf00',
	brightBlue: '#1fb0ff',
	brightMagenta: '#ed7eed',
	brightCyan: '#00e5e5',
	brightWhite: '#ffffff',
};

const LIGHT_ANSI = {
	black: '#24292f',
	red: '#cf222e',
	green: '#116329',
	yellow: '#7d4e00',
	blue: '#0969da',
	magenta: '#8250df',
	cyan: '#1b7c83',
	white: '#6e7781',
	brightBlack: '#57606a',
	brightRed: '#a40e26',
	brightGreen: '#1a7f37',
	brightYellow: '#633c01',
	brightBlue: '#218bff',
	brightMagenta: '#a475f9',
	brightCyan: '#3192aa',
	brightWhite: '#8c959f',
};

const FIXED = {
	dark: { background: '#2b2b2b', foreground: '#bbbbbb', cursor: '#bbbbbb', selection: '#214283' },
	light: { background: '#ffffff', foreground: '#1f1f1f', cursor: '#1f1f1f', selection: '#a6d2ff' },
};

function hex2(n: number): string {
	return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

/** "rgb(1, 2, 3)" / "rgba(1, 2, 3, 0.5)" -> "#010203" / "#01020380" */
function cssToHex(css: string): string | null {
	const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(css);
	if (!m) return null;
	let a = 1;
	if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
	const base = `#${hex2(+m[1])}${hex2(+m[2])}${hex2(+m[3])}`;
	return a >= 1 ? base : a <= 0 ? null : base + hex2(a * 255);
}

/** Resolves any CSS colour expression (including var(--x)) in the context of `el`. */
function resolve(el: HTMLElement, expr: string): string | null {
	const probe = el.createDiv();
	probe.setCssStyles({ display: 'none', color: expr });
	const value = getComputedStyle(probe).color;
	probe.remove();
	return cssToHex(value);
}

function backgroundOf(el: HTMLElement): string | null {
	let cur: HTMLElement | null = el;
	while (cur) {
		const c = cssToHex(getComputedStyle(cur).backgroundColor);
		if (c && c.length === 7) return c;
		cur = cur.parentElement;
	}
	return null;
}

export function buildTheme(el: HTMLElement, scheme: ColorScheme): ITheme {
	const obsidianDark = el.doc.body.classList.contains('theme-dark');
	if (scheme !== 'auto') {
		const f = FIXED[scheme];
		return {
			...(scheme === 'dark' ? DARK_ANSI : LIGHT_ANSI),
			background: f.background,
			foreground: f.foreground,
			cursor: f.cursor,
			cursorAccent: f.background,
			selectionBackground: f.selection,
			selectionInactiveBackground: f.selection + '99',
		};
	}

	const background = backgroundOf(el) ?? (obsidianDark ? FIXED.dark.background : FIXED.light.background);
	const foreground = resolve(el, 'var(--text-normal)') ?? (obsidianDark ? FIXED.dark.foreground : FIXED.light.foreground);
	const accent = resolve(el, 'var(--text-accent, var(--interactive-accent))') ?? foreground;
	const selection = resolve(el, 'var(--text-selection)') ?? (obsidianDark ? '#ffffff33' : '#00000022');
	const muted = resolve(el, 'var(--text-faint)');
	return {
		...(obsidianDark ? DARK_ANSI : LIGHT_ANSI),
		background,
		foreground,
		cursor: accent,
		cursorAccent: background,
		selectionBackground: selection,
		selectionInactiveBackground: selection,
		scrollbarSliderBackground: muted ? muted.slice(0, 7) + '33' : undefined,
		scrollbarSliderHoverBackground: muted ? muted.slice(0, 7) + '66' : undefined,
		scrollbarSliderActiveBackground: muted ? muted.slice(0, 7) + '99' : undefined,
	};
}

export function monospaceFont(el: HTMLElement): string {
	const probe = el.createDiv();
	probe.setCssStyles({ display: 'none', fontFamily: 'var(--font-monospace)' });
	const v = getComputedStyle(probe).fontFamily.trim();
	probe.remove();
	return v && v !== 'var(--font-monospace)' ? v : 'Menlo, Monaco, "Courier New", monospace';
}
