#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_SECTION_START = "<!-- contributions:start -->";
const DEFAULT_SECTION_END = "<!-- contributions:end -->";

function getEnv(name, fallback = undefined) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function getYearRanges(lookbackYears) {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const ranges = [];

  for (let year = currentYear; year > currentYear - lookbackYears; year -= 1) {
    ranges.push({
      year,
      from: new Date(Date.UTC(year, 0, 1, 0, 0, 0)).toISOString(),
      to: new Date(Date.UTC(year, 11, 31, 23, 59, 59)).toISOString(),
    });
  }

  return ranges;
}

async function graphqlRequest(query, variables, token) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "user-agent": "gh-profile-sync-script",
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();

  if (!response.ok || payload.errors) {
    const details = payload.errors
      ? payload.errors.map((error) => error.message).join("; ")
      : `HTTP ${response.status}`;

    throw new Error(`GitHub GraphQL request failed: ${details}`);
  }

  return payload.data;
}

function upsertRepo(repoMap, repository, typeKey, count) {
  if (!repository?.isPublic) {
    return;
  }

  const fullName = repository.nameWithOwner;
  const existing = repoMap.get(fullName) ?? {
    nameWithOwner: fullName,
    url: repository.url,
    description: repository.description,
    stars: repository.stargazerCount,
    total: 0,
    types: {
      commits: 0,
      pullRequests: 0,
      issues: 0,
      reviews: 0,
    },
  };

  existing.description = repository.description;
  existing.stars = repository.stargazerCount;
  existing.total += count;
  existing.types[typeKey] += count;

  repoMap.set(fullName, existing);
}

function collectContributions(repoMap, collection) {
  for (const entry of collection.commitContributionsByRepository ?? []) {
    upsertRepo(repoMap, entry.repository, "commits", entry.contributions.totalCount);
  }

  for (const entry of collection.pullRequestContributionsByRepository ?? []) {
    upsertRepo(repoMap, entry.repository, "pullRequests", entry.contributions.totalCount);
  }

  for (const entry of collection.issueContributionsByRepository ?? []) {
    upsertRepo(repoMap, entry.repository, "issues", entry.contributions.totalCount);
  }

  for (const entry of collection.pullRequestReviewContributionsByRepository ?? []) {
    upsertRepo(repoMap, entry.repository, "reviews", entry.contributions.totalCount);
  }
}

function buildSection(username, repos, lookbackYears) {
  const lines = [
    "## Open Source Contributions",
    "",
    `Public repositories with tracked GitHub contributions for @${username} in the last ${lookbackYears} year${lookbackYears === 1 ? "" : "s"}.`,
    "",
  ];

  if (repos.length === 0) {
    lines.push("- No public repository contributions found for the configured time window.");
    return lines.join("\n");
  }

  for (const repo of repos) {
    const typeSummary = [
      repo.types.commits ? `${repo.types.commits} commit${repo.types.commits === 1 ? "" : "s"}` : null,
      repo.types.pullRequests ? `${repo.types.pullRequests} PR${repo.types.pullRequests === 1 ? "" : "s"}` : null,
      repo.types.issues ? `${repo.types.issues} issue${repo.types.issues === 1 ? "" : "s"}` : null,
      repo.types.reviews ? `${repo.types.reviews} review${repo.types.reviews === 1 ? "" : "s"}` : null,
    ].filter(Boolean).join(", ");

    const description = repo.description ? ` - ${repo.description}` : "";
    const stars = repo.stars ? `, ${repo.stars} star${repo.stars === 1 ? "" : "s"}` : "";
    const recent = "";

    lines.push(`- [${repo.nameWithOwner}](${repo.url})${description}`);
    lines.push(`  - ${repo.total} contribution${repo.total === 1 ? "" : "s"}: ${typeSummary}${stars}${recent}`);
  }

  return lines.join("\n");
}

async function updateReadme({ readmePath, sectionStart, sectionEnd, sectionContent }) {
  const readme = await readFile(readmePath, "utf8");
  const startIndex = readme.indexOf(sectionStart);
  const endIndex = readme.indexOf(sectionEnd);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(
      `README markers not found in ${readmePath}. Add ${sectionStart} and ${sectionEnd} before running the sync.`
    );
  }

  const before = readme.slice(0, startIndex + sectionStart.length);
  const after = readme.slice(endIndex);
  const nextReadme = `${before}\n${sectionContent}\n${after}`;

  if (nextReadme !== readme) {
    await writeFile(readmePath, nextReadme, "utf8");
    return true;
  }

  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help === "true") {
    console.log(`Usage: node scripts/update-profile-readme.mjs [--readme README.md] [--username remy90]\n\nRequired env:\n- GITHUB_TOKEN\n\nOptional env:\n- GITHUB_USERNAME\n- LOOKBACK_YEARS\n- CONTRIBUTIONS_SECTION_START\n- CONTRIBUTIONS_SECTION_END`);
    return;
  }

  const token = getEnv("GITHUB_TOKEN");
  const username = args.username ?? getEnv("GITHUB_USERNAME", "remy90");
  const lookbackYears = Number.parseInt(args["lookback-years"] ?? getEnv("LOOKBACK_YEARS", "5"), 10);
  const readmePath = path.resolve(args.readme ?? getEnv("PROFILE_README_PATH", "README.md"));
  const sectionStart = getEnv("CONTRIBUTIONS_SECTION_START", DEFAULT_SECTION_START);
  const sectionEnd = getEnv("CONTRIBUTIONS_SECTION_END", DEFAULT_SECTION_END);

  if (!token) {
    throw new Error("Missing GITHUB_TOKEN environment variable.");
  }

  if (!Number.isInteger(lookbackYears) || lookbackYears < 1) {
    throw new Error("LOOKBACK_YEARS must be a positive integer.");
  }

  const query = `
    query ContributionRepos($username: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $username) {
        contributionsCollection(from: $from, to: $to) {
          commitContributionsByRepository(maxRepositories: 100) {
            repository {
              nameWithOwner
              url
              description
              isPublic
              stargazerCount
            }
            contributions(first: 1) {
              totalCount
            }
          }
          issueContributionsByRepository(maxRepositories: 100) {
            repository {
              nameWithOwner
              url
              description
              isPublic
              stargazerCount
            }
            contributions(first: 1) {
              totalCount
            }
          }
          pullRequestContributionsByRepository(maxRepositories: 100) {
            repository {
              nameWithOwner
              url
              description
              isPublic
              stargazerCount
            }
            contributions(first: 1) {
              totalCount
            }
          }
          pullRequestReviewContributionsByRepository(maxRepositories: 100) {
            repository {
              nameWithOwner
              url
              description
              isPublic
              stargazerCount
            }
            contributions(first: 1) {
              totalCount
            }
          }
        }
      }
    }
  `;

  const repoMap = new Map();
  const yearRanges = getYearRanges(lookbackYears);

  for (const range of yearRanges) {
    const data = await graphqlRequest(query, { username, from: range.from, to: range.to }, token);

    if (!data.user) {
      throw new Error(`GitHub user not found: ${username}`);
    }

    collectContributions(repoMap, data.user.contributionsCollection);
  }

  const repos = [...repoMap.values()].sort((left, right) => {
    if (right.total !== left.total) {
      return right.total - left.total;
    }

    return left.nameWithOwner.localeCompare(right.nameWithOwner);
  });

  const sectionContent = buildSection(username, repos, lookbackYears);
  const changed = await updateReadme({
    readmePath,
    sectionStart,
    sectionEnd,
    sectionContent,
  });

  console.log(
    changed
      ? `Updated ${readmePath} with ${repos.length} contributed repositories.`
      : `No README changes needed. ${repos.length} contributed repositories already in sync.`
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
