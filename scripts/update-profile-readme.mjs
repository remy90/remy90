#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_SECTION_START = "<!-- contributions:start -->";
const DEFAULT_SECTION_END = "<!-- contributions:end -->";
const SEARCH_RESULTS_PER_PAGE = 100;
const SEARCH_RESULT_WINDOW_LIMIT = 900;
const MIN_SPLIT_WINDOW_DAYS = 31;

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

function toIsoDate(value) {
  return value.toISOString().slice(0, 10);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(value);
}

function truncate(value, length) {
  if (value.length <= length) {
    return value;
  }

  return `${value.slice(0, Math.max(0, length - 1)).trimEnd()}...`;
}

function formatStars(value) {
  if (!Number.isFinite(value) || value < 1) {
    return "0 stars";
  }

  return `${new Intl.NumberFormat("en").format(value)} star${value === 1 ? "" : "s"}`;
}

function parseCsvList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function splitDateRange(start, end) {
  const midpoint = new Date(
    start.getTime() + Math.floor((end.getTime() - start.getTime()) / 2),
  );
  const leftEnd = new Date(midpoint.getTime());
  const rightStart = new Date(midpoint.getTime() + 1000);

  return [
    { start: rightStart, end },
    { start, end: leftEnd },
  ];
}

function getInitialDateWindows(lookbackYears) {
  const now = new Date();
  const windows = [];

  for (let offset = 0; offset < lookbackYears; offset += 1) {
    const year = now.getUTCFullYear() - offset;
    const start = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
    const end =
      offset === 0 ? now : new Date(Date.UTC(year, 11, 31, 23, 59, 59));

    windows.push({ start, end });
  }

  return windows;
}

async function githubRequest(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "gh-profile-sync-script",
      "x-github-api-version": "2022-11-28",
    },
  });

  const payload = await response.json();

  if (!response.ok) {
    const message = payload.message || `HTTP ${response.status}`;
    throw new Error(`GitHub request failed: ${message}`);
  }

  return payload;
}

async function searchCommits({ username, start, end, page, token }) {
  const query = [
    `author:${username}`,
    `author-date:${toIsoDate(start)}..${toIsoDate(end)}`,
  ].join(" ");

  const url = new URL("https://api.github.com/search/commits");
  url.searchParams.set("q", query);
  url.searchParams.set("sort", "author-date");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(SEARCH_RESULTS_PER_PAGE));
  url.searchParams.set("page", String(page));

  return githubRequest(url, token);
}

function normalizeCommit(item, ignoredOwners) {
  if (!item?.repository || item.repository.private) {
    return null;
  }

  const repositoryName = item.repository.full_name;
  const repositoryOwner = item.repository.owner?.login?.toLowerCase();

  if (repositoryOwner && ignoredOwners.has(repositoryOwner)) {
    return null;
  }

  const authoredAt = item.commit?.author?.date || item.commit?.committer?.date;

  if (!authoredAt) {
    return null;
  }

  const title = (item.commit.message || "Untitled commit")
    .split("\n")[0]
    .trim();
  const url = item.html_url || `${item.repository.html_url}/commit/${item.sha}`;

  return {
    sha: item.sha,
    shortSha: item.sha.slice(0, 7),
    title: title || "Untitled commit",
    url,
    authoredAt,
    stars: item.repository.stargazers_count ?? 0,
    repositoryName,
    repositoryUrl: item.repository.html_url,
  };
}

async function collectWindowCommits({
  username,
  start,
  end,
  token,
  commits,
  commitUrls,
  maxCommits,
  warnings,
  ignoredOwners,
}) {
  const firstPage = await searchCommits({
    username,
    start,
    end,
    page: 1,
    token,
  });
  const windowDays = Math.ceil((end.getTime() - start.getTime()) / 86400000);

  if (firstPage.incomplete_results) {
    warnings.add(
      `GitHub reported incomplete search results for ${toIsoDate(start)}..${toIsoDate(end)}.`,
    );
  }

  if (
    firstPage.total_count > SEARCH_RESULT_WINDOW_LIMIT &&
    windowDays >= MIN_SPLIT_WINDOW_DAYS
  ) {
    const windows = splitDateRange(start, end);

    for (const window of windows) {
      await collectWindowCommits({
        username,
        start: window.start,
        end: window.end,
        token,
        commits,
        commitUrls,
        maxCommits,
        warnings,
        ignoredOwners,
      });
    }

    return firstPage.total_count;
  }

  const cappedTotal = Math.min(firstPage.total_count, 1000);

  if (firstPage.total_count > 1000) {
    warnings.add(
      `GitHub only returns the first 1000 commit results for ${toIsoDate(start)}..${toIsoDate(end)}.`,
    );
  }

  const maybeAddCommits = (items) => {
    if (commits.length >= maxCommits) {
      return;
    }

    for (const item of items) {
      if (commits.length >= maxCommits) {
        break;
      }

      const commit = normalizeCommit(item, ignoredOwners);

      if (!commit || commitUrls.has(commit.url)) {
        continue;
      }

      commitUrls.add(commit.url);
      commits.push(commit);
    }
  };

  maybeAddCommits(firstPage.items || []);

  const totalPages = Math.ceil(cappedTotal / SEARCH_RESULTS_PER_PAGE);

  for (
    let page = 2;
    page <= totalPages && commits.length < maxCommits;
    page += 1
  ) {
    const nextPage = await searchCommits({ username, start, end, page, token });
    maybeAddCommits(nextPage.items || []);
  }

  return firstPage.total_count;
}

function buildSection({
  username,
  lookbackYears,
  totalCommits,
  shownCommits,
  maxCommits,
  warnings,
}) {
  const lines = [
    "## Open Source Commits",
    "",
    `Public GitHub commits authored by @${username} in the last ${lookbackYears} year${lookbackYears === 1 ? "" : "s"}. Showing the latest ${Math.min(shownCommits.length, maxCommits)} of ${totalCommits}.`,
    "",
  ];

  if (warnings.length > 0) {
    lines.push(`_Note: ${warnings.join(" ")}_`, "");
  }

  if (shownCommits.length === 0) {
    lines.push("- No public commits found for the configured time window.");
    return lines.join("\n");
  }

  for (const commit of shownCommits) {
    lines.push(
      `- [${commit.repositoryName}](${commit.repositoryUrl}) - ${formatStars(commit.stars)} - [${truncate(commit.title, 88)}](${commit.url}) (${"`"}${commit.shortSha}${"`"})`,
    );
  }

  return lines.join("\n");
}

async function updateReadme({
  readmePath,
  sectionStart,
  sectionEnd,
  sectionContent,
}) {
  const readme = await readFile(readmePath, "utf8");
  const startIndex = readme.indexOf(sectionStart);
  const endIndex = readme.indexOf(sectionEnd);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(
      `README markers not found in ${readmePath}. Add ${sectionStart} and ${sectionEnd} before running the sync.`,
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
    console.log(
      `Usage: node scripts/update-profile-readme.mjs [--readme README.md] [--username remy90] [--ignore-owners remy90,my-org]\n\nRequired env:\n- GITHUB_TOKEN\n\nOptional env:\n- GITHUB_USERNAME\n- LOOKBACK_YEARS\n- MAX_COMMITS\n- IGNORE_REPO_OWNERS\n- CONTRIBUTIONS_SECTION_START\n- CONTRIBUTIONS_SECTION_END`,
    );
    return;
  }

  const token = getEnv("GITHUB_TOKEN");
  const username = args.username ?? getEnv("GITHUB_USERNAME", "remy90");
  const lookbackYears = Number.parseInt(
    args["lookback-years"] ?? getEnv("LOOKBACK_YEARS", "5"),
    10,
  );
  const maxCommits = Number.parseInt(
    args["max-commits"] ?? getEnv("MAX_COMMITS", "100"),
    10,
  );
  const ignoredOwners = new Set(
    parseCsvList(args["ignore-owners"] ?? getEnv("IGNORE_REPO_OWNERS", "")),
  );
  const readmePath = path.resolve(
    args.readme ?? getEnv("PROFILE_README_PATH", "README.md"),
  );
  const sectionStart = getEnv(
    "CONTRIBUTIONS_SECTION_START",
    DEFAULT_SECTION_START,
  );
  const sectionEnd = getEnv("CONTRIBUTIONS_SECTION_END", DEFAULT_SECTION_END);

  if (!token) {
    throw new Error("Missing GITHUB_TOKEN environment variable.");
  }

  if (!Number.isInteger(lookbackYears) || lookbackYears < 1) {
    throw new Error("LOOKBACK_YEARS must be a positive integer.");
  }

  if (!Number.isInteger(maxCommits) || maxCommits < 1) {
    throw new Error("MAX_COMMITS must be a positive integer.");
  }

  const commits = [];
  const commitUrls = new Set();
  const warnings = new Set();
  let totalCommits = 0;

  for (const window of getInitialDateWindows(lookbackYears)) {
    totalCommits += await collectWindowCommits({
      username,
      start: window.start,
      end: window.end,
      token,
      commits,
      commitUrls,
      maxCommits,
      warnings,
      ignoredOwners,
    });
  }

  commits.sort(
    (left, right) =>
      new Date(right.authoredAt).getTime() -
      new Date(left.authoredAt).getTime(),
  );

  const sectionContent = buildSection({
    username,
    lookbackYears,
    totalCommits,
    shownCommits: commits.slice(0, maxCommits),
    maxCommits,
    warnings: [...warnings],
  });

  const changed = await updateReadme({
    readmePath,
    sectionStart,
    sectionEnd,
    sectionContent,
  });

  console.log(
    changed
      ? `Updated ${readmePath} with ${Math.min(commits.length, maxCommits)} commit links.`
      : `No README changes needed. ${Math.min(commits.length, maxCommits)} commit links already in sync.`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
