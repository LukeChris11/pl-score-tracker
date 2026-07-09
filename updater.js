const admin = require('firebase-admin');
const fetch = require('node-fetch');

// ── Firebase setup ────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://premier-league-tracker-a6d64-default-rtdb.firebaseio.com'
});
const db = admin.database();

// ── API helper ────────────────────────────────────────────
const API_KEY  = process.env.FOOTBALL_DATA_API_KEY;
const BASE_URL = 'https://api.football-data.org/v4';

async function api(path) {
  const res = await fetch(`${BASE_URL}/${path}`, {
    headers: { 'X-Auth-Token': API_KEY }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status} on /${path}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

// Small delay helper to avoid hitting the 10 calls/min rate limit
const wait = ms => new Promise(r => setTimeout(r, ms));

// Normalise team names — use shortName where available, else strip FC/AFC suffix
function teamName(team) {
  if (team.shortName) return team.shortName;
  return team.name.replace(/\s+(F\.?C\.?|A\.?F\.?C\.?)$/i, '').trim();
}

// ── Main ──────────────────────────────────────────────────
async function run() {
  console.log(`[${new Date().toISOString()}] PL score updater starting...`);

  // Fetch competition info to get current season + matchday
  const competition = await api('competitions/PL');
  const currentSeason = competition.currentSeason;

  if (!currentSeason) {
    console.log('No active PL season found — exiting.');
    process.exit(0);
  }

  const season      = currentSeason.startDate.substring(0, 4); // e.g. "2026"
  const matchday    = currentSeason.currentMatchday || 1;
  const totalWeeks  = currentSeason.numberOfAvailableMatchdays || 38;

  console.log(`Season ${season}/${parseInt(season)+1}, Matchday ${matchday}/${totalWeeks}`);

  // Always update meta so the frontend knows current matchday
  await db.ref('meta').update({
    currentMatchday: matchday,
    season,
    totalMatchdays: totalWeeks,
    lastUpdated: new Date().toISOString()
  });

  // Fetch the matchdays we need:
  // - previous (to catch any delayed result updates)
  // - current
  // - next (so predictions can open early)
  const matchdays = [
    matchday - 1,
    matchday,
    matchday + 1
  ].filter(m => m >= 1 && m <= totalWeeks);

  for (const mw of matchdays) {
    console.log(`\nFetching matchday ${mw}...`);
    await wait(1200); // stay inside 10 calls/min free tier limit

    let data;
    try {
      data = await api(`competitions/PL/matches?matchday=${mw}&season=${season}`);
    } catch (err) {
      console.error(`  Failed to fetch matchday ${mw}: ${err.message}`);
      continue;
    }

    const matches = data.matches || [];
    if (matches.length === 0) {
      console.log(`  No matches found for matchday ${mw}`);
      continue;
    }

    const fixtureUpdates = {};
    let firstKickoff     = null;

    for (const match of matches) {
      const isFinished = match.status === 'FINISHED';
      const isLive     = match.status === 'IN_PLAY' || match.status === 'PAUSED';

      const fixture = {
        id:       match.id,
        homeTeam: teamName(match.homeTeam),
        awayTeam: teamName(match.awayTeam),
        kickoff:  match.utcDate,
        status:   match.status,
        matchday: mw,
        homeScore: (isFinished || isLive) ? (match.score.fullTime.home ?? 0) : null,
        awayScore: (isFinished || isLive) ? (match.score.fullTime.away ?? 0) : null
      };

      fixtureUpdates[match.id] = fixture;

      // Track earliest kickoff to determine lock time
      const ko = new Date(match.utcDate);
      if (!firstKickoff || ko < firstKickoff) firstKickoff = ko;
    }

    // Write fixtures to Firebase
    await db.ref(`fixtures/${season}/${mw}`).update(fixtureUpdates);

    // Set matchweek lock: locked as soon as first game kicks off
    const now    = new Date();
    const locked = firstKickoff ? firstKickoff <= now : false;
    await db.ref(`matchweekLocks/${season}/${mw}`).update({
      firstKickoff: firstKickoff ? firstKickoff.toISOString() : null,
      locked
    });

    const finished = matches.filter(m => m.status === 'FINISHED').length;
    const live     = matches.filter(m => ['IN_PLAY','PAUSED'].includes(m.status)).length;
    console.log(`  ${matches.length} fixtures | ${finished} finished | ${live} live | locked: ${locked}`);
  }

  console.log('\n✓ Update complete.');
  process.exit(0);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
