const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ipcRenderer } = require('electron');

const mockPath = path.join(__dirname, 'obsidian-mock.cjs');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'obsidian') return mockPath;
  return origResolve.call(this, req, ...rest);
};
const ob = require('obsidian');

// ---- test vault
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-vault-'));
fs.mkdirSync(path.join(vault, 'notes'));
fs.writeFileSync(path.join(vault, 'notes', 'Daily note.md'), '# hi');
fs.writeFileSync(path.join(vault, 'notes', 'ideas.md'), '# ideas');
fs.writeFileSync(path.join(vault, 'README.md'), '# readme');

// ---- a small imitation of Obsidian's workspace: tab groups with tab headers
const appRoot = document.getElementById('app');
const rootSplit = { name: 'root' }, rightSplit = { name: 'right', collapse() {} }, leftSplit = { name: 'left', collapse() {} };
const opened = [];
const commandsRun = [];
let activeLeaf = null;

class TabGroup {
  constructor(cls) {
    this.children = [];
    this.el = appRoot.createDiv('workspace-tabs ' + cls);
    this.headerEl = this.el.createDiv('workspace-tab-header-container');
    this.newBtn = this.headerEl.createDiv({ cls: 'workspace-tab-header-new', text: '+' });
    this.contentEl = this.el.createDiv('workspace-tab-container');
    this.newBtn.addEventListener('click', () => { const l = new Leaf(app, this); l.setEmpty(); app.workspace.setActiveLeaf(l); });
  }
  insert(leaf, idx = this.children.length) {
    this.children.splice(idx, 0, leaf);
    this.headerEl.insertBefore(leaf.tabHeaderEl, this.headerEl.children[idx] || this.newBtn);
    this.contentEl.appendChild(leaf.containerEl);
  }
  activate(leaf) {
    for (const l of this.children) { const on = l === leaf; l.tabHeaderEl.toggleClass('is-active', on); l.containerEl.style.display = on ? '' : 'none'; }
  }
  remove(leaf) {
    const i = this.children.indexOf(leaf);
    this.children.splice(i, 1);
    leaf.tabHeaderEl.remove(); leaf.containerEl.remove();
    if (!this.children.length && this !== editorGroup) this.el.remove();
    else this.activate(this.children[Math.min(i, this.children.length - 1)]);
  }
}
class Leaf {
  constructor(app, group, idx) {
    this.app = app; this.parent = group;
    this.tabHeaderEl = createDiv('workspace-tab-header');
    const icon = this.tabHeaderEl.createDiv('workspace-tab-header-inner-icon');
    ob.setIcon(icon, 'file-text');
    this.tabHeaderInnerTitleEl = this.tabHeaderEl.createDiv('workspace-tab-header-inner-title');
    this.tabHeaderEl.addEventListener('click', () => app.workspace.setActiveLeaf(this));
    this.containerEl = createDiv('workspace-leaf');
    this.view = { getViewType: () => 'empty', containerEl: this.containerEl };
    group.insert(this, idx);
    leaves.push(this);
  }
  setEmpty(variant = emptyVariant) {
    const content = this.containerEl.createDiv('workspace-leaf-content');
    content.setAttribute('data-type', 'empty');
    const list = content.createDiv('empty-state-action-list');
    const actions = [['Create new note', '⌘ N', 'file-plus'], ['Go to file', '⌘ O', 'files'], ['Close', null, 'x']];
    for (const [label, hk, icon] of actions) {
      if (variant === 'text') {
        list.createDiv({ cls: 'empty-state-action tappable' + (hk ? '' : ' mod-close'), text: hk ? `${label} (${hk})` : label });
      } else {
        // a newer/other look: real buttons with an icon and a separate hotkey badge
        const btn = list.createEl('button', { cls: 'empty-state-action mod-button' + (hk ? '' : ' mod-close'), attr: { 'aria-label': label, 'data-action': label } });
        ob.setIcon(btn.createSpan('empty-state-action-icon'), icon);
        btn.createSpan({ cls: 'empty-state-action-label', text: label });
        if (hk) btn.createSpan({ cls: 'empty-state-action-hotkey', text: hk });
      }
    }
    this.view = { getViewType: () => 'empty', containerEl: content };
    this.tabHeaderInnerTitleEl.setText('New tab');
    setTimeout(() => app.workspace.trigger('layout-change'), 0);
  }
  setMarkdown(title) {
    const content = this.containerEl.createDiv('workspace-leaf-content');
    content.createDiv({ cls: 'editor-mock' }).innerHTML = `<h1>${title}</h1>Meeting notes, ideas and todos…<br>- [ ] write the plugin README`;
    this.view = { getViewType: () => 'markdown', containerEl: content };
    this.tabHeaderInnerTitleEl.setText(title);
  }
  getRoot() { return rootSplit; }
  async setViewState({ type, state }) {
    this.view.onClose?.();
    this.containerEl.empty();
    const view = this.app.viewRegistry[type](this);
    this.view = view;
    this.containerEl.appendChild(view.containerEl);
    view.containerEl.setAttribute('data-type', type);
    ob.setIcon(this.tabHeaderEl.querySelector('.workspace-tab-header-inner-icon'), view.getIcon());
    app.workspace.setActiveLeaf(this);
    await view.onOpen();
    await view.setState(state || {}, {});
    this.updateHeader();
  }
  updateHeader() { if (this.view.getDisplayText) this.tabHeaderInnerTitleEl.setText(this.view.getDisplayText()); }
  async openFile(f) { opened.push(f.path); }
  detach() {
    const i = leaves.indexOf(this); if (i >= 0) leaves.splice(i, 1);
    this.view.onClose?.(); this.parent.remove(this);
    if (activeLeaf === this) activeLeaf = this.parent.children[0] || editorLeaf;
  }
}
const leaves = [];
const handlers = {};
let emptyVariant = 'text';
const app = {
  viewRegistry: {},
  commands: { executeCommandById: (id) => { commandsRun.push(id); return true; } },
  keymap: { pushScope: (s) => window.__obsidianLog.scopes.push(['push', s]), popScope: (s) => window.__obsidianLog.scopes.push(['pop', s]) },
  vault: {
    adapter: new ob.FileSystemAdapter(vault),
    configDir: '.obsidian',
    getAbstractFileByPath(p) {
      const abs = path.join(vault, p);
      if (!fs.existsSync(abs)) return null;
      return fs.statSync(abs).isDirectory() ? new ob.TFolder(p) : new ob.TFile(p);
    },
  },
  workspace: {
    rootSplit, rightSplit, leftSplit,
    on: (name, cb) => { (handlers[name] = handlers[name] || []).push(cb); return {}; },
    trigger: (name, ...a) => (handlers[name] || []).forEach((cb) => cb(...a)),
    getLeavesOfType: (t) => leaves.filter((l) => l.view.getViewType() === t),
    createLeafBySplit: () => new Leaf(app, new TabGroup('mod-bottom')),
    createLeafInParent: (parent, idx) => new Leaf(app, parent, idx),
    getLeaf: () => new Leaf(app, (activeLeaf || editorLeaf).parent),
    getRightLeaf: () => new Leaf(app, new TabGroup('mod-right')),
    getMostRecentLeaf: () => editorLeaf,
    getActiveViewOfType: (cls) => (activeLeaf && activeLeaf.view instanceof cls ? activeLeaf.view : null),
    revealLeaf: async (l) => app.workspace.setActiveLeaf(l),
    setActiveLeaf: (l) => { activeLeaf = l; l.parent.activate(l); app.workspace.trigger('active-leaf-change', l); },
    getActiveFile: () => null,
    iterateAllLeaves: (fn) => [...leaves].forEach(fn),
    iterateRootLeaves: (fn) => [...leaves].forEach(fn),
    requestSaveLayout: () => { app.saves = (app.saves || 0) + 1; },
    onLayoutReady: (cb) => cb(),
  },
};
const editorGroup = new TabGroup('mod-editor');
const editorLeaf = new Leaf(app, editorGroup);
editorLeaf.setMarkdown('Projects.md');
editorGroup.activate(editorLeaf);
activeLeaf = editorLeaf;

const PluginClass = require(path.join(__dirname, '..', '..', 'main.js')).default;

// ---- tiny test runner
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 6000, what = 'condition') {
  const t0 = Date.now();
  while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(30); }
}
async function test(name, fn) {
  try { await fn(); results.push(`PASS  ${name}`); } catch (e) { results.push(`FAIL  ${name}  -> ${e.stack || e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const screenText = (s) => { const b = s.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true)); return out.join('\n'); };
const terminals = () => app.workspace.getLeavesOfType('vault-terminal-view');
const titles = (group) => group.children.map((l) => l.tabHeaderInnerTitleEl.textContent);
const mac = process.platform === 'darwin';
const key = (k, el) => el.dispatchEvent(new KeyboardEvent('keydown', mac
  ? { key: k.toLowerCase(), metaKey: true, bubbles: true, cancelable: true }
  : { key: k, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));

(async () => {
  const plugin = new PluginClass(app, { id: 'vault-terminal', dir: '.obsidian/plugins/vault-terminal', version: '0.1.0' });
  await plugin.onload();
  // Test with a plain bash so user dotfiles don't affect the output
  plugin.settings.profiles.unshift({ id: 'test-bash', name: 'bash', command: '/bin/bash', args: '--norc --noprofile -i' });
  plugin.settings.defaultProfile = 'test-bash';
  let v1, s1, bottom;

  await test('commands registered (incl. Alt+F12 toggle)', async () => {
    const ids = plugin.commands.map((c) => c.id);
    for (const id of ['toggle', 'new-tab', 'new-tab-profile', 'new-editor-tab', 'open-in-active-folder', 'close-tab', 'rename-tab', 'run-selection']) assert(ids.includes(id), 'missing ' + id);
    const tog = plugin.commands.find((c) => c.id === 'toggle');
    assert(tog.hotkeys[0].key === 'F12' && tog.hotkeys[0].modifiers[0] === 'Alt');
  });

  await test('Alt+F12 opens ONE Obsidian tab titled "Local" in a bottom group, shell in vault root', async () => {
    await plugin.toggleTerminal();
    assert(terminals().length === 1, 'terminals=' + terminals().length);
    v1 = terminals()[0].view; s1 = v1.session; bottom = terminals()[0].parent;
    assert(bottom !== editorGroup, 'not in a separate (bottom) group');
    assert(titles(bottom).join('|') === 'Local', 'tab titles: ' + titles(bottom));
    assert(!document.querySelector('.vault-terminal-tabbar'), 'old inner tab bar still rendered');
    await waitFor(() => s1.isRunning, 3000, 'running');
    s1.write('echo "cwd=$(pwd)"; echo "term=$TERM vault=$OBSIDIAN_VAULT"\r');
    await waitFor(() => screenText(s1).includes('cwd=' + vault), 5000, 'cwd output');
    assert(screenText(s1).includes('term=xterm-256color vault=' + vault));
  });

  await test('pty size follows the view (stty size == xterm cols/rows)', async () => {
    s1.write('clear; stty size\r');
    const want = `${s1.term.rows} ${s1.term.cols}`;
    await waitFor(() => screenText(s1).includes(want), 4000, 'stty ' + want);
    await ipcRenderer.invoke('resize', 900, 560);
    await sleep(500);
    const want2 = `${s1.term.rows} ${s1.term.cols}`;
    assert(want2 !== want, 'did not resize');
    s1.write('stty size\r');
    await waitFor(() => screenText(s1).includes(want2), 4000, 'stty after resize ' + want2);
    await ipcRenderer.invoke('resize', 1100, 640);
    await sleep(400);
  });

  await test('"New terminal tab" adds "Local (2)" as a tab in the SAME group; first keeps running', async () => {
    const v2 = await plugin.newTerminal();
    assert(v2.leaf.parent === bottom, 'opened in another group');
    assert(titles(bottom).join('|') === 'Local|Local (2)', titles(bottom).join('|'));
    await waitFor(() => v2.session.isRunning, 3000, 's2 running');
    assert(s1.isRunning, 's1 died');
  });

  await test('Cmd+T / Ctrl+Shift+T inside the terminal opens a tab next to it, Cmd+W / Ctrl+Shift+W closes it', async () => {
    app.workspace.setActiveLeaf(v1.leaf);
    key('T', s1.term.textarea);
    await waitFor(() => titles(bottom).length === 3 && bottom.children[1].view.session, 2000, 'new tab next to it: ' + titles(bottom));
    assert(titles(bottom).join('|') === 'Local|Local (3)|Local (2)', titles(bottom).join('|'));
    const v3 = bottom.children[1].view;
    await waitFor(() => v3.session.isRunning, 3000);
    key('W', v3.session.term.textarea);
    assert(titles(bottom).length === 2, 'not closed: ' + titles(bottom));
  });

  await test('Ctrl+Tab uses Obsidian\'s own tab switching', async () => {
    commandsRun.length = 0;
    s1.term.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true }));
    assert(commandsRun[0] === 'workspace:next-tab', JSON.stringify(commandsRun));
  });

  await test('double click on the Obsidian tab renames it inline', async () => {
    const leaf2 = bottom.children[1];
    leaf2.tabHeaderEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const input = leaf2.tabHeaderEl.querySelector('input.vault-terminal-tab-rename');
    assert(input, 'no rename input in tab header');
    input.value = 'git';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert(titles(bottom).join('|') === 'Local|git', titles(bottom).join('|'));
    assert(leaf2.view.getState().customName === true && leaf2.view.getDisplayText() === 'git');
  });

  await test('tab right-click menu has Rename / Duplicate / Restart / Clear / New terminal tab', async () => {
    const menu = new ob.Menu();
    v1.onPaneMenu(menu, 'tab-header');
    const t = menu.items.map((i) => i.title);
    for (const want of ['Rename tab', 'Duplicate tab', 'Restart', 'Clear buffer', 'New terminal tab']) assert(t.includes(want), t.join(','));
  });

  await test('cd is tracked (duplicate/restore use the real cwd)', async () => {
    s1.write('cd notes\r');
    await sleep(300);
    const cwd = await s1.refreshCwd();
    assert(cwd === path.join(vault, 'notes'), 'cwd=' + cwd);
    assert(v1.getState().cwd === cwd, 'state cwd');
  });

  await test('vault file paths printed by ls become links (relative to shell cwd)', async () => {
    s1.write('clear; ls -1; echo "see ../README.md:12 and notes/missing.md"\r');
    await waitFor(() => screenText(s1).includes('ideas.md') && screenText(s1).includes('see ../README.md'), 4000, 'ls');
    const b = s1.term.buffer.active;
    let lineIdx = -1, linkLine = -1;
    for (let i = 0; i < b.length; i++) {
      const t = b.getLine(i).translateToString(true);
      if (t.trim() === 'ideas.md') lineIdx = i + 1;
      if (t.startsWith('see ')) linkLine = i + 1;
    }
    const links = await s1.provideVaultLinks(lineIdx);
    assert(links && links[0].text === 'ideas.md', 'no link for ideas.md');
    const l2 = await s1.provideVaultLinks(linkLine);
    assert(l2 && l2.length === 1 && l2[0].text === '../README.md', 'README link: ' + JSON.stringify(l2 && l2.map((l) => l.text)));
    const before = titles(bottom).length;
    l2[0].activate(new MouseEvent('click', { ctrlKey: true }), l2[0].text);
    assert(opened.includes('README.md'), 'not opened: ' + opened);
    assert(titles(bottom).length === before, 'note opened in the terminal group');
  });

  await test('focus pushes a blocking scope (Obsidian hotkeys off), blur pops it', async () => {
    s1.term.textarea.dispatchEvent(new FocusEvent('blur'));
    window.__obsidianLog.scopes.length = 0;
    s1.term.textarea.dispatchEvent(new FocusEvent('focus'));
    s1.term.textarea.dispatchEvent(new FocusEvent('blur'));
    const ops = window.__obsidianLog.scopes.map((x) => x[0]).join(',');
    assert(ops === 'push,pop', ops);
    assert(!window.__obsidianLog.scopes[0][1].parent, 'scope has parent');
  });

  await test('`exit 3` keeps the tab with a restart hint; Enter restarts; `exit` closes the tab', async () => {
    const leaf = bottom.children[1];
    const s = leaf.view.session;
    s.write('exit 3\r');
    await waitFor(() => !s.isRunning, 4000, 'exit');
    assert(leaf.view.session === s && terminals().includes(leaf), 'tab closed on exit 3');
    assert(/exited with code 3/.test(screenText(s)), 'no exit message');
    assert(leaf.tabHeaderEl.classList.contains('vault-terminal-exited'), 'tab not marked as exited');
    s.term.input('\r'); // Enter restarts
    await waitFor(() => s.isRunning, 3000, 'restart');
    s.write('exit\r');
    await waitFor(() => !terminals().includes(leaf), 4000, 'closed on exit 0');
    assert(titles(bottom).join('|') === 'Local', titles(bottom).join('|'));
  });

  await test('empty "New tab" (the + button) offers "Open terminal" and turns into a terminal in place', async () => {
    bottom.newBtn.click();
    await sleep(20);
    const emptyLeaf = bottom.children[bottom.children.length - 1];
    const action = emptyLeaf.containerEl.querySelector('.vault-terminal-empty-action');
    assert(action, 'no "Open terminal" action');
    assert(/Open terminal/.test(action.textContent), action.textContent);
    action.click();
    await waitFor(() => emptyLeaf.view.session && emptyLeaf.view.session.isRunning, 3000, 'terminal in empty tab');
    assert(bottom.children.includes(emptyLeaf) && titles(bottom).length === 2, titles(bottom));
    assert(titles(bottom)[1] === 'Local (2)', titles(bottom).join('|'));
  });

  await test('"Open terminal" items are clones of the native actions (text-link look)', async () => {
    bottom.newBtn.click();
    await sleep(20);
    const leaf = bottom.children[bottom.children.length - 1];
    const items = Array.from(leaf.containerEl.querySelectorAll('.empty-state-action-list > *'));
    const texts = items.map((e) => e.textContent);
    const hk = mac ? '⌥ F12' : 'Alt + F12';
    assert(texts.join('|') === `Create new note (⌘ N)|Go to file (⌘ O)|Open terminal (${hk})|Open terminal: bash|Close`, texts.join('|'));
    const ours = items[2], native = items[0];
    assert(ours.tagName === native.tagName, 'tag ' + ours.tagName);
    assert(ours.className === native.className + ' vault-terminal-empty-action', ours.className + ' vs ' + native.className);
    leaf.detach();
  });

  await test('"Open terminal" items are clones of the native actions (button + icon + hotkey badge look)', async () => {
    emptyVariant = 'button';
    bottom.newBtn.click();
    await sleep(20);
    const leaf = bottom.children[bottom.children.length - 1];
    const list = leaf.containerEl.querySelector('.empty-state-action-list');
    const items = Array.from(list.children);
    const hk = mac ? '⌥ F12' : 'Alt + F12';
    const ours = items[2], profile = items[3], native = items[0];
    assert(items[4].textContent === 'Close', 'Close not last: ' + items.map((e) => e.textContent).join('|'));
    assert(ours.tagName === 'BUTTON' && profile.tagName === 'BUTTON', 'not buttons');
    assert(ours.className === native.className + ' vault-terminal-empty-action', ours.className);
    assert(ours.querySelector('.empty-state-action-label').textContent === 'Open terminal', 'label');
    assert(ours.querySelector('.empty-state-action-hotkey').textContent === hk, 'hotkey ' + ours.querySelector('.empty-state-action-hotkey').textContent);
    assert(ours.querySelector('.empty-state-action-icon svg').getAttribute('data-icon') === 'terminal', 'icon');
    assert(!ours.hasAttribute('data-action') && ours.getAttribute('aria-label') === 'Open terminal', 'attrs');
    assert(profile.querySelector('.empty-state-action-label').textContent === 'Open terminal: bash', 'profile label');
    assert(!profile.querySelector('.empty-state-action-hotkey'), 'profile should have no hotkey badge');
    ours.click();
    await waitFor(() => leaf.view.session && leaf.view.session.isRunning, 3000, 'terminal from button');
    leaf.view.closeSession();
  });

  await test('"Open terminal as editor tab" puts it next to the note, not at the bottom', async () => {
    const v = await plugin.newTerminal({ location: 'tab' });
    assert(v.leaf.parent === editorGroup, 'not in editor group');
    v.closeSession();
  });

  await test('find bar finds text', async () => {
    app.workspace.setActiveLeaf(v1.leaf);
    s1.openFind();
    const input = s1.el.querySelector('.vault-terminal-find input');
    input.value = 'ideas';
    input.dispatchEvent(new Event('input'));
    assert(s1.term.getSelection() === 'ideas', 'sel=' + s1.term.getSelection());
    s1.closeFind();
  });

  // ---- screenshot of a realistic layout: three terminal tabs at the bottom
  const vDev = await plugin.newTerminal(); vDev.setName('npm run dev');
  const vGit = await plugin.newTerminal(); vGit.setName('git');
  // remove the "Local (2)" made from the empty tab so the screenshot is tidy
  bottom.children.find((l) => l.view.session && l.view.session.name === 'Local (2)').view.closeSession();
  app.workspace.setActiveLeaf(v1.leaf);
  s1.write('clear; cd ..; printf "\\033[1;32m➜\\033[0m  \\033[36mvault\\033[0m git:(\\033[31mmain\\033[0m) ls -la\\n"; ls -la; printf "\\n\\033[33mzażółć gęślą jaźń\\033[0m  \\033[34mblue\\033[0m \\033[35mmagenta\\033[0m \\033[1mbold\\033[0m\\n"\r');
  await sleep(900);
  await ipcRenderer.invoke('shot', path.join(__dirname, 'shot-tabs.png'));
  emptyVariant = 'text';
  bottom.newBtn.click();
  await sleep(100);
  await ipcRenderer.invoke('shot', path.join(__dirname, 'shot-new-tab.png'));
  bottom.children[bottom.children.length - 1].detach();
  emptyVariant = 'button';
  bottom.newBtn.click();
  await sleep(100);
  await ipcRenderer.invoke('shot', path.join(__dirname, 'shot-new-tab-buttons.png'));

  await test('closing every terminal tab kills the shells', async () => {
    const pids = terminals().map((l) => l.view.session && l.view.session.pty && l.view.session.pty.pid).filter(Boolean);
    assert(pids.length >= 3, 'pids ' + pids);
    for (const l of terminals()) l.view.closeSession();
    assert(terminals().length === 0, 'leaf still open');
    await sleep(2500);
    const alive = pids.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
    assert(alive.length === 0, 'still alive: ' + alive);
  });

  console.log('\n' + results.join('\n'));
  ipcRenderer.invoke('done', results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log('HARNESS ERROR', e.stack); ipcRenderer.invoke('done', 2); });
