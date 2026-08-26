# Security Policy

[中文](./SECURITY.zh.md)

## Reporting a vulnerability

Do not open a public issue for a credential leak, authentication bypass, arbitrary file write, path traversal, or data-loss bug. Contact the maintainers privately through the security contact configured for the repository, or use a private security advisory when GitHub provides one.

Include:

- A short description of the impact
- Reproduction steps that use synthetic paths and credentials
- The affected commit or release
- Any required configuration or provider assumptions

Do not include real API keys, passwords, media paths, private hostnames, or personal data in the report.

## Deployment safety

- Keep `.env` outside Git. Provider credentials are stored in the database by the setup wizard, not in environment variables — keep the data directory out of Git too.
- Bind only the media paths the container needs when the dashboard is exposed to other users.
- Complete the administrator setup immediately after the first start.
- Keep the SubHD and Zimuku toggles (Settings → Providers) disabled unless you have reviewed the relevant provider terms and accept the risk.
