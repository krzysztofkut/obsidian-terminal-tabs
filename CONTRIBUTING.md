# Contributing

Thanks for helping with Terminal Tabs!

## Issues

- **Bugs:** include your OS, Obsidian version, shell, and the steps to reproduce. A screenshot of the terminal helps a lot.
- **Ideas:** describe the problem you want solved, not only the solution.

## Translations

Each language is one file in `src/locales/`. Fix a string or add a language by copying an existing file; `npm test` checks that every translation keeps the `{placeholders}` of English.

## Code

```bash
npm install
npm run build        # typecheck + main.js + styles.css
npm test             # PTY bridge + translations
npm run test:e2e     # main.js in Electron with a mocked Obsidian API
```

Install into a test vault with `npm run install-plugin -- "/path/to/vault"`.

- Keep pull requests small and focused on one change.
- Follow the [Obsidian plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).
- New behaviour needs a test.
