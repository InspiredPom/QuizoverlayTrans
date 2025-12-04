// app.js
(() => {
  // --- Config ---
  const POLL_SECONDS = 12;
  const ENABLE_CHAT_POLL = true;

  // --- Data (mutable so importer can replace/append) ---
  let QUESTIONS = [
    {
      q: "Humans use only 10% of their brains.",
      options: ["Fact", "Myth"],
      correctIndex: 1,
      explain: "Myth. Imaging shows we use virtually all parts of the brain.",
    },
    {
      q: "Drinking water helps prevent some kidney stones.",
      options: ["Fact", "Myth"],
      correctIndex: 0,
      explain: "Fact. Hydration lowers risk for common stone types.",
    },
    {
      q: "Caffeine makes drinks 'not count' toward hydration.",
      options: ["Fact", "Myth"],
      correctIndex: 1,
      explain: "Myth. Caffeine is mildly diuretic but fluids still count.",
    },
  ];

  // --- State ---
  const state = {
    score: 0,
    bossHP: 100,
    playerHP: 0,
    questionIndex: 0,
    locked: false,
    paused: false,
    pauseStartedAt: 0,
  };
  let nextQTimer = null;
  let ACTIVE = [];

  // Poll state
  let pollActive = false,
    pollEndAt = 0,
    pollTicker = null;
  let votesByUser = new Map();
  let voteCounts = [];
  let currentPollId = null;
  let hadVotesThisPoll = false;
  // --- DOM ---
  const scoreVal = document.getElementById("scoreVal");
  const qText = document.getElementById("qText");
  const answersWrap = document.getElementById("answers");
  const feedback = document.getElementById("feedback");
  const bossHpText = document.getElementById("bossHpText");
  const bossHpFill = document.getElementById("bossHpFill");
  const banner = document.getElementById("banner");
  const gremlin = document.getElementById("gremlin");
  const lidL = document.getElementById("lidL");
  const lidR = document.getElementById("lidR");
  const pollBox = document.getElementById("poll");
  const pollTimerEl = document.getElementById("pollTimer");
  const pollBars = document.getElementById("pollBars");
  const hitOverlay = document.getElementById("hitOverlay");
  const playerHpText = document.getElementById("playerHpText");
  const playerHpFill = document.getElementById("playerHpFill");
  const pauseBtn = document.getElementById("btnPause");

  // API base: if `window.API_BASE` is set (e.g. by your StreamElements widget or an inline script),
  // client calls will be prefixed with it. If empty, relative URLs are used (useful for local testing).
  const API_BASE =
    typeof window !== "undefined" && window.API_BASE
      ? String(window.API_BASE).replace(/\/$/, "")
      : "";

  // Importer DOM (optional / commented out in HTML)
  const qFile = document.getElementById("qJsonFile");
  const btnRep = document.getElementById("btnImportReplace");
  const btnApp = document.getElementById("btnImportAppend");
  const impMsg = document.getElementById("importMsg");

  // --- Helpers ---

  // 👇 Score: only ever goes UP; never down
  const setScore = (n) => {
    if (n < state.score) {
      // ignore attempts to decrease score
      n = state.score;
    }
    state.score = Math.max(0, n);
    if (scoreVal) scoreVal.textContent = state.score;
  };

  const setBossHP = (pct) => {
    state.bossHP = Math.min(100, Math.max(0, pct));
    bossHpText.textContent = Math.round(state.bossHP) + "%";
    bossHpFill.style.width = state.bossHP + "%";

    if (state.bossHP <= 0) {
      bossHpFill.style.filter = "grayscale(1)";
      gremlin.style.opacity = ".6";
      gremlin.style.filter = "grayscale(1) contrast(.9)";
    } else {
      bossHpFill.style.filter = "";
      gremlin.style.opacity = "1";
      gremlin.style.filter = "";
    }
  };

  const setPlayerHP = (pct) => {
    state.playerHP = Math.max(0, Math.min(100, pct));
    if (playerHpText)
      playerHpText.textContent = Math.round(state.playerHP) + "%";
    if (playerHpFill) playerHpFill.style.width = state.playerHP + "%";
  };

  const hideBanner = () => {
    banner.hidden = true;
    banner.className = "banner";
  };

  const showBanner = (text, type) => {
    banner.textContent = text;
    banner.className = "banner " + type;
    banner.hidden = false;
  };

  const clearTimer = () => {
    if (nextQTimer) {
      clearTimeout(nextQTimer);
      nextQTimer = null;
    }
  };

  const setButtonsDisabled = (disabled) => {
    document.querySelectorAll("#answers button").forEach((b) => {
      b.disabled = disabled;
    });
  };

  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // Ghostie face helpers
  function ghostieDefeat() {
    document.getElementById("g-eyes").style.display = "none";
    document.getElementById("g-defeat-eyes").style.display = "block";
    document.getElementById("mouth-smile").style.display = "none";
    document.getElementById("mouth-sad").style.display = "none";
    document.getElementById("mouth-defeat").style.display = "block";
  }

  function ghostieResetFace() {
    document.getElementById("g-eyes").style.display = "block";
    document.getElementById("g-defeat-eyes").style.display = "none";
    document.getElementById("mouth-smile").style.display = "block";
    document.getElementById("mouth-sad").style.display = "none";
    document.getElementById("mouth-defeat").style.display = "none";
    gremlin.style.opacity = "1";
    gremlin.style.filter = "";
    bossHpFill.style.filter = "";
  }

  // Dance toggles
  function startGhostDance() {
    gremlin.classList.add("dance");
  }
  function stopGhostDance() {
    gremlin.classList.remove("dance");
  }

  // Pause / Resume
  function setPaused(p) {
    if (state.paused === p) return;
    state.paused = p;

    if (state.paused) {
      state.pauseStartedAt = Date.now();
      clearTimer();
      setButtonsDisabled(true);
      gremlin.style.animationPlayState = "paused";
      showBanner("PAUSED", "paused");
    } else {
      const pausedDelta = Date.now() - (state.pauseStartedAt || Date.now());
      if (pollActive) pollEndAt += pausedDelta;

      setButtonsDisabled(state.locked);
      gremlin.style.animationPlayState = "running";
      hideBanner();
    }

    if (pauseBtn) pauseBtn.textContent = state.paused ? "Resume" : "Pause";
  }

  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "p") setPaused(!state.paused);
  });

  // Blink loop
  function blinkOnce() {
    lidL.style.opacity = lidR.style.opacity = 1;
    setTimeout(() => {
      lidL.style.opacity = lidR.style.opacity = 0;
    }, 120);
  }

  (function blinkLoop() {
    const t = 1800 + Math.random() * 2000;
    setTimeout(() => {
      blinkOnce();
      blinkLoop();
    }, t);
  })();

  // Impact point on ellipse (SVG viewBox 220×160)
  function randomImpactPoint() {
    const cx = 110,
      cy = 85,
      rx = 70,
      ry = 60;
    const theta = Math.random() * 2 * Math.PI;
    const r = Math.sqrt(Math.random());
    return {
      x: cx + rx * r * Math.cos(theta),
      y: cy + ry * r * Math.sin(theta),
    };
  }

  // Sparkly VFX
  function spawnSparkles(count = 18, origin = { x: 110, y: 85 }) {
    const palette = ["#ffffff", "#aee3ff", "#b7f7ff", "#d6c5ff", "#ffe7ff"];
    for (let i = 0; i < count; i++) {
      const s = document.createElement("div");
      s.className = "sparkle";
      hitOverlay.appendChild(s);

      const c = palette[Math.floor(Math.random() * palette.length)];
      s.style.boxShadow = `0 0 8px rgba(255,255,255,.9),
         0 0 18px ${c}cc,
         0 0 32px ${c}99`;

      const angle = Math.random() * 2 * Math.PI;
      const dist = 60 + Math.random() * 120;
      const tx = Math.cos(angle) * dist;
      const ty = Math.sin(angle) * dist;
      const spin = (Math.random() * 2 - 1) * 1080;
      const scale = 0.7 + Math.random() * 1.1;
      const dur = 520 + Math.random() * 420;

      s.animate(
        [
          {
            transform: `translate3d(${origin.x}px,${origin.y}px,0) translate(-50%,-50%) scale(.5) rotate(0deg)`,
            opacity: 0,
          },
          {
            transform: `translate3d(${origin.x + tx * 0.25}px,${
              origin.y + ty * 0.25
            }px,0) translate(-50%,-50%) scale(${scale}) rotate(${
              spin * 0.35
            }deg)`,
            opacity: 1,
            offset: 0.3,
          },
          {
            transform: `translate3d(${origin.x + tx}px,${
              origin.y + ty
            }px,0) translate(-50%,-50%) scale(${
              scale * 0.7
            }) rotate(${spin}deg)`,
            opacity: 0,
          },
        ],
        {
          duration: dur,
          easing: "cubic-bezier(.2,.9,.3,1)",
        }
      );

      setTimeout(() => s.remove(), dur + 80);
    }
  }

  // Donut ring VFX
  function spawnMagicRing(origin = { x: 110, y: 85 }, options = {}) {
    const {
      baseScale = 0.3,
      echo = 1,
      hue = Math.floor(180 + Math.random() * 60),
    } = options;

    for (let i = 0; i < 1 + echo; i++) {
      const ring = document.createElement("div");
      ring.className = "magic-ring";
      ring.style.setProperty("--ring", `hsl(${hue}, 90%, 70%)`);
      hitOverlay.appendChild(ring);

      const rot = (Math.random() * 2 - 1) * 22;
      const grow = 1.6 + i * 0.2;
      const dur = 440 + i * 120;

      const base = `translate3d(${origin.x}px,${origin.y}px,0) translate(-50%,-50%) rotate(${rot}deg)`;
      ring.style.transform = `${base} scale(${baseScale})`;
      ring.style.opacity = "0";

      ring.animate(
        [
          { transform: `${base} scale(${baseScale})`, opacity: 0 },
          { transform: `${base} scale(1)`, opacity: 0.95, offset: 0.28 },
          { transform: `${base} scale(${grow})`, opacity: 0 },
        ],
        {
          duration: dur,
          easing: "cubic-bezier(.2,.9,.3,1)",
          fill: "both",
        }
      );

      setTimeout(() => ring.remove(), dur + 50);
    }
  }

  // Hit & taunt
  function gremlinHit() {
    if (state.paused) return;
    gremlin.classList.add("hurt");

    const impact = randomImpactPoint();
    spawnSparkles(20, impact);
    spawnMagicRing(impact, { echo: 1 });

    gremlin.classList.add("magic-glow");
    setTimeout(() => gremlin.classList.remove("magic-glow"), 220);

    const smile = document.getElementById("mouth-smile");
    const sad = document.getElementById("mouth-sad");
    if (smile && sad) {
      smile.style.display = "none";
      sad.style.display = "block";
    }

    const pL = document.getElementById("pupilL");
    const pR = document.getElementById("pupilR");
    if (pL && pR) {
      pL.setAttribute("cy", 75);
      pR.setAttribute("cy", 75);
    }

    gremlin.animate(
      [
        { transform: "translateY(0)" },
        { transform: "translateY(-6px)" },
        { transform: "translateY(0)" },
      ],
      {
        duration: 320,
        easing: "cubic-bezier(.2,.9,.3,1)",
      }
    );

    setTimeout(() => {
      gremlin.classList.remove("hurt");
      if (state.bossHP > 0) {
        if (smile && sad) {
          smile.style.display = "block";
          sad.style.display = "none";
        }
        if (pL && pR) {
          pL.setAttribute("cy", 74);
          pR.setAttribute("cy", 74);
        }
      }
    }, 600);
  }

  function gremlinTaunt() {
    if (state.paused) return;
    gremlin.classList.add("tilt");
    setTimeout(() => gremlin.classList.remove("tilt"), 260);
  }

  // Lose flow with dance
  function losePlayer() {
    state.locked = true;
    setButtonsDisabled(true);
    stopPoll();
    ghostieResetFace();
    startGhostDance();
    showBanner("DEFEAT", "lose");
    clearTimer();
    nextQTimer = setTimeout(reset, 1800);
  }

  // --- Polling (SAFE DOM version for bars) ---
  function startPoll(options) {
    votesByUser.clear();
    voteCounts = Array.from({ length: options.length }, () => 0);
    hadVotesThisPoll = false;
    pollActive = true;
    pollEndAt = Date.now() + POLL_SECONDS * 1000;
    pollBox.hidden = false;
    renderPollBars(options);
    tickPoll();

    // create a server-side poll so the server (or tmi listener) can collect chat votes
    try {
      currentPollId = `p_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
      fetch(API_BASE + "/api/poll/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pollId: currentPollId, options }),
      }).catch(() => {
        currentPollId = null;
      });
    } catch (e) {
      currentPollId = null;
    }

    if (pollTicker) clearInterval(pollTicker);
    pollTicker = setInterval(tickPoll, 250);
  }

  function stopPoll() {
    pollActive = false;
    if (pollTicker) {
      clearInterval(pollTicker);
      pollTicker = null;
    }
    pollBox.hidden = true;
  }

  function renderPollBars(options) {
    pollBars.innerHTML = "";
    const total = Math.max(
      1,
      voteCounts.reduce((a, b) => a + b, 0)
    );

    options.forEach((label, idx) => {
      const pct = Math.round((voteCounts[idx] / total) * 100);

      const row = document.createElement("div");
      row.className = "poll-row";

      const lbl = document.createElement("span");
      lbl.className = "poll-label";
      lbl.textContent = `${idx + 1}. ${label}`;

      const bar = document.createElement("div");
      bar.className = "poll-bar";

      const fill = document.createElement("div");
      fill.className = "poll-fill";
      fill.style.width = pct + "%";
      bar.appendChild(fill);

      const pctEl = document.createElement("span");
      pctEl.className = "poll-pct";
      pctEl.textContent = pct + "%";

      row.append(lbl, bar, pctEl);
      pollBars.appendChild(row);
    });
  }

  function tickPoll() {
    if (!pollActive || state.paused) return;
    const secs = clamp(Math.ceil((pollEndAt - Date.now()) / 1000), 0, 999);
    pollTimerEl.textContent = secs;
    if (secs <= 0) {
      stopPoll();
      finishPoll();
    }
  }

  function finishPoll() {
    // Stop the ticking timer for this poll
    pollActive = false;
    if (pollTicker) {
      clearInterval(pollTicker);
      pollTicker = null;
    }

    const hadAnyVotes = hadVotesThisPoll && voteCounts.length > 0;

    // ❌ No votes at all -> treat as "no answer" and DO NOT award points
    if (!hadAnyVotes) {
      currentPollId = null;
      handleAnswer(-1); // -1 will never equal correctIndex
      return;
    }

    // ✅ There WERE votes – prefer server-side tally if we have a pollId
    if (currentPollId) {
      try {
        const item = ACTIVE[state.questionIndex];
        const correctIndex = item ? item.correctIndex : -1;

        fetch(API_BASE + "/api/poll/finish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pollId: currentPollId, correctIndex }),
        })
          .then((r) => r.json())
          .then((j) => {
            if (j && typeof j.choiceIdx === "number") {
              // Use the server-chosen "final answer" (majority choice) for visuals
              handleAnswer(j.choiceIdx);
            } else {
              // Fall back to local voteCounts-based winner
              localFinishFallback();
            }
          })
          .catch(() => {
            // Server call failed, but we KNOW we had votes
            localFinishFallback();
          });
      } catch (e) {
        localFinishFallback();
      }
    } else {
      // No server poll – just use local winner logic
      localFinishFallback();
    }

    currentPollId = null;
  }

  function localFinishFallback() {
    if (!voteCounts.length) {
      handleAnswer(-1);
      return;
    }

    const max = Math.max(...voteCounts);
    const tops = voteCounts
      .map((v, i) => (v === max ? i : -1))
      .filter((i) => i !== -1);

    const choiceIdx = tops[Math.floor(Math.random() * tops.length)];

    // No scoring logic here – handleAnswer decides correctness + points
    handleAnswer(choiceIdx);
  }

  function tryRegisterVote(user, text, options) {
    if (!pollActive || state.paused) return;
    if (!user || !text) return;

    const raw = String(text).trim();
    const lower = raw.toLowerCase();
    let idx = -1;

    // "!vote <n>" for any number of options
    const m = lower.match(/^!vote\s*(\d{1,2})\b/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= options.length) idx = n - 1;
    }

    // aliases: !fact / !myth map to labels (case-insensitive)
    if (idx === -1) {
      const norm = options.map((o) => String(o).toLowerCase());
      if (/^!fact\b/.test(lower)) idx = norm.indexOf("fact");
      else if (/^!myth\b/.test(lower)) idx = norm.indexOf("myth");
    }

    if (idx < 0 || idx >= options.length) return;

    // ✅ we got at least one valid vote this poll
    hadVotesThisPoll = true;

    const prev = votesByUser.get(user);
    if (prev === undefined) {
      voteCounts[idx]++;
      votesByUser.set(user, idx);
    } else if (prev !== idx) {
      voteCounts[prev]--;
      voteCounts[idx]++;
      votesByUser.set(user, idx);
    }

    // Forward the vote to server-side poll collector (best-effort)
    try {
      if (currentPollId) {
        fetch(API_BASE + "/api/poll/vote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pollId: currentPollId, username: user, text }),
        }).catch(() => {});
      }
    } catch (e) {}

    renderPollBars(options);
  }

  // --- Socket.IO: receive Twitch chat forwarded from server.js ---
  (function initSocket() {
    try {
      if (typeof io === "undefined") {
        console.warn(
          "Socket.IO client not found (no /socket.io/socket.io.js?)"
        );
        return;
      }

      const socket = io();

      socket.on("connect", () => {
        console.log("Socket.IO connected:", socket.id);
      });

      socket.on("chatMessage", (payload) => {
        if (!payload) return;
        const username = (payload.username || "").toString();
        const text = (payload.text || "").toString();
        if (!username || !text) return;

        // remember last chat user for scoring in handleAnswer()
        try {
          window.__lastChatEvent = {
            displayName: username,
            text,
          };
        } catch (e) {}

        // feed this into the existing vote logic
        const item = ACTIVE[state.questionIndex];
        if (item) {
          tryRegisterVote(username, text, item.options);
        }
      });
    } catch (e) {
      console.error("Socket.IO init failed:", e);
    }
  })();

  // --- Render & Logic ---
  function renderQuestion() {
    if (!ACTIVE || !ACTIVE.length) ACTIVE = shuffle(QUESTIONS);
    if (state.questionIndex >= ACTIVE.length) state.questionIndex = 0;

    const item = ACTIVE[state.questionIndex];
    if (!item) return;

    qText.textContent = item.q;
    answersWrap.innerHTML = "";
    feedback.textContent = "";

    item.options.forEach((label, idx) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.addEventListener("click", () => handleAnswer(idx));
      answersWrap.appendChild(btn);
    });

    if (ENABLE_CHAT_POLL) {
      startPoll(item.options);
    }
  }

  function handleAnswer(choiceIdx) {
    if (state.locked || state.paused) return;
    clearTimer();
    stopPoll();

    const item = ACTIVE[state.questionIndex];
    if (!item) {
      reset();
      return;
    }

    const btns = [...answersWrap.querySelectorAll("button")];
    const correct = choiceIdx === item.correctIndex;

    btns.forEach((b, i) => {
      b.classList.toggle("correct", i === item.correctIndex);
      if (i === choiceIdx && !correct) b.classList.add("wrong");
      b.disabled = true;
    });

    if (correct) {
      stopGhostDance();
      gremlinHit();
      setScore(state.score + 1); // ✅ score only goes UP here
      // Best-effort: attribute the point to the last chat user (if available)
      // try {
      //   const last = window.__lastChatEvent || null;
      //   const userFromEvent =
      //     last && (last.displayName || last.nick || last.username || last.user);
      //   const username = (userFromEvent || "").toString().trim();
      //   if (username) {
      //     fetch(API_BASE + "/api/leaderboard/increment", {
      //       method: "POST",
      //       headers: { "Content-Type": "application/json" },
      //       body: JSON.stringify({ username, delta: 1 }),
      //     }).catch(() => {});
      //   }
      // } catch (e) {}

      setBossHP(state.bossHP - 25);
      setPlayerHP(state.playerHP - 10);
      feedback.style.color = "#bbf7d0";
      feedback.textContent = `Correct! ${item.explain}`;

      if (state.bossHP <= 0) {
        state.locked = true;
        setButtonsDisabled(true);
        ghostieDefeat();
        showBanner("YOU WIN!", "win");
        clearTimer();
        nextQTimer = setTimeout(reset, 1400);
        return;
      }
    } else {
      gremlinTaunt();
      // ❌ no score subtraction on wrong answers
      setBossHP(Math.min(100, state.bossHP + 10));
      setPlayerHP(state.playerHP + 25);
      feedback.style.color = "#fecaca";
      feedback.textContent = `Wrong. ${item.explain}`;

      if (state.playerHP >= 100) {
        losePlayer();
        return;
      }
    }

    nextQTimer = setTimeout(() => {
      if (state.paused) return;
      state.questionIndex++;
      renderQuestion();
    }, 1700);
  }

  function reset() {
    clearTimer();
    hideBanner();
    stopPoll();
    stopGhostDance();

    state.locked = false;
    setBossHP(100);
    setPlayerHP(0);
    // NOTE: score is NOT reset here — Brain-Bloopers defeated is a running total

    ACTIVE = shuffle(QUESTIONS);
    state.questionIndex = 0;
    feedback.textContent = "";
    ghostieResetFace();
    renderQuestion();
  }

  // Dev Buttons
  document.getElementById("btnCorrect").onclick = () => {
    if (state.paused) return;
    const item = ACTIVE[state.questionIndex];
    handleAnswer(item.correctIndex);
  };

  document.getElementById("btnWrong").onclick = () => {
    if (state.paused) return;
    const item = ACTIVE[state.questionIndex];
    const wrongIdx = item.correctIndex === 0 ? 1 : 0;
    handleAnswer(wrongIdx);
  };

  document.getElementById("btnWin").onclick = () => {
    if (state.paused) return;
    state.locked = true;
    setButtonsDisabled(true);
    stopGhostDance();
    ghostieDefeat();
    showBanner("YOU WIN!", "win");
    clearTimer();
    nextQTimer = setTimeout(reset, 1200);
  };

  document.getElementById("btnLose").onclick = () => {
    if (state.paused) return;
    losePlayer();
  };

  document.getElementById("btnReset").onclick = reset;

  if (pauseBtn) {
    pauseBtn.onclick = () => setPaused(!state.paused);
    pauseBtn.textContent = "Pause";
  }

  // StreamElements Hook
  try {
    window.addEventListener("onEventReceived", function (obj) {
      const d = obj && obj.detail;
      if (!d) return;
      if (d.listener === "message") {
        const ev = d.event || d.data || {};
        const data = ev.data || ev;
        const text = (data.text || data.message || "").toString();
        const user = (
          data.displayName ||
          data.nick ||
          data.username ||
          data.user ||
          ""
        ).toString();
        // Store last chat event for attribution when a correct answer gets registered
        try {
          window.__lastChatEvent = data;
        } catch (e) {}
        const item = ACTIVE[state.questionIndex];
        if (item) tryRegisterVote(user, text, item.options);
      }
    });
  } catch (e) {}

  // Fake chat harness for CodePen (optional)
  let SIM_TIMER = null;
  const FAKE_NAMES = Array.from(
    { length: 200 },
    (_, i) => `Viewer_${(i + 1).toString().padStart(3, "0")}`
  );
  const CMDS = ["!vote 1", "!vote 2", "!fact", "!myth"];

  function fakeVoteOnce() {
    if (!pollActive || state.paused) return;
    const name = FAKE_NAMES[Math.floor(Math.random() * FAKE_NAMES.length)];
    const text = CMDS[Math.floor(Math.random() * CMDS.length)];
    window.dispatchEvent(
      new CustomEvent("onEventReceived", {
        detail: {
          listener: "message",
          event: { data: { text, displayName: name } },
        },
      })
    );
  }

  function startFakeVotes(ratePerSec) {
    stopFakeVotes();
    const interval = Math.max(1, Math.floor(1000 / Math.max(1, ratePerSec)));
    SIM_TIMER = setInterval(fakeVoteOnce, interval);
  }

  function stopFakeVotes() {
    if (SIM_TIMER) {
      clearInterval(SIM_TIMER);
      SIM_TIMER = null;
    }
  }

  (function initSim() {
    const startBtn = document.getElementById("btnSimStart");
    const stopBtn = document.getElementById("btnSimStop");
    const rate = document.getElementById("simRate");
    const rateVal = document.getElementById("simRateVal");

    if (!startBtn || !rate || !rateVal || !stopBtn) return;

    rate.addEventListener("input", () => {
      rateVal.textContent = rate.value + "/s";
      if (SIM_TIMER) startFakeVotes(parseInt(rate.value, 10));
    });

    startBtn.onclick = () => startFakeVotes(parseInt(rate.value, 10));
    stopBtn.onclick = () => stopFakeVotes();
  })();

  // ---- Safe JSON Import (client-only) ----
  function setImpMsg(msg, ok = true) {
    if (!impMsg) return;
    impMsg.style.color = ok ? "#059669" : "#b91c1c";
    impMsg.textContent = msg;
  }

  function normalizeItem(raw) {
    if (!raw || typeof raw !== "object") throw new Error("Not an object");

    const q = String(raw.q ?? raw.question ?? "").trim();
    let options = raw.options;

    if (typeof options === "string") {
      options = options
        .split(/[|,]/g)
        .map((s) => s.trim())
        .filter(Boolean);
    }

    if (!Array.isArray(options))
      throw new Error("options must be an array or comma string");
    options = options.map((o) => String(o).trim()).filter(Boolean);

    let correctIndex = Number.isInteger(raw.correctIndex)
      ? raw.correctIndex
      : -1;
    if (correctIndex < 0) {
      const label = String(raw.correct ?? "")
        .trim()
        .toLowerCase();
      if (label) {
        const idx = options.findIndex((o) => o.toLowerCase() === label);
        if (idx !== -1) correctIndex = idx;
      }
    }

    const explain = String(raw.explain ?? raw.explanation ?? "").trim();

    if (!q || q.length < 4 || q.length > 300) throw new Error("bad question");
    if (options.length < 2 || options.length > 6)
      throw new Error("2–6 options");
    if (options.some((o) => o.length > 80)) throw new Error("option too long");
    if (correctIndex < 0 || correctIndex >= options.length)
      throw new Error("bad correct");
    if (!explain || explain.length > 300) throw new Error("bad explanation");

    return { q, options, correctIndex, explain };
  }

  async function importFromFile(mode) {
    // 'replace' | 'append'
    const file = qFile?.files?.[0];
    if (!file) return setImpMsg("Choose a .json file first", false);
    if (file.type && !/json/i.test(file.type))
      return setImpMsg("File must be JSON", false);
    if (file.size > 500_000) return setImpMsg("File too large (>500KB)", false);

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error("Expected a JSON array");
      if (data.length > 500) throw new Error("Too many questions (>500)");

      const items = [];
      let ok = 0,
        bad = 0;

      for (const raw of data) {
        try {
          items.push(normalizeItem(raw));
          ok++;
        } catch {
          bad++;
        }
      }

      if (!ok) return setImpMsg("No valid questions found.", false);

      if (mode === "replace") QUESTIONS = items;
      else QUESTIONS = QUESTIONS.concat(items);

      setImpMsg(`Imported ${ok} item(s)${bad ? `, ${bad} skipped` : ""}.`);
      reset();
    } catch (e) {
      setImpMsg("Import failed: " + (e.message || "invalid JSON"), false);
    }
  }

  if (btnRep) btnRep.onclick = () => importFromFile("replace");
  if (btnApp) btnApp.onclick = () => importFromFile("append");

  // Start
  reset();
})();
