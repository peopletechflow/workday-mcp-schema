# Security policy

## Status

This project is experimental and has not been security-reviewed by a third party. It has not run against a production Workday tenant. Do not use it with real employee data until you have done your own review. Live Workday behaviour depends on your tenant's configuration, and that configuration is not verified by this repository's tests.

## Reporting a vulnerability

Report it privately. Do not open a public issue.

1. Use GitHub private vulnerability reporting: go to the repository's **Security** tab and choose **Report a vulnerability**.
2. If that button is not shown, open a public issue titled "Security contact request" with no details, and a maintainer will set up a private channel.

Include affected versions or commits, steps to reproduce, and impact. Please give us reasonable time to fix the issue before you disclose it. There is no bug bounty.

## Supported versions

Only the latest commit on `main`.

## Scope notes

- Never include real tenant names, tokens, worker data, or exported Workday material in reports, issues, or pull requests.
- Fixture data is invented. Report anything that looks like real personal data in this repository as a security issue.
