import { setIcon } from 'obsidian';

export const EMPTY_ACTION_CLS = 'vault-terminal-empty-action';

const HOTKEY_RE = /[⌘⌥⇧⌃]|\b(Ctrl|Alt|Shift|Cmd|Meta|Mod)\b/;

function textNodes(root: Node): Text[] {
	const out: Text[] = [];
	const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.trim()) out.push(n as Text);
	return out;
}

/** Native actions of Obsidian's empty "New tab" page, without ours. */
function nativeActions(list: HTMLElement): HTMLElement[] {
	return Array.from(list.children).filter(
		(el): el is HTMLElement => el.instanceOf(HTMLElement) && !el.hasClass(EMPTY_ACTION_CLS),
	);
}

/**
 * Builds an action that looks exactly like Obsidian's own ones ("Create new note (⌘ N)"…):
 * the first native action is cloned - same tag, classes, icon and hotkey markup - and only
 * the label, hotkey and icon are replaced. Works whatever the Obsidian version / theme renders.
 */
export function createEmptyTabAction(list: HTMLElement, label: string, hotkey: string | null, onClick: () => void): HTMLElement {
	const natives = nativeActions(list);
	// Prefer an action with a hotkey ("Create new note (⌘ N)") as the template, never "Close".
	const template =
		natives.find((el) => HOTKEY_RE.test(el.textContent ?? '')) ?? natives.find((el) => !/^(close|zamknij)\b/i.test(el.textContent?.trim() ?? '')) ?? natives[0];

	let el: HTMLElement;
	if (!template) {
		el = createDiv({ cls: 'empty-state-action tappable' });
		el.setText(hotkey ? `${label} (${hotkey})` : label);
	} else {
		el = template.cloneNode(true) as HTMLElement;
		el.removeAttribute('id');
		el.removeClass('mod-close', 'mod-warning', 'is-active', 'is-selected', 'has-focus');
		for (const attr of Array.from(el.attributes)) if (attr.name.startsWith('data-') && attr.name !== 'data-icon') el.removeAttribute(attr.name);
		if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', label);

		// icon (if the native action has one)
		const svg = el.querySelector('svg');
		if (svg) {
			const holder = svg.parentElement === el ? null : svg.parentElement;
			if (holder) {
				holder.empty();
				setIcon(holder, 'terminal');
			} else {
				const span = createSpan();
				setIcon(span, 'terminal');
				const icon = span.querySelector('svg');
				if (icon) el.replaceChild(icon, svg);
			}
		}

		// text: label + hotkey, keeping the native markup (e.g. a separate hotkey span)
		const nodes = textNodes(el);
		const hotkeyNodes = nodes.filter((n) => HOTKEY_RE.test(n.textContent ?? ''));
		const labelNodes = nodes.filter((n) => !hotkeyNodes.includes(n));
		if (labelNodes.length === 0 && hotkeyNodes.length === 1) {
			// "Create new note (⌘ N)" as one text node
			const original = hotkeyNodes[0].textContent ?? '';
			const paren = /\(([^)]*)\)\s*$/.test(original);
			hotkeyNodes[0].textContent = hotkey ? (paren ? `${label} (${hotkey})` : `${label} ${hotkey}`) : label;
		} else {
			labelNodes.forEach((n, i) => (n.textContent = i === 0 ? label : ''));
			if (!labelNodes.length) el.prepend(label);
			hotkeyNodes.forEach((n, i) => {
				if (i > 0 || !hotkey) {
					n.textContent = '';
					return;
				}
				const original = n.textContent ?? '';
				n.textContent = /^\s*\(.*\)\s*$/.test(original) ? original.replace(/\(.*\)/, `(${hotkey})`) : original.replace(original.trim(), hotkey);
			});
			if (!hotkey) {
				// drop wrappers that held only the hotkey, e.g. <span class="…-hotkey"></span>
				for (const n of hotkeyNodes) {
					let p = n.parentElement;
					while (p && p !== el && !p.textContent?.trim()) {
						const up: HTMLElement | null = p.parentElement;
						p.remove();
						p = up;
					}
				}
			}
		}
	}

	el.addClass(EMPTY_ACTION_CLS);
	el.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		onClick();
	});
	el.addEventListener('keydown', (e) => {
		if ((e.key === 'Enter' || e.key === ' ') && !el.instanceOf(HTMLButtonElement)) {
			e.preventDefault();
			onClick();
		}
	});

	// Put ours before a trailing "Close" action, otherwise at the end.
	const last = natives[natives.length - 1];
	const lastIsClose = last && /^(close|zamknij)\b/i.test(last.textContent?.trim() ?? '');
	if (lastIsClose) list.insertBefore(el, last);
	else list.appendChild(el);
	return el;
}
