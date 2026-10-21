# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.2] - 2026-10-21

### Changed
- Renamed to Terminal Tabs: the plugin ID is now `terminal-tabs` and the repository is `krzysztofkut/obsidian-terminal-tabs`. Install it again under the new ID; terminal tabs open in the old version are not restored.
- Shells get `TERM_PROGRAM=terminal-tabs`.

## [1.0.1] - 2026-10-21

### Added
- Release files are built by GitHub Actions with verifiable build attestations.
- Contributing guide.

### Changed
- The UI language comes from Obsidian's language setting API.

### Fixed
- "Open terminal" on the empty New tab page works in popout windows.

## [1.0.0] - 2026-10-21

### Added
- Terminal tabs inside Obsidian, started in the vault folder, with a real PTY.
- Shell profiles, detected automatically or added for any command.
- Clickable note paths and web links, buffer search, copy on select, run selected text.
- Terminal tabs restored after restarting Obsidian.
- Colours that follow the Obsidian theme.
- UI in 14 languages.

[Unreleased]: https://github.com/krzysztofkut/obsidian-terminal-tabs/compare/1.0.2...HEAD
[1.0.2]: https://github.com/krzysztofkut/obsidian-terminal-tabs/compare/1.0.1...1.0.2
[1.0.1]: https://github.com/krzysztofkut/obsidian-terminal-tabs/compare/1.0.0...1.0.1
[1.0.0]: https://github.com/krzysztofkut/obsidian-terminal-tabs/releases/tag/1.0.0
