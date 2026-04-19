# Security Policy

## Supported Versions

The ChildClimate Risk Atlas is currently in an early prototype stage. Only
the `main` branch receives security updates.

| Version | Supported          |
| ------- | ------------------ |
| `main`  | :white_check_mark: |
| < 0.1   | :x:                |

## Reporting a Vulnerability

If you believe you have found a security vulnerability in this project,
**please do not open a public issue**. Responsible disclosure keeps users
safer while we ship a fix.

Instead, email: **security@trameter.org**

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce, ideally with a minimal proof of concept
- Any relevant logs, screenshots, or references
- Your name and affiliation (if you wish to be credited)

We aim to:

1. Acknowledge receipt within **72 hours**
2. Provide an initial assessment within **7 days**
3. Release a fix or mitigation within **30 days** for high-severity issues

Because this project ingests only **public open data** (OpenStreetMap,
Open-Meteo, Copernicus) and produces public outputs, the most likely
security concerns are:

- Dependency vulnerabilities in the Python pipeline or web frontend
- Data-processing bugs that could mislead public-health decision makers
- Exposure of any credentials if a future contributor accidentally commits
  them (none are required for the base pipeline)

Reports of documentation issues, licence questions, or general bugs should
go through the regular GitHub issue tracker instead.
