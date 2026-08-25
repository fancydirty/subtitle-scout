# Contributing to Subtitle Scout

[中文](./CONTRIBUTING.md)

Thank you for considering a contribution.

## Code of conduct

Be respectful, specific, and professional.

## How to contribute

### Reporting bugs

Before opening an issue:

- Search existing [issues](https://github.com/fancydirty/subtitle-scout/issues)
- Confirm the behavior is a defect, not a missing credential or misconfigured root

Include:

- OS and version
- `docker --version` if relevant
- Reproduction steps
- Logs or a stack trace
- Expected vs actual behavior

Do not paste real API keys, media paths, or hostnames.

### Suggesting features

Open an issue first. State the use case: who needs it, and what fails today. Prefer changes that improve the core find / translate / install loop over one-off site-specific hacks.

### Pull requests

1. Fork and clone.
2. Branch from current `main`.
3. Match existing TypeScript style (`strict`).
4. Add tests for the behavior you change. Do not lock in the wrong UI or daemon contract.
5. Run `npm test` and `npm test --prefix web` for the packages you touch.
6. Use conventional commits (`feat:`, `fix:`, `docs:`).
7. In the PR body: what changed, why, how you tested. Link issues with `Closes #n`.

## Layout

```
subtitle-scout/
├── src/          # daemon, adapters, CLI, dashboard API
├── web/          # dashboard
├── docs/         # public guides (credentials, architecture notes)
└── CONTRIBUTING.md
```

## Documentation

- New user-facing behavior: update `README.md` (English and Chinese sections) and, if it is a credential flow, both `docs/GET_CREDENTIALS.md` and `docs/GET_CREDENTIALS.en.md`.
- New settings keys: document them next to the existing secrets table.

## License

Contributions are licensed under **GPL v3.0**.
