const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());

const API_KEY = process.env.sportdbKey || process.env.SPORTDB_API_KEY;
if (!API_KEY) {
  throw new Error("sportdbKey eller SPORTDB_API_KEY saknas");
}

const API_BASE_URL = "https://api.sportdb.dev";
const FIXTURES_PATH = "/api/flashscore/football/world:8/world-cup:lvUBR5F8/2026/fixtures";
const RESULTS_PATH = "/api/flashscore/football/world:8/world-cup:lvUBR5F8/2026/results";

let matchesCache = null;
let matchesCacheTime = 0;
const CACHE_MS = 60 * 60 * 1000;

const BACKUP_PATH = path.join(__dirname, "public", "matches-backup.json");

function readBackupMatches() {
  try {
    if (!fs.existsSync(BACKUP_PATH)) return null;
    const raw = fs.readFileSync(BACKUP_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.error("Kunde inte läsa backupfil:", err);
    return null;
  }
}

function writeBackupMatches(data) {
  try {
    fs.writeFileSync(BACKUP_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Kunde inte skriva backupfil:", err);
  }
}

async function fetchSportDbJson(route) {
  const response = await fetch(`${API_BASE_URL}${route}`, {
    headers: {
      "X-API-Key": API_KEY
    }
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    data = { error: text || "Ogiltigt JSON-svar från SportDB" };
  }

  if (!response.ok) {
    const error = new Error(
      data?.detail ||
      data?.error ||
      `SportDB svarade med status ${response.status}`
    );
    error.status = response.status;
    error.payload = data;
    throw error;
  }

  return data;
}

async function fetchPagedMatches(basePath, maxPages = 10) {
  const allMatches = [];
  const seenIds = new Set();

  for (let page = 1; page <= maxPages; page += 1) {
    const data = await fetchSportDbJson(`${basePath}?page=${page}`);
    if (!Array.isArray(data) || !data.length) {
      break;
    }

    let newRows = 0;

    data.forEach(match => {
      const matchId = String(match?.eventId || "");
      if (!matchId || seenIds.has(matchId)) return;
      seenIds.add(matchId);
      allMatches.push(match);
      newRows += 1;
    });

    if (newRows === 0) {
      break;
    }
  }

  return allMatches;
}

function parseScore(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSportDbMatch(match) {
  return {
    id: String(match.eventId),
    match_number: null,
    round: match.round || null,
    group: null,
    group_name: null,
    home_team_id: match.homeParticipantIds || null,
    home_team: match.homeName || null,
    away_team_id: match.awayParticipantIds || null,
    away_team: match.awayName || null,
    kickoff_utc: match.startDateTimeUtc || null,
    home_score: parseScore(match.homeFullTimeScore ?? match.homeScore),
    away_score: parseScore(match.awayFullTimeScore ?? match.awayScore),
    status: match.eventStage || null,
    tournament_id: match.tournamentId || null,
    tournament_stage_id: match.tournamentStageId || null,
    season_id: match.season || null,
    source: "sportdb",
    venue: null
  };
}

function getMostCommonValue(items, getter) {
  const counts = new Map();

  items.forEach(item => {
    const value = getter(item);
    if (!value) return;
    counts.set(value, (counts.get(value) || 0) + 1);
  });

  let bestValue = null;
  let bestCount = 0;

  counts.forEach((count, value) => {
    if (count > bestCount) {
      bestValue = value;
      bestCount = count;
    }
  });

  return bestValue;
}

function buildConnectedComponents(matches) {
  const adjacency = new Map();

  matches.forEach(match => {
    const home = match.home_team;
    const away = match.away_team;
    if (!home || !away) return;

    if (!adjacency.has(home)) adjacency.set(home, new Set());
    if (!adjacency.has(away)) adjacency.set(away, new Set());

    adjacency.get(home).add(away);
    adjacency.get(away).add(home);
  });

  const visited = new Set();
  const components = [];

  adjacency.forEach((_, team) => {
    if (visited.has(team)) return;

    const queue = [team];
    const component = [];
    visited.add(team);

    while (queue.length) {
      const current = queue.shift();
      component.push(current);

      (adjacency.get(current) || []).forEach(nextTeam => {
        if (visited.has(nextTeam)) return;
        visited.add(nextTeam);
        queue.push(nextTeam);
      });
    }

    components.push(component);
  });

  return components;
}

function inferGroupNames(matches) {
  const groupStageMatches = matches.filter(match =>
    /^Round \d+$/i.test(match.round || "") &&
    match.home_team &&
    match.away_team
  );

  const components = buildConnectedComponents(groupStageMatches);
  const teamToGroup = new Map();

  components
    .map(component => {
      const componentMatches = groupStageMatches.filter(match =>
        component.includes(match.home_team) || component.includes(match.away_team)
      );

      const earliestKickoff = componentMatches.reduce((earliest, match) => {
        const kickoff = match.kickoff_utc ? new Date(match.kickoff_utc).getTime() : Infinity;
        return Math.min(earliest, kickoff);
      }, Infinity);

      return { component, earliestKickoff };
    })
    .sort((a, b) => a.earliestKickoff - b.earliestKickoff)
    .forEach((entry, index) => {
      const label = String.fromCharCode(65 + index);
      entry.component.forEach(team => {
        teamToGroup.set(team, label);
      });
    });

  matches.forEach(match => {
    if (!/^Round \d+$/i.test(match.round || "")) return;
    const homeGroup = teamToGroup.get(match.home_team);
    const awayGroup = teamToGroup.get(match.away_team);
    const groupLabel = homeGroup || awayGroup || null;

    if (groupLabel) {
      match.group = groupLabel;
      match.group_name = groupLabel;
    }
  });

  return matches;
}

function mergeAndNormalizeMatches(fixtures, results) {
  const normalizedFixtures = fixtures.map(normalizeSportDbMatch);
  const normalizedResults = results.map(normalizeSportDbMatch);

  const canonicalTournamentId =
    getMostCommonValue(normalizedFixtures, match => match.tournament_id) ||
    getMostCommonValue(normalizedResults, match => match.tournament_id);

  const canonicalStageId =
    getMostCommonValue(normalizedFixtures, match => match.tournament_stage_id) ||
    getMostCommonValue(normalizedResults, match => match.tournament_stage_id);

  const canonicalSeasonId =
    getMostCommonValue(normalizedFixtures, match => match.season_id) ||
    getMostCommonValue(normalizedResults, match => match.season_id);

  const relevantMatches = [...normalizedFixtures, ...normalizedResults].filter(match => {
    const tournamentOk = !canonicalTournamentId || match.tournament_id === canonicalTournamentId;
    const stageOk = !canonicalStageId || match.tournament_stage_id === canonicalStageId;
    const seasonOk = !canonicalSeasonId || match.season_id === canonicalSeasonId;
    return tournamentOk && stageOk && seasonOk;
  });

  const matchMap = new Map();

  relevantMatches.forEach(normalized => {
    const existing = matchMap.get(normalized.id) || {};
    matchMap.set(normalized.id, {
      ...existing,
      ...normalized,
      home_score: normalized.home_score ?? existing.home_score ?? null,
      away_score: normalized.away_score ?? existing.away_score ?? null
    });
  });

  const merged = Array.from(matchMap.values()).sort((a, b) => {
    const aTime = a.kickoff_utc ? new Date(a.kickoff_utc).getTime() : 0;
    const bTime = b.kickoff_utc ? new Date(b.kickoff_utc).getTime() : 0;
    if (aTime !== bTime) return aTime - bTime;
    return String(a.id).localeCompare(String(b.id), "sv");
  });

  return inferGroupNames(merged);
}

async function loadWorldCupMatches() {
  const [fixtures, results] = await Promise.all([
    fetchPagedMatches(FIXTURES_PATH),
    fetchPagedMatches(RESULTS_PATH)
  ]);

  return mergeAndNormalizeMatches(fixtures, results);
}

function buildFriendlyError(error) {
  if (error?.status === 401 || error?.status === 403) {
    return "SportDB-nyckeln är ogiltig eller saknar behörighet.";
  }

  if (error?.status === 429) {
    return "För många anrop mot SportDB just nu. Försök igen om en liten stund.";
  }

  return "Något gick fel när matcherna skulle hämtas.";
}

app.get("/matches", async (req, res) => {
  try {
    const now = Date.now();
    const hasFreshCache = matchesCache && (now - matchesCacheTime) < CACHE_MS;

    if (hasFreshCache) {
      return res.json(matchesCache);
    }

    const data = await loadWorldCupMatches();

    matchesCache = data;
    matchesCacheTime = now;
    writeBackupMatches(data);

    return res.json(data);
  } catch (err) {
    console.error(err);

    if (matchesCache) {
      return res.json(matchesCache);
    }

    const backupMatches = readBackupMatches();
    if (backupMatches) {
      return res.json(backupMatches);
    }

    return res.status(err?.status || 500).json({
      error: err?.message || "API fail",
      friendlyMessage: buildFriendlyError(err)
    });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running"));
