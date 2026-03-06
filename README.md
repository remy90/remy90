# GitHub Profile Contribution Sync

This repo holds the automation that updates the `remy90/remy90` profile README with a generated list of public repositories where `@remy90` has contributed.

## What it does

- Queries the GitHub GraphQL API for public commit, pull request, issue, and review contributions.
- Deduplicates repositories across contribution types and years.
- Rebuilds a marked section inside the profile `README.md`.
- Pushes the change back on a schedule with GitHub Actions.

## Files

- `scripts/update-profile-readme.mjs` - Fetches contribution repositories and updates a README section.
- `.github/workflows/sync-profile-readme.yml` - Scheduled workflow that checks out `remy90/remy90`, runs the script, and commits the result.

## Setup

1. Create a personal access token with `repo` access for `remy90/remy90` and normal API access.
2. Add it to this repo as the `PROFILE_SYNC_TOKEN` secret.
3. In `remy90/remy90/README.md`, add these markers where you want the generated section to appear:

```md
<!-- contributions:start -->
<!-- contributions:end -->
```

4. Run the `Sync profile contributions` workflow manually once.

## Local usage

```bash
export GITHUB_TOKEN=YOUR_TOKEN
export GITHUB_USERNAME=remy90
export PROFILE_README_PATH=/path/to/remy90/README.md
node scripts/update-profile-readme.mjs
```

## Notes

- `LOOKBACK_YEARS` defaults to `5`; raise it if you want a longer history.
- The script only includes public repositories because private repositories are not suitable for a public profile README.
- The profile README must already exist, and it must contain the contribution markers.
