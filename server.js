const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SCORES_FILE)) fs.writeFileSync(SCORES_FILE, JSON.stringify({}), 'utf8');

function readScores() {
  try {
    return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8') || '{}');
  } catch (e) {
    return {};
  }
}

function writeScores(obj) {
  try {
    fs.writeFileSync(SCORES_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write scores:', e);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files (overlay + leaderboard pages)
app.use(express.static(path.join(__dirname)));

// --- Poll collection (optional) ---
// Holds active polls: { [pollId]: { options: [...], votes: Map<username, idx> } }
const POLLS = {};

function normalizeVoteText(text, options) {
  if (!text) return -1;
  const raw = String(text).trim();
  const lower = raw.toLowerCase();

  // !vote N
  const m = lower.match(/^!vote\s*(\d{1,2})\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= options.length) return n - 1;
  }

  // aliases fact/myth
  const norm = options.map(o => String(o).toLowerCase());
  if (/^!fact\b/.test(lower)) return norm.indexOf('fact');
  if (/^!myth\b/.test(lower)) return norm.indexOf('myth');

  return -1;
}

// Start a poll: body { pollId, options: [..] }
app.post('/api/poll/start', (req, res) => {
  const body = req.body || {};
  const pollId = String(body.pollId || '').trim();
  const options = Array.isArray(body.options) ? body.options.map(String) : null;
  if (!pollId || !options || options.length < 2) return res.status(400).json({ error: 'pollId and options required' });
  POLLS[pollId] = { options, votes: new Map() };
  return res.json({ ok: true });
});

// Finish a poll: body { pollId }
app.post('/api/poll/finish', (req, res) => {
  const body = req.body || {};
  const pollId = String(body.pollId || '').trim();
  if (!pollId || !POLLS[pollId]) return res.status(400).json({ error: 'unknown pollId' });

  const poll = POLLS[pollId];
  const voteCounts = Array.from({ length: poll.options.length }, () => 0);
  for (const idx of poll.votes.values()) {
    if (Number.isInteger(idx) && idx >= 0 && idx < voteCounts.length) voteCounts[idx]++;
  }
  const max = Math.max(...voteCounts);
  const tops = voteCounts.map((v, i) => (v === max ? i : -1)).filter(i => i !== -1);
  const choiceIdx = tops[Math.floor(Math.random() * tops.length)];

  // Credit winners
  try {
    const scores = readScores();
    for (const [user, idx] of poll.votes.entries()) {
      if (idx === choiceIdx && user) {
        const cur = Number.isFinite(scores[user]) ? Number(scores[user]) : 0;
        scores[user] = cur + 1;
      }
    }
    writeScores(scores);
  } catch (e) {
    console.error('Failed to credit winners', e);
  }

  // teardown poll
  delete POLLS[pollId];

  res.json({ ok: true, choiceIdx });
});

// Accept a direct vote (for testing or server-forwarded messages)
// body { pollId, username, text }
app.post('/api/poll/vote', (req, res) => {
  const body = req.body || {};
  const pollId = String(body.pollId || '').trim();
  const username = String(body.username || '').trim();
  const text = String(body.text || '').trim();
  if (!pollId || !POLLS[pollId]) return res.status(400).json({ error: 'unknown pollId' });
  const poll = POLLS[pollId];
  const idx = normalizeVoteText(text, poll.options);
  if (idx < 0) return res.json({ ok: false, reason: 'no vote parsed' });
  poll.votes.set(username, idx);
  return res.json({ ok: true });
});

// --- optional Twitch listener via tmi.js ---
try {
  const tmi = require('tmi.js');
  const BOT = process.env.TWITCH_BOT_USERNAME;
  const OAUTH = process.env.TWITCH_OAUTH; // e.g., oauth:abcd...
  const CHANNEL = process.env.TWITCH_CHANNEL; // channel name, without #

  if (BOT && OAUTH && CHANNEL) {
    const client = new tmi.Client({
      options: { debug: false },
      identity: { username: BOT, password: OAUTH },
      channels: [CHANNEL]
    });

    client.connect().then(() => console.log('TMI connected to', CHANNEL)).catch(err => console.error('TMI failed', err));

    client.on('message', (channel, tags, message, self) => {
      if (self) return;
      const username = (tags['display-name'] || tags.username || '').toString();
      const text = message.toString();

      // For all active polls, try to register the vote
      for (const [pollId, poll] of Object.entries(POLLS)) {
        const idx = normalizeVoteText(text, poll.options);
        if (idx >= 0) poll.votes.set(username, idx);
      }
    });
  }
} catch (e) {
  // tmi.js not installed or failed to load; that's OK — it's optional
}

// Increment points for a username. body: { username, delta }
app.post('/api/leaderboard/increment', (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const delta = Number.isFinite(body.delta) ? parseInt(body.delta, 10) : 0;

  if (!username) return res.status(400).json({ error: 'username required' });
  if (!delta) return res.status(400).json({ error: 'delta required' });

  const scores = readScores();
  const cur = Number.isFinite(scores[username]) ? parseInt(scores[username], 10) : 0;
  scores[username] = cur + delta;
  writeScores(scores);

  res.json({ ok: true, username, points: scores[username] });
});

// Get top N leaderboard entries
app.get('/api/leaderboard/top', (req, res) => {
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '50', 10) || 50));
  const scores = readScores();
  const arr = Object.keys(scores).map(k => ({ username: k, points: Number(scores[k]) || 0 }));
  arr.sort((a, b) => b.points - a.points);
  res.json({ data: arr.slice(0, limit) });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Leaderboard API + static server listening on http://localhost:${port}`);
});
