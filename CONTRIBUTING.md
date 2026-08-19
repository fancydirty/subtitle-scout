# Contributing

subtitle-scout is maintained as a self-hosted tool. Start with an issue before opening a pull request so the scope and compatibility impact are clear.

Useful contributions include:

- Documentation and `doctor` improvements
- Provider adapters with documented terms and quota behavior
- Small, reproducible tests using the repository's mock media library
- Bug fixes with a regression test

Please keep the conservative behavior intact: when identity or subtitle quality is uncertain, the system should stop rather than install an unverified file. Changes to agent skills, provider behavior, database migrations, or write paths need an issue and focused tests first.

Run the local checks before submitting a pull request:

```bash
npm run check
npm test -- --run
npm run build
git diff --check
```

Live model, subtitle-provider, and real-library tests require private credentials and are not part of the default test suite. Do not add credentials, private media, or local deployment records to the repository.
