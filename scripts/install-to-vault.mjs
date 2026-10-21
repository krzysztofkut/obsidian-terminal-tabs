// Copies the built plugin into a vault:  npm run install-plugin -- "/path/to/vault"
// (or set OBSIDIAN_VAULT). Then enable "Terminal Tabs" in Settings → Community plugins.
import fs from 'node:fs';
import path from 'node:path';

const vault = process.argv[2] || process.env.OBSIDIAN_VAULT;
if (!vault) {
  console.error('Usage: npm run install-plugin -- "/path/to/your/vault"');
  process.exit(1);
}
if (!fs.existsSync(path.join(vault, '.obsidian'))) {
  console.error(`Not an Obsidian vault (no .obsidian folder): ${vault}`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const dest = path.join(vault, '.obsidian', 'plugins', manifest.id);
fs.mkdirSync(dest, { recursive: true });
for (const f of ['main.js', 'manifest.json', 'styles.css']) {
  if (!fs.existsSync(f)) {
    console.error(`${f} missing - run "npm run build" first`);
    process.exit(1);
  }
  fs.copyFileSync(f, path.join(dest, f));
}
// Hot Reload plugin (pjeby/hot-reload) picks up changes automatically when this file exists
fs.writeFileSync(path.join(dest, '.hotreload'), '');
console.log(`Installed ${manifest.name} ${manifest.version} → ${dest}`);
