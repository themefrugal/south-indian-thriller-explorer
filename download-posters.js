#!/usr/bin/env node
/**
 * download-posters.js  —  run once: node download-posters.js
 *
 * Three-tier poster strategy per movie:
 *   1. Wikipedia REST summary  →  thumbnail / originalimage
 *   2. MediaWiki pageimages API  →  thumbnail (sometimes works when summary doesn't)
 *   3. Parse the article's image list, pick the best poster candidate,
 *      fetch its direct URL via imageinfo API
 *
 * Retries HTTP 429 (rate-limit) up to 5 times with backoff.
 * Saves everything as  ./posters/<id>.jpg
 * Requires Node 18+ (built-in fetch).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ── Load MOVIES ──────────────────────────────────────────────────────────────
const moviesJs = fs.readFileSync(path.join(__dirname, 'movies.js'), 'utf8');
const sandbox  = {};
vm.createContext(sandbox);
vm.runInContext(moviesJs.replace(/\bconst\s+MOVIES\b/, 'MOVIES'), sandbox);
const MOVIES = sandbox.MOVIES;
if (!MOVIES) { console.error('Failed to load MOVIES'); process.exit(1); }

// ── Setup ────────────────────────────────────────────────────────────────────
const POSTER_DIR  = path.join(__dirname, 'posters');
const CONCURRENCY = 4;     // parallel movies at a time
const BASE_DELAY  = 250;   // ms between requests per movie
const MAX_RETRIES = 5;
const UA          = 'thriller-explorer-poster-downloader/2.0 (github; personal project)';

if (!fs.existsSync(POSTER_DIR)) fs.mkdirSync(POSTER_DIR);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Fetch with retry on 429 ──────────────────────────────────────────────────
async function fetchWithRetry(url, opts = {}, retries = MAX_RETRIES) {
  const headers = { 'User-Agent': UA, ...(opts.headers || {}) };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, { ...opts, headers });
    if (res.status === 429) {
      const wait = parseInt(res.headers.get('retry-after') || '0', 10) * 1000 || (2 ** attempt) * 1000;
      console.log(`    ⏳ 429 rate-limit — waiting ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${retries})`);
      await sleep(wait + Math.random() * 500);
      continue;
    }
    return res;
  }
  throw new Error(`Still getting 429 after ${retries} retries: ${url}`);
}

// ── Download image bytes to disk ─────────────────────────────────────────────
async function downloadImage(url, dest) {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const buf = await res.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(buf));
  return Math.round(buf.byteLength / 1024);
}

// ── Strategy 1: REST summary → originalimage or thumbnail ────────────────────
async function tryRestSummary(wikiTitle) {
  const url  = 'https://en.wikipedia.org/api/rest_v1/page/summary/' +
    encodeURIComponent(wikiTitle.replace(/ /g, '_'));
  const res  = await fetchWithRetry(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data?.originalimage?.source || data?.thumbnail?.source || null;
}

// ── Strategy 2: pageimages API ───────────────────────────────────────────────
async function tryPageImages(wikiTitle) {
  const url  = 'https://en.wikipedia.org/w/api.php?action=query&prop=pageimages' +
    '&piprop=original|thumbnail&pithumbsize=500&format=json&origin=*&titles=' +
    encodeURIComponent(wikiTitle);
  const res  = await fetchWithRetry(url);
  if (!res.ok) return null;
  const data = await res.json();
  for (const page of Object.values(data?.query?.pages || {})) {
    if (page.original?.source)   return page.original.source;
    if (page.thumbnail?.source)  return page.thumbnail.source;
  }
  return null;
}

// ── Strategy 3: parse article image list, pick best poster candidate ─────────
async function tryParseInfboxImage(wikiTitle) {
  // Step A: get all image filenames referenced on the page
  const parseUrl = 'https://en.wikipedia.org/w/api.php?action=parse&prop=images' +
    '&format=json&origin=*&page=' + encodeURIComponent(wikiTitle);
  const parseRes = await fetchWithRetry(parseUrl);
  if (!parseRes.ok) return null;
  const parseData = await parseRes.json();
  const images = (parseData?.parse?.images || []);
  if (!images.length) return null;

  // Score each filename — prefer ones that look like a film poster
  const lower  = wikiTitle.toLowerCase();
  function score(name) {
    const n = name.toLowerCase();
    if (!n.match(/\.(jpg|jpeg|png|webp)$/i)) return -1;
    let s = 0;
    if (n.includes('poster'))                  s += 10;
    if (n.includes('film'))                    s += 3;
    if (n.includes('movie'))                   s += 3;
    // title words present in filename → strong signal
    lower.split(/\W+/).filter(w => w.length > 3).forEach(w => {
      if (n.includes(w)) s += 4;
    });
    if (n.includes('logo') || n.includes('icon') || n.includes('flag') ||
        n.includes('map')  || n.includes('award') || n.includes('sign')) s -= 5;
    return s;
  }

  const ranked = images
    .map(name => ({ name, s: score(name) }))
    .filter(x => x.s >= 0)
    .sort((a, b) => b.s - a.s);

  if (!ranked.length) return null;

  // Step B: get the direct URL for the best candidate via imageinfo API
  const filename = ranked[0].name;
  const infoUrl  = 'https://en.wikipedia.org/w/api.php?action=query&prop=imageinfo' +
    '&iiprop=url&iiurlwidth=500&format=json&origin=*&titles=File:' +
    encodeURIComponent(filename);
  const infoRes  = await fetchWithRetry(infoUrl);
  if (!infoRes.ok) return null;
  const infoData = await infoRes.json();
  for (const page of Object.values(infoData?.query?.pages || {})) {
    const u = page?.imageinfo?.[0]?.thumburl || page?.imageinfo?.[0]?.url;
    if (u) return u;
  }
  return null;
}

// ── Strategy 4: scrape TMDb movie page for poster image URL ─────────────────
async function tryTmdb(tmdbId) {
  if (!tmdbId) return null;
  const url = `https://www.themoviedb.org/movie/${tmdbId}`;
  const res  = await fetchWithRetry(url);
  if (!res.ok) return null;
  const html = await res.text();

  // TMDb embeds poster images as:  media.themoviedb.org/t/p/<size>/<hash>.jpg
  // Extract hash, then request at w500 resolution for good quality
  const match = html.match(/media\.themoviedb\.org\/t\/p\/[^"']+\/([A-Za-z0-9]+\.(?:jpg|png))/i);
  if (match) return `https://media.themoviedb.org/t/p/w500/${match[1]}`;

  // Fallback: og:image (usually a backdrop, but better than nothing)
  const og = html.match(/property="og:image"\s+content="([^"]+)"/);
  return og ? og[1] : null;
}

// ── Process one movie — try all four strategies ───────────────────────────────
async function processMovie(m) {
  const dest = path.join(POSTER_DIR, `${m.id}.jpg`);

  if (fs.existsSync(dest)) {
    console.log(`  ✓ [${m.id}] ${m.title} — already on disk`);
    return 'skipped';
  }

  if (!m.wiki) {
    console.log(`  — [${m.id}] ${m.title} — no wiki title`);
    return 'no-wiki';
  }

  let posterUrl = null;

  try {
    posterUrl = await tryRestSummary(m.wiki);
    if (!posterUrl) { await sleep(BASE_DELAY); posterUrl = await tryPageImages(m.wiki); }
    if (!posterUrl) { await sleep(BASE_DELAY); posterUrl = await tryParseInfboxImage(m.wiki); }
    if (!posterUrl) { await sleep(BASE_DELAY); posterUrl = await tryTmdb(m.tmdb); }

    if (!posterUrl) {
      console.log(`  ✗ [${m.id}] ${m.title} — no poster found`);
      return 'not-found';
    }

    await sleep(BASE_DELAY);
    const kb = await downloadImage(posterUrl, dest);
    console.log(`  ↓ [${m.id}] ${m.title} — ${kb} KB`);
    return 'downloaded';

  } catch (err) {
    console.log(`  ✗ [${m.id}] ${m.title} — ${err.message}`);
    return 'error';
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🎬  Downloading posters for ${MOVIES.length} films → ./posters/\n`);
  const counts   = { downloaded: 0, skipped: 0, 'not-found': 0, 'no-wiki': 0, error: 0 };
  const missing  = [];

  for (let i = 0; i < MOVIES.length; i += CONCURRENCY) {
    const batch    = MOVIES.slice(i, i + CONCURRENCY);
    const statuses = await Promise.all(batch.map(processMovie));
    statuses.forEach((s, idx) => {
      counts[s] = (counts[s] || 0) + 1;
      if (s === 'not-found' || s === 'error') missing.push(`[${batch[idx].id}] ${batch[idx].title}  (${s})`);
    });
    await sleep(BASE_DELAY);
  }

  console.log('\n── Summary ──────────────────────────────────────────────');
  console.log(`  Downloaded : ${counts.downloaded}`);
  console.log(`  Skipped    : ${counts.skipped}  (already on disk)`);
  console.log(`  Not found  : ${counts['not-found']}`);
  console.log(`  Errors     : ${counts.error}`);
  if (missing.length) {
    console.log('\n  Still missing — add manually as  posters/<id>.jpg :');
    missing.forEach(t => console.log(`    • ${t}`));
  }
  console.log('\nDone.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
