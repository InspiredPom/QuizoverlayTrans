// Load environment variables from .env
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

// Read Twitch env vars once
const BOT = process.env.TWITCH_BOT_USERNAME;
const OAUTH = process.env.TWITCH_OAUTH;
const CHANNEL = process.env.TWITCH_CHANNEL;

// Debug: show what we got from .env (token is just boolean)
console.log('TMI config:', {
  BOT,
  hasOauth: !!OAUTH,
  CHANNEL
});

// ─────────────────────────────────────────────
//           SCORE STORAGE (scores.json)
// ─────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, 'data');
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SCORES_FILE)) fs.writeFileSync(SCORES_FILE, JSON.stringify({}), 'utf8');

function readScores() {
  try {
    return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8') || '{}');
  } catch (e) {
    console.error('Failed to read scores.json:', e);
    return {};
  }
}

function writeScores(obj) {
  try {
    fs.writeFileSync(SCORES_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write scores.json:', e);
  }
}

// ─────────────────────────────────────────────
//            EXPRESS + SOCKET.IO SETUP
// ─────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// Log overlay connections
io.on('connection', socket => {
  console.log('Overlay Connected:', socket.id);
});

// Serve everything in /public as static files
//   /leaderboard.html -> public/leaderboard.html
//   /index.html       -> public/index.html
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
//                   POLLS
// ─────────────────────────────────────────────

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

// Start a poll
app.post('/api/poll/start', (req, res) => {
  const body = req.body || {};
  const pollId = String(body.pollId || '').trim();
  const options = Array.isArray(body.options) ? body.options.map(String) : null;

  if (!pollId || !options || options.length < 2) {
    return res.status(400).json({ error: 'pollId and options required' });
  }

  POLLS[pollId] = { options, votes: new Map() };
  console.log('Poll started:', pollId, options);
  return res.json({ ok: true });
});

// Finish a poll
app.post('/api/poll/finish', (req, res) => {
  const body = req.body || {};
  const pollId = String(body.pollId || '').trim();

  if (!pollId || !POLLS[pollId]) {
    return res.status(400).json({ error: 'unknown pollId' });
  }

  const poll = POLLS[pollId];
  const voteCounts = Array.from({ length: poll.options.length }, () => 0);

  for (const idx of poll.votes.values()) {
    if (Number.isInteger(idx) && idx >= 0 && idx < voteCounts.length) {
      voteCounts[idx]++;
    }
  }

  // Majority choice for boss/player HP logic
  const max = Math.max(...voteCounts);
  const tops = voteCounts
    .map((v, i) => (v === max ? i : -1))
    .filter(i => i !== -1);

  const choiceIdx = tops[Math.floor(Math.random() * tops.length)] ?? 0;
  console.log('Poll finished:', pollId, 'winner index:', choiceIdx);

  // ✅ Only award points to *correct* voters, not just majority
  const correctIndexRaw = body.correctIndex;
  let correctIndex = Number.isInteger(correctIndexRaw)
    ? correctIndexRaw
    : parseInt(correctIndexRaw, 10);

  const hasValidCorrect =
    Number.isInteger(correctIndex) &&
    correctIndex >= 0 &&
    correctIndex < poll.options.length;

  if (hasValidCorrect) {
    try {
      const scores = readScores();
      for (const [user, idx] of poll.votes.entries()) {
        if (idx === correctIndex && user) {
          const cur = Number.isFinite(scores[user]) ? Number(scores[user]) : 0;
          scores[user] = cur + 1;
        }
      }
      writeScores(scores);
    } catch (e) {
      console.error('Failed to credit winners', e);
    }
  }

  delete POLLS[pollId];

  // Client still needs the majority choice for handleAnswer()
  res.json({ ok: true, choiceIdx });
});

app.post('/api/poll/finish', (req, res) => {
  const body = req.body || {};
  const pollId = String(body.pollId || '').trim();
  let correctIndex = body.correctIndex;

  if (!pollId || !POLLS[pollId]) {
    return res.status(400).json({ error: 'unknown pollId' });
  }

  const poll = POLLS[pollId];

  // Normalize correctIndex to a valid integer
  if (!Number.isInteger(correctIndex)) {
    correctIndex = parseInt(correctIndex, 10);
  }

  const hasValidCorrect =
    Number.isInteger(correctIndex) &&
    correctIndex >= 0 &&
    correctIndex < poll.options.length;

  console.log('Poll finished:', pollId, {
    correctIndex,
    hasValidCorrect,
    votesCount: poll.votes.size
  });

  if (hasValidCorrect) {
    try {
      const scores = readScores();

      for (const [user, idx] of poll.votes.entries()) {
        if (idx === correctIndex && user) {
          const cur = Number.isFinite(scores[user]) ? Number(scores[user]) : 0;
          scores[user] = cur + 1;
        }
      }

      writeScores(scores);
    } catch (e) {
      console.error('Failed to credit winners', e);
    }
  } else {
    console.warn('No valid correctIndex provided for poll', pollId);
  }

  // Clean up this poll
  delete POLLS[pollId];

  // For the overlay visuals, just tell it "this is the final answer index"
  res.json({ ok: true, choiceIdx: hasValidCorrect ? correctIndex : 0 });
});

// app.post('/api/poll/finish', (req, res) => {
//   const body = req.body || {};
//   const pollId = String(body.pollId || '').trim();

//   if (!pollId || !POLLS[pollId]) {
//     return res.status(400).json({ error: 'unknown pollId' });
//   }

//   const poll = POLLS[pollId];
//   const voteCounts = Array.from({ length: poll.options.length }, () => 0);

//   for (const idx of poll.votes.values()) {
//     if (Number.isInteger(idx) && idx >= 0 && idx < voteCounts.length) {
//       voteCounts[idx]++;
//     }
//   }

//   const max = Math.max(...voteCounts);
//   const tops = voteCounts
//     .map((v, i) => (v === max ? i : -1))
//     .filter(i => i !== -1);

//   const choiceIdx = tops[Math.floor(Math.random() * tops.length)];
//   console.log('Poll finished:', pollId, 'winner index:', choiceIdx);

//   // Credit winners
//   try {
//     const scores = readScores();
//     for (const [user, idx] of poll.votes.entries()) {
//       if (idx === choiceIdx && user) {
//         const cur = Number.isFinite(scores[user]) ? Number(scores[user]) : 0;
//         scores[user] = cur + 1;
//       }
//     }
//     writeScores(scores);
//   } catch (e) {
//     console.error('Failed to credit winners', e);
//   }

//   delete POLLS[pollId];

//   res.json({ ok: true, choiceIdx });
// });

// Accept a direct vote via HTTP


// app.post('/api/poll/vote', (req, res) => {
//   const body = req.body || {};
//   const pollId = String(body.pollId || '').trim();
//   const username = String(body.username || '').trim();
//   const text = String(body.text || '').trim();

//   if (!pollId || !POLLS[pollId]) {
//     return res.status(400).json({ error: 'unknown pollId' });
//   }

//   const poll = POLLS[pollId];
//   const idx = normalizeVoteText(text, poll.options);

//   if (idx < 0) return res.json({ ok: false, reason: 'no vote parsed' });

//   poll.votes.set(username, idx);
//   return res.json({ ok: true });
// });

// ─────────────────────────────────────────────
//                 TWITCH CHAT (OPTIONAL)
// ─────────────────────────────────────────────

try {
  const tmi = require('tmi.js');

  if (BOT && OAUTH && CHANNEL) {
    const client = new tmi.Client({
      options: { debug: true },
      identity: { username: BOT, password: OAUTH },
      channels: [CHANNEL]
    });

    client.connect()
      .then(() => console.log('TMI connected to', CHANNEL))
      .catch(err => console.error('TMI failed', err));

    client.on('message', (channel, tags, message, self) => {
      if (self) return;

      const username = (tags['display-name'] || tags.username || '').toString();
      const text = message.toString();

      // Broadcast chat message to overlays
      io.emit('chatMessage', { username, text });

      // Count as vote if poll is active
      for (const [pollId, poll] of Object.entries(POLLS)) {
        const idx = normalizeVoteText(text, poll.options);
        if (idx >= 0) poll.votes.set(username, idx);
      }
    });
  } else {
    console.log('TMI skipped: missing BOT, OAUTH, or CHANNEL');
  }
} catch (e) {
  console.error('TMI error (tmi.js missing or failed):', e);
}

// ─────────────────────────────────────────────
//             LEADERBOARD API ROUTES
// ─────────────────────────────────────────────

// Increment points
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

// Get top N
app.get('/api/leaderboard/top', (req, res) => {
  const limit = Math.max(
    1,
    Math.min(500, parseInt(req.query.limit || '50', 10) || 50)
  );

  const scores = readScores();
  const arr = Object.keys(scores).map(k => ({
    username: k,
    points: Number(scores[k]) || 0
  }));

  arr.sort((a, b) => b.points - a.points);
  res.json({ data: arr.slice(0, limit) });
});

// ─────────────────────────────────────────────
//                    START SERVER
// ─────────────────────────────────────────────

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Leaderboard + Overlay server running at http://localhost:${port}`);
});
