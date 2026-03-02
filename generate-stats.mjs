#!/usr/bin/env node
/**
 * generate-stats.mjs
 * Fetches top-10 programming languages across all user repos and generates stats.svg
 *
 * Requirements: Node.js 18+ (native fetch), zero external npm dependencies
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx GITHUB_USERNAME=CallejaJ node generate-stats.mjs
 *
 * Environment variables:
 *   GITHUB_TOKEN    - Personal Access Token with 'repo' scope (required)
 *   GITHUB_USERNAME - Your GitHub username (required)
 *   OUTPUT_FILE     - Output path for the SVG (default: stats.svg)
 *   TOP_N           - Number of languages to show (default: 10)
 *   INCLUDE_FORKS   - Set to 'true' to include forked repos (default: false)
 */

import { writeFileSync } from 'fs';

// ─── Configuration ────────────────────────────────────────────────────────────

const GITHUB_TOKEN    = process.env.GH_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const OUTPUT_FILE     = process.env.OUTPUT_FILE     ?? 'stats.svg';
const TOP_N           = parseInt(process.env.TOP_N  ?? '10', 10);
const INCLUDE_FORKS   = process.env.INCLUDE_FORKS   === 'true';

if (!GITHUB_TOKEN) {
  console.error('ERROR: GH_TOKEN environment variable is required.');
  console.error('Create a PAT at https://github.com/settings/tokens with "repo" scope.');
  process.exit(1);
}
if (!GITHUB_USERNAME) {
  console.error('ERROR: GITHUB_USERNAME environment variable is required.');
  process.exit(1);
}

// ─── Language Color Map (GitHub Linguist) ────────────────────────────────────

const LANGUAGE_COLORS = {
  TypeScript:   '#3178c6',
  JavaScript:   '#f1e05a',
  Solidity:     '#AA6746',
  Shell:        '#89e051',
  Rust:         '#dea584',
  CSS:          '#563d7c',
  HTML:         '#e34c26',
  Astro:        '#ff5a03',
  Python:       '#3572A5',
  Go:           '#00ADD8',
  Vue:          '#41b883',
  Svelte:       '#ff3e00',
  Java:         '#b07219',
  'C++':        '#f34b7d',
  C:            '#555555',
  Ruby:         '#701516',
  PHP:          '#4F5D95',
  Swift:        '#F05138',
  Kotlin:       '#A97BFF',
  Dart:         '#00B4AB',
  Lua:          '#000080',
  Nix:          '#7e7eff',
  Makefile:     '#427819',
  Dockerfile:   '#384d54',
  YAML:         '#cb171e',
  SCSS:         '#c6538c',
  Less:         '#1d365d',
  HCL:          '#844FBA',
  Terraform:    '#844FBA',
  MDX:          '#fcb32c',
  _default:     '#8b949e',
};

const getColor = (lang) => LANGUAGE_COLORS[lang] ?? LANGUAGE_COLORS._default;

// ─── API Helpers ──────────────────────────────────────────────────────────────

const BASE_HEADERS = {
  Authorization:          `Bearer ${GITHUB_TOKEN}`,
  Accept:                 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent':           'stack-stats-generator/1.0',
};

/**
 * Parse Link header → returns next page URL or null.
 * Example: <https://api.github.com/user/repos?page=2>; rel="next", ...
 */
function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const [urlPart, relPart] = part.trim().split(';');
    if (relPart?.trim() === 'rel="next"') {
      return urlPart.trim().slice(1, -1); // strip < and >
    }
  }
  return null;
}

/** Warn if rate limit is critically low. */
function checkRateLimit(headers) {
  const remaining = parseInt(headers.get('x-ratelimit-remaining') ?? '9999', 10);
  const used      = parseInt(headers.get('x-ratelimit-used')      ?? '0',    10);
  if (remaining < 50) {
    console.warn(`  ⚠ Rate limit low: ${remaining} remaining (${used} used)`);
  }
}

/** Fetch all pages of a paginated GitHub API endpoint. */
async function fetchAllPages(initialUrl) {
  const allItems = [];
  let url = initialUrl;

  while (url) {
    const response = await fetch(url, { headers: BASE_HEADERS });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub API ${response.status} for ${url}: ${body}`);
    }

    checkRateLimit(response.headers);
    const data = await response.json();
    allItems.push(...data);
    url = parseNextLink(response.headers.get('link'));
  }

  return allItems;
}

/** Fetch language bytes for a single repo. Returns {} on error (non-fatal). */
async function fetchRepoLanguages(repoName) {
  const url = `https://api.github.com/repos/${GITHUB_USERNAME}/${repoName}/languages`;
  const response = await fetch(url, { headers: BASE_HEADERS });

  if (response.status === 404) {
    console.warn(`  Skipping ${repoName}: 404`);
    return {};
  }
  if (!response.ok) {
    console.warn(`  Skipping ${repoName}: HTTP ${response.status}`);
    return {};
  }

  checkRateLimit(response.headers);
  return response.json();
}

// ─── Core Logic ───────────────────────────────────────────────────────────────

async function fetchAllRepos() {
  console.log('Fetching repository list...');
  const url = `https://api.github.com/user/repos?visibility=all&affiliation=owner&per_page=100`;
  const repos = await fetchAllPages(url);
  console.log(`Found ${repos.length} repos total.`);
  return repos;
}

async function aggregateLanguages(repos) {
  console.log('Fetching language data...');
  const totals = {};

  for (const repo of repos) {
    if (!INCLUDE_FORKS && repo.fork) continue;

    process.stdout.write(`  ${repo.name}...\r`);
    const langData = await fetchRepoLanguages(repo.name);

    for (const [lang, bytes] of Object.entries(langData)) {
      totals[lang] = (totals[lang] ?? 0) + bytes;
    }
  }

  process.stdout.write('\n');

  const totalBytes = Object.values(totals).reduce((s, b) => s + b, 0);
  if (totalBytes === 0) throw new Error('No language data found. Check your token has "repo" scope.');

  // Sort by bytes, take top N, recalculate percentages relative to top-N only
  const sorted = Object.entries(totals)
    .sort(([, a], [, b]) => b - a)
    .slice(0, TOP_N);

  const topNBytes = sorted.reduce((s, [, b]) => s + b, 0);

  return sorted.map(([lang, bytes]) => ({
    lang,
    bytes,
    percentage: (bytes / topNBytes) * 100,
  }));
}

// ─── SVG Generation ───────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000)     return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Escape XML special characters to avoid SVG injection. */
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function generateSVG(languages) {
  const WIDTH        = 495;
  const PADDING_X    = 20;
  const BAR_Y        = 52;    // Y position of the stacked bar
  const BAR_H        = 10;    // height of stacked bar
  const BAR_W        = WIDTH - PADDING_X * 2;
  const LEGEND_START = 76;    // Y where legend grid begins
  const ROW_H        = 22;    // height per legend row
  const COLS         = 3;     // legend columns

  const rows  = Math.ceil(languages.length / COLS);
  const HEIGHT = LEGEND_START + rows * ROW_H + 20;

  // ── Stacked bar segments (clipped to rounded bar shape) ─────────────────
  // SVG <rect rx> only accepts a single radius value; per-corner rounding
  // requires a <clipPath>. All segments are clipped to the rounded track rect.
  let barX = PADDING_X;
  const barSegments = languages.map((item) => {
    const segW = Math.max((item.percentage / 100) * BAR_W, 2);
    const seg  = `<rect x="${barX.toFixed(2)}" y="${BAR_Y}" width="${segW.toFixed(2)}" height="${BAR_H}" fill="${getColor(item.lang)}" />`;
    barX += segW;
    return seg;
  });

  // ── Legend items ─────────────────────────────────────────────────────────
  const colW   = BAR_W / COLS;
  const legendItems = languages.map((item, i) => {
    const col  = i % COLS;
    const row  = Math.floor(i / COLS);
    const x    = PADDING_X + col * colW;
    const y    = LEGEND_START + row * ROW_H;
    const pct  = item.percentage.toFixed(2) + '%';
    const name = escapeXml(item.lang);
    return `
    <g transform="translate(${x}, ${y})">
      <circle cx="5" cy="5" r="5" fill="${getColor(item.lang)}" />
      <text x="14" y="9" class="lang-name">${name}</text>
      <text x="14" y="9" class="lang-pct" dx="${Math.min(name.length * 7.2, colW - 40)}">${pct}</text>
    </g>`;
  });

  const updatedAt = new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  });

  return `<svg xmlns="http://www.w3.org/2000/svg"
  width="${WIDTH}" height="${HEIGHT}"
  viewBox="0 0 ${WIDTH} ${HEIGHT}"
  role="img"
  aria-label="Top programming languages for ${escapeXml(GITHUB_USERNAME)}">

  <title>Top Languages – ${escapeXml(GITHUB_USERNAME)}</title>

  <style>
    .card      { fill: #161b22; stroke: #30363d; stroke-width: 1; }
    .title     { font: 600 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; fill: #00D9FF; }
    .updated   { font: 400 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; fill: #484f58; }
    .lang-name { font: 500 11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; fill: #c9d1d9; }
    .lang-pct  { font: 600 11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; fill: #8b949e; }
  </style>

  <defs>
    <!-- Clip all bar segments to the rounded bar shape -->
    <clipPath id="bar-clip">
      <rect x="${PADDING_X}" y="${BAR_Y}" width="${BAR_W}" height="${BAR_H}" rx="5" />
    </clipPath>
  </defs>

  <!-- Card background -->
  <rect width="${WIDTH}" height="${HEIGHT}" rx="6" ry="6" class="card" />

  <!-- Title -->
  <text x="${PADDING_X}" y="30" class="title">⚡ Languages Used</text>

  <!-- Last updated -->
  <text x="${WIDTH - PADDING_X}" y="30" class="updated" text-anchor="end">Updated ${updatedAt}</text>

  <!-- Stacked bar background track -->
  <rect x="${PADDING_X}" y="${BAR_Y}" width="${BAR_W}" height="${BAR_H}" rx="5" fill="#21262d" />

  <!-- Stacked bar segments (clipped to rounded track) -->
  <g clip-path="url(#bar-clip)">
    ${barSegments.join('\n    ')}
  </g>

  <!-- Legend -->
  ${legendItems.join('')}
</svg>`;
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== GitHub Language Stats Generator ===`);
  console.log(`User:   ${GITHUB_USERNAME}`);
  console.log(`Output: ${OUTPUT_FILE}`);
  console.log(`Top N:  ${TOP_N}`);
  console.log(`Forks:  ${INCLUDE_FORKS ? 'included' : 'excluded'}\n`);

  const repos     = await fetchAllRepos();
  const languages = await aggregateLanguages(repos);

  console.log('\nTop languages:');
  languages.forEach((l, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. ${l.lang.padEnd(16)} ${l.percentage.toFixed(2).padStart(6)}%  (${formatBytes(l.bytes)})`));

  const svg = generateSVG(languages);
  writeFileSync(OUTPUT_FILE, svg, 'utf8');
  console.log(`\nSVG written to: ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
