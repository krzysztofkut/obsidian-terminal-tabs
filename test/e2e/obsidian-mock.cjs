// Minimal runtime stand-in for the `obsidian` module, enough to drive the real plugin bundle.
const fs = require('fs');
const path = require('path');

// ---- Obsidian's DOM helpers
function applyOpts(el, o) {
  if (!o) return el;
  if (typeof o === 'string') { el.className = o; return el; }
  if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(' ') : o.cls;
  if (o.text !== undefined) el.textContent = o.text;
  if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, String(v));
  for (const k of ['type', 'value', 'placeholder', 'href', 'title']) if (o[k] !== undefined) el[k] = o[k];
  return el;
}
const P = HTMLElement.prototype;
P.createEl = function (tag, o, cb) { const el = applyOpts(this.ownerDocument.createElement(tag), o); this.appendChild(el); cb && cb(el); return el; };
P.createDiv = function (o, cb) { return this.createEl('div', o, cb); };
P.createSpan = function (o, cb) { return this.createEl('span', o, cb); };
P.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
P.addClass = function (...c) { this.classList.add(...c); };
P.removeClass = function (...c) { this.classList.remove(...c); };
P.toggleClass = function (c, v) { this.classList.toggle(c, v); };
P.hasClass = function (c) { return this.classList.contains(c); };
P.show = function () { this.style.display = ''; };
P.hide = function () { this.style.display = 'none'; };
P.isShown = function () { return !!this.offsetParent; };
P.setText = function (t) { this.textContent = t; };
P.find = function (s) { return this.querySelector(s); };
P.findAll = function (s) { return Array.from(this.querySelectorAll(s)); };
Object.defineProperty(Node.prototype, 'doc', { get() { return this.ownerDocument || document; } });
Object.defineProperty(Node.prototype, 'win', { get() { return (this.ownerDocument || document).defaultView; } });
window.createEl = (tag, o, cb) => { const el = applyOpts(document.createElement(tag), o); cb && cb(el); return el; };
window.createDiv = (o, cb) => window.createEl('div', o, cb);

const ICONS = {
  plus: '<path d="M5 12h14M12 5v14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  'file-plus': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M12 12v6M9 15h6"/>',
  files: '<path d="M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8Z"/><path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8"/>',
  'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
};
function setIcon(el, name) {
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-icon="${name}">${ICONS[name] || '<circle cx="12" cy="12" r="4"/>'}</svg>`;
}

// ---- menus & scopes record what happened so the test can inspect it
const log = (window.__obsidianLog = { menus: [], scopes: [] });
class MenuItem {
  constructor() { this.title = ''; this.disabled = false; this.cb = null; }
  setTitle(t) { this.title = t; return this; } setIcon() { return this; } setSection() { return this; }
  setChecked(c) { this.checked = c; return this; } setDisabled(d) { this.disabled = d; return this; }
  onClick(cb) { this.cb = cb; return this; }
}
class Menu {
  constructor() { this.items = []; }
  addItem(fn) { const i = new MenuItem(); fn(i); this.items.push(i); return this; }
  addSeparator() { this.items.push('---'); return this; }
  showAtMouseEvent() { log.menus.push(this); } showAtPosition() { log.menus.push(this); }
}
class Scope { constructor(parent) { this.parent = parent; this.keys = []; } register(m, k, f) { this.keys.push([m, k, f]); return {}; } unregister() {} }

class TAbstractFile { constructor(p) { this.path = p; this.name = path.basename(p); } }
class TFile extends TAbstractFile {}
class TFolder extends TAbstractFile {}
class FileSystemAdapter { constructor(b) { this.base = b; } getBasePath() { return this.base; } }
const normalizePath = (p) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
class Notice { constructor(m) { console.log('Notice:', m); } }
class Events { on() { return {}; } }

class Component { registerEvent() {} registerDomEvent(el, ev, cb) { el.addEventListener(ev, cb); } register() {} }
class View extends Component {
  constructor(leaf) { super(); this.leaf = leaf; this.app = leaf.app;
    this.containerEl = document.createElement('div'); this.containerEl.className = 'workspace-leaf-content';
    this.contentEl = this.containerEl.createDiv('view-content'); }
  async setState() {} getState() { return {}; } onResize() {} onPaneMenu() {}
}
class ItemView extends View {}
class MarkdownView extends View {}
class Plugin extends Component {
  constructor(app, manifest) { super(); this.app = app; this.manifest = manifest; this.commands = []; }
  async loadData() { return null; } async saveData(d) { this.saved = d; }
  registerView(type, fn) { this.app.viewRegistry[type] = fn; }
  addSettingTab(t) { this.settingTab = t; } addRibbonIcon() {} addCommand(c) { this.commands.push(c); return c; }
}
class Modal {
  constructor(app) { this.app = app; this.modalEl = document.createElement('div'); this.titleEl = this.modalEl.createDiv(); this.contentEl = this.modalEl.createDiv(); }
  open() { log.modals = (log.modals || []).concat(this); this.onOpen && this.onOpen(); } close() { this.onClose && this.onClose(); }
}
class FuzzySuggestModal extends Modal { setPlaceholder() {} }
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = document.createElement('div'); } }
class Setting {
  constructor(el) { this.settingEl = el.createDiv('setting-item'); this.descEl = this.settingEl.createDiv(); }
  setName() { return this; } setDesc() { return this; } setHeading() { return this; } setClass() { return this; }
  addText(cb) { cb(chain()); return this; } addTextArea(cb) { cb(chain()); return this; } addDropdown(cb) { cb(chain()); return this; }
  addToggle(cb) { cb(chain()); return this; } addSlider(cb) { cb(chain()); return this; } addButton(cb) { cb(chain()); return this; } addExtraButton(cb) { cb(chain()); return this; }
}
function chain() { const inputEl = document.createElement('input'); const p = new Proxy({ inputEl }, { get: (t, k) => (k in t ? t[k] : () => p) }); return p; }

const Platform = { isMacOS: process.platform === 'darwin', isWin: process.platform === 'win32', isDesktop: true };

module.exports = { setIcon, Menu, MenuItem, Scope, TAbstractFile, TFile, TFolder, FileSystemAdapter, normalizePath, Notice, Events,
  Component, View, ItemView, MarkdownView, Plugin, PluginSettingTab, Setting, Platform, Modal, FuzzySuggestModal };
