# Contributing

Bug reports and small fixes are welcome.

Before you open an issue, look at the open ones and at the Limits section of the README. A useful report has the version, the smallest way to reproduce the problem, and what you expected instead.

For anything bigger than a small fix, open an issue first so we can agree on the shape before you write it.

Pull requests:

- One change per pull request.
- Add a test that fails before the change and passes after it.
- `npm test` and `npm run types` must pass against a real PostgreSQL (see Development in the README).
- A change to `src/index.js` keeps `npm run mutate` green. A new guard gets a new mutant in `scripts/mutate.js`.
- Follow the style of the code around your change.

Issues are read in batches, usually within a week. A single reminder after two weeks is fine.

Contributions are released under the repository's MIT license.
