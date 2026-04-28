const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());

const API_KEY = process.env.wckey;
if (!API_KEY) {
  throw new Error("wckey saknas");
}

let matchesCache = null;
let matchesCacheTime = 0;
const CACHE_MS = 60 * 60 * 1000; // 60 minuter

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

app.get("/matches", async (req, res) => {
  try {
    const now = Date.now();
    const hasFreshCache = matchesCache && (now - matchesCacheTime) < CACHE_MS;
    const hasAnyCache = !!matchesCache;

    if (hasFreshCache) {
      return res.json(matchesCache);
    }

    const response = await fetch("https://api.wc2026api.com/matches", {
      headers: {
        Authorization: `Bearer ${API_KEY}`
      }
    });

    const data = await response.json();

    if (!response.ok) {
      const retryAfterHeader = response.headers.get("retry-after");
      let retryAfterMinutes = null;

      if (retryAfterHeader) {
        const retrySeconds = Number(retryAfterHeader);
        if (!Number.isNaN(retrySeconds)) {
          retryAfterMinutes = Math.ceil(retrySeconds / 60);
        }
      }

      const isRateLimited =
        response.status === 429 ||
        data?.error?.toLowerCase?.().includes("rate limit");

      if (hasAnyCache) {
        return res.json(matchesCache);
      }

      const backupMatches = readBackupMatches();
      if (backupMatches) {
        return res.json(backupMatches);
      }

      if (isRateLimited) {
        return res.status(response.status).json({
          error: "Rate limit exceeded",
          retryAfterMinutes,
          friendlyMessage: retryAfterMinutes
            ? `För många anrop just nu. Vänta cirka ${retryAfterMinutes} minuter och försök igen.`
            : "För många anrop just nu. Vänta några minuter och försök igen."
        });
      }

      return res.status(response.status).json(data);
    }

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

    return res.status(500).json({
      error: "API fail",
      friendlyMessage: "Något gick fel när matcherna skulle hämtas."
    });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running"));
