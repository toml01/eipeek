# Changelog

## Unreleased

### Added

- Manual, signature-verified database updates from a fixed GitHub Contents API
  endpoint, with atomic local activation and a permanent bundled fallback.
- Database status, check, and restore controls in the shared popup/options UI.
- On-by-default daily database checks using a randomized `chrome.alarms`
  schedule, a small fixed GitHub version hint, and the existing signed
  activation path, with an opt-out toggle and visible schedule/result status.

### Fixed

- Kept bundled database lookups working when older Chrome storage access-level
  calls reject, while disabling persistent database actions safely.
- Preserved rollback protection across transient startup storage-read failures.

## 0.2.1 - 2026-08-23

### Changed

- Updated dataset.

## 0.2.0 - 2026-08-17

### Added

- GitHub issue feedback link.
- Subtle “Mistake?” feedback links in proposal tooltips.
- Activated and formally scheduled mainnet upgrade membership in proposal
  tooltip headers, linked to canonical hardfork Meta EIPs.

### Changed

- Updated dataset.

### Fixed

- Removed extension-page preload warnings.
- Preserved proposal aliases after their source pull requests merge.
