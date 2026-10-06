/* =========================================================
   lan.js — online multiplayer over WebRTC (PeerJS).

   The HOST is the single source of truth:
     - it picks the answer and never sends it until the round ends;
     - guests send each guess, the host scores it and replies;
     - the host measures time and awards points.
   So a guest cannot read the answer or fake a result.

   The same callbacks fire for host and guests, so the UI code
   does not need to care which role it is:
     onState(state)      lobby / scoreboard snapshot
     onRound(msg)        a round started (or was restored after rejoin)
     onRoundEnd(msg)     round results + the answer
     onEnd(msg)          final results
     onConnection(kind)  "lost" | "hostGone" (guests only)
     onKicked()
   ========================================================= */
window.LAN = (function () {
  const PREFIX = "wlx-";
  const MAX_PLAYERS = 12;
  const MAX_TEAMS = 8;
  const NAME_MAX = 16;
  const TEAM_MAX = 14;
  const NEXT_ROUND_MS = 5000; // pause on the round results
  const REVEAL_MS = 1900; // let the last tile flip finish first
  const GRACE_MS = 1500; // network slack after the timer hits zero
  const PING_MS = 3000;
  const DEAD_MS = 45000; // patient: a phone whose screen went off should not be dropped at once
  const OPEN_TIMEOUT_MS = 15000;
  const GUESS_TIMEOUT_MS = 8000;
  const MAX_FAILS_PER_MIN = 8;
  const RESUME_MS = 7000; // pause before the next word after a new host takes over
  const QUIET_MS = 9000; // no word from the host for this long: tell the player it is away
  const HINTS_PER_ROUND = 3;
  const HINT_REMOVE_COUNT = 3; // letters greyed out by one "remove letters" hint

  const COLORS = ["#e3553f", "#3a6df0", "#4ea84e", "#d6a23a", "#9b59b6", "#1abc9c"];
  const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

  let role = null; // null | "host" | "guest"
  let cb = {};
  let peer = null;
  let mode = "online"; // "online" (PeerJS over the internet) | "local" (same Wi-Fi, no internet)
  let myId = null;
  let view = null; // last state snapshot
  let pingHandle = null;

  // Host state
  let roomId = null;
  let roomPass = "";
  let players = []; // {id,name,team,isHost,conn,token,connected,lastSeen,score,roundsWon,r}
  let teams = [];
  let cfg = { rounds: 3, timer: 0 };
  let match = null;
  let fails = [];
  // The player who created the room. While they are in the room they hold the host
  // controls, even if the room itself is now running on another player's device.
  let ownerId = null;
  let ownerName = "";
  let chatLog = []; // last messages, replayed to players who join or rejoin

  // Guest state
  let conn = null;
  let session = null; // { roomId, password, name, token }
  let lastSeen = 0;
  let seq = 0;
  const waiting = new Map(); // seq -> resolve
  let leaving = false;
  let handover = false; // the host said goodbye: the next player takes over at once
  let rejoinFails = 0; // failed attempts to get back since the connection was lost
  let hostQuiet = false; // the host has stopped answering (app in the background?)

  /* ===================== Helpers ===================== */

  function randomString(n, alphabet) {
    const out = [];
    const buf = new Uint32Array(n);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(buf);
    else for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 4294967296);
    for (let i = 0; i < n; i++) out.push(alphabet[buf[i] % alphabet.length]);
    return out.join("");
  }
  function generateRoomId() {
    return randomString(6, ID_ALPHABET);
  }
  function generatePassword() {
    return randomString(4, "23456789");
  }
  function cleanRoomId(input) {
    return String(input || "")
      .trim()
      .toUpperCase()
      .replace(/^WLX-?/, "")
      .replace(/[^A-Z0-9-]/g, "")
      .slice(0, 12);
  }
  function fullPeerId(id) {
    return PREFIX + cleanRoomId(id).toLowerCase();
  }

  function teamColor(i) {
    if (i < COLORS.length) return COLORS[i];
    const j = i - COLORS.length;
    const hue = (j * 137.508) % 360;
    return `hsl(${hue.toFixed(1)} ${62 + (j % 3) * 8}% ${48 + (j % 2) * 8}%)`;
  }
  /** First palette colour no current team is using. */
  function nextTeamColor(list) {
    const used = new Set(list.map((t) => t.color));
    for (let i = 0; i < 64; i++) if (!used.has(teamColor(i))) return teamColor(i);
    return teamColor(list.length);
  }
  function defaultTeams() {
    return [
      { name: "Red", color: COLORS[0] },
      { name: "Blue", color: COLORS[1] },
    ];
  }
  function sanitizeTeams(list) {
    const out = (Array.isArray(list) ? list : []).slice(0, MAX_TEAMS).map((t, i) => ({
      name: Rules.cleanText(t && t.name, TEAM_MAX) || `Team ${i + 1}`,
      color: Rules.safeColor(t && t.color),
    }));
    return out.length ? out : defaultTeams();
  }
  function sanitizeCfg(c) {
    const rounds = parseInt(c && c.rounds, 10);
    const timer = parseInt(c && c.timer, 10);
    return {
      rounds: Math.max(1, Math.min(10, Number.isFinite(rounds) ? rounds : 3)),
      timer: Math.max(0, Math.min(600, Number.isFinite(timer) ? timer : 0)),
    };
  }

  function send(c, obj) {
    try {
      if (c && c.open) c.send(JSON.stringify(obj));
    } catch (e) {
      /* connection is going away */
    }
  }
  function parse(raw) {
    if (raw && typeof raw === "object") return raw;
    try {
      const o = JSON.parse(raw);
      return o && typeof o === "object" ? o : null;
    } catch (e) {
      return null;
    }
  }
  function safeClose(c) {
    try {
      if (c) c.close();
    } catch (e) {
      /* ignore */
    }
  }
  function fire(name, arg) {
    if (cb[name]) {
      try {
        cb[name](arg);
      } catch (e) {
        console.error(e);
      }
    }
  }

  /** PeerJS is loaded only when multiplayer is used. */
  let libPromise = null;
  function ensurePeerLib() {
    if (window.Peer) return Promise.resolve();
    if (libPromise) return libPromise;
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "./vendor/peerjs.min.js";
      s.onload = () => resolve();
      s.onerror = () => {
        libPromise = null;
        reject(new Error("Could not load multiplayer"));
      };
      document.head.appendChild(s);
    });
    return libPromise;
  }

  let lastTick = 0;

  function startHeartbeat() {
    stopHeartbeat();
    lastTick = Date.now();
    pingHandle = setInterval(() => {
      const now = Date.now();
      // If this tick is very late, this phone's own timers were paused (app minimised or
      // screen off). Its clock says nothing about the others, so start the count again
      // instead of declaring everyone lost.
      const gap = now - lastTick;
      lastTick = now;
      if (gap > PING_MS * 3) return wake(gap);
      if (role === "host") {
        players.forEach((p) => {
          if (p.isHost || !p.connected) return;
          if (now - p.lastSeen > DEAD_MS) {
            const c = p.conn;
            onPlayerGone(p);
            safeClose(c);
          } else send(p.conn, { type: "ping" });
        });
      } else if (role === "guest" && conn) {
        if (now - lastSeen > DEAD_MS) handleLost();
        else {
          send(conn, { type: "ping" });
          if (!hostQuiet && now - lastSeen > QUIET_MS) {
            hostQuiet = true;
            fire("onConnection", "hostAway");
          }
        }
      }
    }, PING_MS);
  }

  /** Called when the app comes back to the front, or its timers resume after a pause. */
  function wake(gap) {
    const now = Date.now();
    if (!gap) gap = now - lastTick;
    lastTick = now;
    if (role === "host") {
      // Online rooms: get back onto the pairing server so players can join and rejoin.
      if (mode === "online" && peer && peer.disconnected && !peer.destroyed) {
        try {
          peer.reconnect();
        } catch (e) {
          /* ignore */
        }
      }
      // Away for a long time: the players may have moved on with a new host.
      if (gap > DEAD_MS && mode === "local" && players.length > 1) lookForNewHost();
      // The host's phone was asleep, so nobody could get a guess checked. Give that time
      // back to a timed round instead of ending it the moment the host returns.
      if (gap > PING_MS * 3 && match && match.active && match.endsAt) {
        match.endsAt += gap;
        match.startedAt += gap;
        clearTimeout(match.deadlineT);
        match.deadlineT = setTimeout(onDeadline, Math.max(0, match.endsAt - now) + GRACE_MS);
        players.forEach((p) => {
          if (p.isHost) fire("onRound", roundMsg(p));
          else if (p.connected) send(p.conn, roundMsg(p));
        });
      }
      players.forEach((p) => {
        if (!p.isHost && p.connected) {
          p.lastSeen = now;
          send(p.conn, { type: "ping" });
        }
      });
      emitState();
    } else if (role === "guest") {
      lastSeen = now;
      if (conn && conn.open)
        send(conn, { type: "sync" }); // refresh scores and the board
      else if (conn) handleLost(); // the link really dropped while away: rejoin now
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && role) wake();
    });
    window.addEventListener("online", () => role && wake());
  }

  function stopHeartbeat() {
    if (pingHandle) clearInterval(pingHandle);
    pingHandle = null;
  }

  /* ===================== HOST ===================== */

  function hostOpen(opts) {
    reset();
    const local = opts.mode === "local";
    mode = local ? "local" : "online";
    const id = cleanRoomId(opts.roomId);
    const pass = Rules.cleanText(opts.password, 12);
    if (!id) return Promise.reject(new Error("Enter a Room ID"));
    if (!pass) return Promise.reject(new Error("Enter a password"));
    return (local ? Promise.resolve() : ensurePeerLib()).then(
      () =>
        new Promise((resolve, reject) => {
          const p = local ? new LocalNet.HostPeer() : new Peer(fullPeerId(id), { debug: 0 });
          let settled = false;
          const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
              p.destroy();
            } catch (e) {
              /* ignore */
            }
            reject(
              new Error(
                local
                  ? "Could not start the room on this device."
                  : "Could not reach the pairing server. Check your internet.",
              ),
            );
          }, OPEN_TIMEOUT_MS);

          p.on("open", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            role = "host";
            peer = p;
            roomId = id;
            roomPass = pass;
            myId = "host";
            teams = sanitizeTeams(opts.teams);
            cfg = sanitizeCfg(opts.cfg);
            ownerId = "host";
            ownerName = Rules.cleanText(opts.name, NAME_MAX) || "Host";
            players = [
              {
                id: "host",
                name: Rules.cleanText(opts.name, NAME_MAX) || "Host",
                team: 0,
                isHost: true,
                connected: true,
                score: 0,
                roundsWon: 0,
                r: null,
              },
            ];
            p.on("connection", onIncoming);
            startHeartbeat();
            emitState();
            resolve({ roomId: id, password: pass });
          });
          p.on("disconnected", () => {
            // Lost the pairing server (existing players stay connected). Try to get back
            // so new players can still join.
            if (peer === p && !p.destroyed) setTimeout(() => peer === p && p.reconnect(), 2000);
          });
          p.on("error", (err) => {
            if (settled) return onHostPeerError(p, err);
            settled = true;
            clearTimeout(timeout);
            try {
              p.destroy();
            } catch (e) {
              /* ignore */
            }
            const t = String((err && (err.type || err.message)) || "");
            if (/no-network/.test(t))
              reject(new Error("Connect to Wi-Fi or turn on your hotspot first."));
            else if (local) reject(new Error("Could not start the room on this device."));
            else if (/unavailable-id|taken/i.test(t))
              reject(new Error("That Room ID is taken. Try another."));
            else reject(new Error("Could not open the room. Check your internet."));
          });
        }),
    );
  }

  function onIncoming(c) {
    let player = null;
    const timeout = setTimeout(() => {
      if (!player) safeClose(c);
    }, 6000);
    c.on("data", (raw) => {
      const msg = parse(raw);
      if (!msg || typeof msg.type !== "string") return;
      if (!player) {
        if (msg.type === "who") {
          // A phone on the same network is looking for rooms. Never includes the password.
          send(c, {
            type: "room",
            roomId,
            hostName: (hostPlayer() || {}).name || "Host",
            players: players.filter((p) => p.connected).length,
            max: MAX_PLAYERS,
            inMatch: !!match,
          });
          return void setTimeout(() => safeClose(c), 300);
        }
        if (msg.type !== "join") return safeClose(c);
        player = handleJoin(c, msg);
        if (player) clearTimeout(timeout);
        return;
      }
      if (player.conn !== c) return; // replaced by a newer connection
      player.lastSeen = Date.now();
      handleGuestMsg(player, msg);
    });
    c.on("close", () => {
      if (player && player.conn === c) onPlayerGone(player);
    });
    c.on("error", () => {});
  }

  function deny(c, reason) {
    send(c, { type: "denied", reason });
    setTimeout(() => safeClose(c), 200);
    return null;
  }

  function smallestTeam() {
    let best = 0;
    let bestCount = Infinity;
    teams.forEach((t, i) => {
      const n = players.filter((p) => p.team === i).length;
      if (n < bestCount) {
        best = i;
        bestCount = n;
      }
    });
    return best;
  }

  function handleJoin(c, msg) {
    const now = Date.now();
    fails = fails.filter((t) => now - t < 60000);
    if (fails.length >= MAX_FAILS_PER_MIN)
      return deny(c, "Too many wrong attempts. Wait a minute.");
    if (String(msg.password || "") !== roomPass) {
      fails.push(now);
      return deny(c, "Wrong password");
    }
    const token = typeof msg.token === "string" && msg.token.length >= 8 ? msg.token : null;
    let p = token ? players.find((x) => x.token === token) : null;
    if (!p && typeof msg.pid === "string") {
      // The room moved to a new host, who knows the players only by their id.
      // Only an offline seat can be taken back.
      p = players.find((x) => x.id === msg.pid && !x.isHost && !x.connected && !x.token) || null;
      if (p) {
        p.token = token;
        p.name = Rules.cleanText(msg.name, NAME_MAX) || p.name;
      }
    }
    if (!p && match) {
      // Someone who left mid-match (or refreshed the page) and came back under the same
      // name gets their old seat back: score, team and this round's guesses.
      // Only an offline seat can be reclaimed, never one that is still connected.
      const wanted = (Rules.cleanText(msg.name, NAME_MAX) || "Player").toLowerCase();
      p = players.find((x) => !x.isHost && !x.connected && x.name.toLowerCase() === wanted) || null;
      if (p) p.token = token;
    }
    // The room's creator coming back under their own name gets the host controls again.
    const returningOwner =
      !!ownerName &&
      (Rules.cleanText(msg.name, NAME_MAX) || "").toLowerCase() === ownerName.toLowerCase() &&
      !players.some((x) => x.id === ownerId && x.connected);
    if (p) {
      // A known player coming back (dropped connection / app was backgrounded).
      const old = p.conn;
      p.conn = c;
      p.connected = true;
      p.lastSeen = now;
      if (old && old !== c) safeClose(old);
      if (match && match.active && p.r && !p.r.done) match.pending.add(p.id);
    } else {
      if (players.length >= MAX_PLAYERS) return deny(c, "Room is full");
      p = {
        id: "p" + randomString(6, "abcdefghijklmnopqrstuvwxyz0123456789"),
        name: Rules.cleanText(msg.name, NAME_MAX) || "Player",
        team: smallestTeam(),
        isHost: false,
        conn: c,
        token,
        connected: true,
        lastSeen: now,
        score: 0,
        roundsWon: 0,
        r: null, // joins the match from the next round
      };
      players.push(p);
    }
    if (returningOwner) ownerId = p.id;
    send(c, { type: "hello", you: { id: p.id } });
    send(c, { type: "chatLog", items: chatFor(p) });
    emitState();
    if (match && match.active) send(c, roundMsg(p));
    return p;
  }

  function handleGuestMsg(p, msg) {
    switch (msg.type) {
      case "ping":
        break;
      case "setName":
        p.name = Rules.cleanText(msg.name, NAME_MAX) || "Player";
        if (p.id === ownerId) ownerName = p.name;
        emitState();
        break;
      case "admin":
        // Host controls used by the room's creator from a device that is not running the room.
        if (p.id !== adminId()) break;
        if (msg.cmd === "start") hostStartMatch();
        else if (msg.cmd === "config") hostSetConfig(msg.arg);
        else if (msg.cmd === "kick") hostKick(msg.arg);
        else if (msg.cmd === "removeTeam") hostRemoveTeam(msg.arg);
        else if (msg.cmd === "endRound") endRound();
        break;
      case "chooseTeam":
        hostChooseTeam(p, msg.team);
        break;
      case "renameTeam":
        hostRenameTeam(msg.i, msg.name);
        break;
      case "addTeam":
        hostAddTeam();
        break;
      case "guess": {
        const res = submitGuessFor(p, msg.guess);
        send(p.conn, Object.assign({ type: "guessResult", seq: msg.seq }, res));
        if (res.result) afterGuess();
        break;
      }
      case "hint": {
        const res = hintFor(p, msg.kind);
        send(p.conn, Object.assign({ type: "hintResult", seq: msg.seq }, res));
        if (res.letters) emitState();
        break;
      }
      case "sync":
        send(p.conn, Object.assign({ type: "state" }, snapshot()));
        if (match && match.active) send(p.conn, roundMsg(p));
        break;
      case "chat":
        hostChat(p, msg.text);
        break;
      case "leave": {
        // During a match the seat is kept (offline) so the score survives a mistaken exit.
        const c = p.conn;
        onPlayerGone(p);
        setTimeout(() => safeClose(c), 200);
        break;
      }
      default:
        break;
    }
  }

  function onPlayerGone(p) {
    if (!players.includes(p)) return;
    p.connected = false;
    p.conn = null;
    if (!match) {
      players = players.filter((x) => x !== p);
    } else if (match.active) {
      // Don't make everyone wait for someone who is offline.
      match.pending.delete(p.id);
      checkRoundDone();
    }
    emitState();
  }

  function removePlayer(p) {
    if (!players.includes(p) || p.isHost) return;
    const c = p.conn;
    p.conn = null;
    players = players.filter((x) => x !== p);
    if (match && match.active) {
      match.pending.delete(p.id);
      checkRoundDone();
    }
    setTimeout(() => safeClose(c), 200);
    emitState();
  }

  function hostKick(id) {
    const p = players.find((x) => x.id === id);
    if (!p || p.isHost) return;
    send(p.conn, { type: "kicked" });
    removePlayer(p);
  }

  function hostChooseTeam(p, team) {
    const i = parseInt(team, 10);
    if (match || !(i >= 0 && i < teams.length)) return;
    p.team = i;
    emitState();
  }
  function hostRenameTeam(i, name) {
    i = parseInt(i, 10);
    if (match || !teams[i]) return;
    const nm = Rules.cleanText(name, TEAM_MAX);
    if (!nm) return;
    teams[i].name = nm;
    emitState();
  }
  function hostAddTeam() {
    if (match || teams.length >= MAX_TEAMS) return;
    teams.push({ name: `Team ${teams.length + 1}`, color: nextTeamColor(teams) });
    emitState();
  }
  function hostRemoveTeam(i) {
    i = parseInt(i, 10);
    if (match || !(i >= 0 && i < teams.length) || teams.length <= 1) return;
    teams.splice(i, 1);
    players.forEach((p) => {
      if (p.team === i) p.team = 0;
      else if (p.team > i) p.team -= 1;
    });
    emitState();
  }

  /* ---------- Snapshots ---------- */

  function pub(p) {
    let status = "waiting";
    if (p.r) status = p.r.done ? (p.r.won ? "won" : "lost") : "playing";
    return {
      id: p.id,
      name: p.name,
      team: p.team,
      isHost: p.id === adminId(), // holds the host controls
      isServer: !!p.isHost, // the room runs on this player's device
      connected: !!p.connected,
      score: p.score,
      roundsWon: p.roundsWon,
      solveTries: p.solveTries || 0,
      solveMs: p.solveMs || 0,
      tries: p.r ? p.r.guesses.length : 0,
      status,
      gained: p.r && p.r.done ? p.r.points || 0 : 0,
      hints: p.r ? p.r.hintCost : 0,
    };
  }

  function teamScores() {
    return teams
      .map((t, i) => {
        const members = players.filter((p) => p.team === i);
        return {
          id: i,
          name: t.name,
          color: t.color,
          score: Rules.teamScore(members.map((p) => p.score)),
          members: members.length,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  function snapshot() {
    return {
      players: players.map(pub),
      teams: teams.map((t) => ({ name: t.name, color: t.color })),
      teamScores: teamScores(),
      cfg: { rounds: cfg.rounds, timer: cfg.timer },
      inMatch: !!match,
      round: match ? match.roundIndex + 1 : 0,
      total: match ? match.rounds : cfg.rounds,
      roomId,
      ownerId,
      ownerName,
    };
  }

  /** Who holds the host controls: the room's creator while present, else the device running it. */
  function adminId() {
    if (players.some((p) => p.id === ownerId && p.connected)) return ownerId;
    const h = hostPlayer();
    return h ? h.id : null;
  }

  function hostSetConfig(c) {
    if (role !== "host" || match) return;
    cfg = sanitizeCfg(Object.assign({}, cfg, c));
    emitState();
  }

  function broadcast(obj) {
    players.forEach((p) => {
      if (!p.isHost && p.connected) send(p.conn, obj);
    });
  }

  function emitState() {
    if (role !== "host") return;
    view = snapshot();
    broadcast(Object.assign({ type: "state" }, view));
    fire("onState", view);
  }

  /* ---------- Match flow ---------- */

  function clearMatchTimers() {
    if (!match) return;
    clearTimeout(match.deadlineT);
    clearTimeout(match.endT);
    clearTimeout(match.nextT);
  }

  function hostStartMatch() {
    if (role !== "host") return;
    clearMatchTimers();
    players = players.filter((p) => p.connected);
    players.forEach((p) => {
      p.score = 0;
      p.roundsWon = 0;
      p.solveTries = 0;
      p.solveMs = 0;
      p.r = null;
    });
    match = {
      rounds: cfg.rounds,
      timer: cfg.timer,
      roundIndex: -1,
      answer: null,
      used: new Set(),
      pending: new Set(),
      active: false,
      startedAt: 0,
      endsAt: 0,
      deadlineT: null,
      endT: null,
      nextT: null,
    };
    nextRound();
  }

  function nextRound() {
    if (!match) return;
    match.roundIndex += 1;
    if (match.roundIndex >= match.rounds) return endMatch();
    let answer = ANSWER_WORDS[Math.floor(Math.random() * ANSWER_WORDS.length)];
    for (let i = 0; i < 20 && match.used.has(answer); i++) {
      answer = ANSWER_WORDS[Math.floor(Math.random() * ANSWER_WORDS.length)];
    }
    match.used.add(answer);
    match.answer = answer;
    match.active = true;
    match.startedAt = Date.now();
    match.endsAt = match.timer > 0 ? match.startedAt + match.timer * 1000 : 0;
    match.pending = new Set();
    players.forEach((p) => {
      p.r = p.connected
        ? {
            guesses: [],
            results: [],
            done: false,
            won: false,
            points: 0,
            hintCost: 0,
            hints: { absent: [], present: [] },
          }
        : null;
      if (p.r) match.pending.add(p.id);
    });
    if (match.timer > 0) {
      match.deadlineT = setTimeout(onDeadline, match.timer * 1000 + GRACE_MS);
    }
    players.forEach((p) => {
      if (p.isHost) fire("onRound", roundMsg(p));
      else if (p.connected) send(p.conn, roundMsg(p));
    });
    emitState();
  }

  function roundMsg(p) {
    const r = p.r;
    return {
      type: "round",
      n: match.roundIndex + 1,
      total: match.rounds,
      timer: match.timer,
      remainingMs: match.endsAt ? Math.max(0, match.endsAt - Date.now()) : 0,
      history: r ? r.guesses.map((g, i) => ({ guess: g, result: r.results[i] })) : [],
      done: r ? r.done : true,
      won: r ? r.won : false,
      spectating: !r,
      hints: r
        ? {
            absent: r.hints.absent,
            present: r.hints.present,
            left: HINTS_PER_ROUND - r.hintCost,
            max: HINTS_PER_ROUND,
          }
        : null,
    };
  }

  /** The round timer ran out. If it is late because this phone was asleep, wake() extends it. */
  function onDeadline() {
    if (Date.now() - lastTick > PING_MS * 3) return wake();
    endRound();
  }

  /**
   * A hint costs 1 point, taken at once (the score can go below zero).
   *   "remove": greys out a few letters that are not in the word
   *   "yellow": shows one letter that is in the word, without its position
   * Returns { kind, letters, left } or { error } (an error costs nothing).
   */
  function hintFor(p, kind) {
    if (!match || !match.active) return { error: "Round is over" };
    if (!p.r) return { error: "You join from the next round" };
    if (p.r.done) return { error: "You have finished this round" };
    if (p.r.hintCost >= HINTS_PER_ROUND) return { error: "No hints left this round" };
    const tried = new Set(p.r.guesses.join(""));
    const h = p.r.hints;
    let letters;
    if (kind === "yellow") {
      const pool = Array.from(new Set(match.answer)).filter(
        (ch) => !tried.has(ch) && !h.present.includes(ch),
      );
      if (!pool.length) return { error: "You have already found every letter" };
      letters = [pool[Math.floor(Math.random() * pool.length)]];
      h.present.push(letters[0]);
    } else if (kind === "remove") {
      const pool = "abcdefghijklmnopqrstuvwxyz"
        .split("")
        .filter((ch) => !match.answer.includes(ch) && !tried.has(ch) && !h.absent.includes(ch));
      if (!pool.length) return { error: "No letters left to remove" };
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      letters = pool.slice(0, HINT_REMOVE_COUNT);
      h.absent.push(...letters);
    } else return { error: "Unknown hint" };
    p.r.hintCost += 1;
    p.score -= 1;
    return { kind, letters, left: HINTS_PER_ROUND - p.r.hintCost };
  }

  /** Score one guess. Returns { result, finished, won } or { error }. */
  function submitGuessFor(p, rawGuess) {
    if (!match || !match.active) return { error: "Round is over" };
    if (!p.r) return { error: "You join from the next round" };
    if (p.r.done) return { error: "You have finished this round" };
    const guess = String(rawGuess || "").toLowerCase();
    if (!Rules.isWordShape(guess) || !VALID_WORDS.has(guess)) return { error: "Not in word list" };
    const result = Rules.evaluate(guess, match.answer);
    p.r.guesses.push(guess);
    p.r.results.push(result);
    const won = result.every((s) => s === "correct");
    if (won || p.r.guesses.length >= Rules.ROWS) {
      p.r.done = true;
      p.r.won = won;
      const duration = Date.now() - match.startedAt;
      const earned = Rules.roundPoints(won, p.r.guesses.length, duration, match.timer);
      p.score += earned;
      p.r.points = earned - p.r.hintCost; // hint points were already taken from the score
      if (won) {
        p.roundsWon += 1;
        p.solveTries = (p.solveTries || 0) + p.r.guesses.length;
        p.solveMs = (p.solveMs || 0) + duration;
        notifyTeammates(p);
      }
      match.pending.delete(p.id);
      if (chatLog.some((m) => m.hidden)) sendChatLog(p); // catch up on the finished players' chat
    }
    return { result, finished: p.r.done, won: p.r.won };
  }

  /* ---------- Chat ---------- */

  const CHAT_MAX_LEN = 200;
  const CHAT_KEEP = 50;

  /** During a round only players who have finished it (or are watching) may chat. */
  function roundOver(p) {
    return !(match && match.active) || !p.r || p.r.done;
  }

  /**
   * The messages this player may read. What finished players say during a round stays
   * hidden from those still guessing, so nobody can pass on the word.
   */
  function chatFor(p) {
    return roundOver(p) ? chatLog : chatLog.filter((m) => !m.hidden);
  }

  /** Give a player the full chat (after they finish a round, or when the round ends). */
  function sendChatLog(p) {
    if (p.isHost) setTimeout(() => fire("onChatLog", chatFor(p)), 0);
    else if (p.connected) send(p.conn, { type: "chatLog", items: chatFor(p) });
  }

  function hostChat(p, text) {
    if (!role || !p || !roundOver(p)) return false;
    const clean = Rules.cleanText(text, CHAT_MAX_LEN);
    if (!clean) return false;
    // At most 5 messages every 6 seconds per player.
    const now = Date.now();
    p.chatTimes = (p.chatTimes || []).filter((t) => now - t < 6000);
    if (p.chatTimes.length >= 5) return false;
    p.chatTimes.push(now);
    const msg = { type: "chat", id: p.id, name: p.name, team: p.team, text: clean, ts: now };
    if (match && match.active) msg.hidden = true; // until the round ends
    chatLog.push(msg);
    if (chatLog.length > CHAT_KEEP) chatLog.shift();
    players.forEach((x) => {
      if (!roundOver(x)) return;
      if (x.isHost) fire("onChat", msg);
      else if (x.connected) send(x.conn, msg);
    });
    return true;
  }

  function sendChat(text) {
    if (role === "host") return hostChat(hostPlayer(), text);
    if (role === "guest" && conn && conn.open) {
      send(conn, { type: "chat", text: Rules.cleanText(text, CHAT_MAX_LEN) });
      return true;
    }
    return false;
  }

  /** Tell the solver's teammates who cracked it (never the word itself). */
  function notifyTeammates(solver) {
    const msg = {
      type: "solved",
      id: solver.id,
      name: solver.name,
      tries: solver.r.guesses.length,
    };
    players.forEach((p) => {
      if (p === solver || p.team !== solver.team || !p.connected) return;
      if (p.isHost) setTimeout(() => fire("onTeammateSolved", msg), 0);
      else send(p.conn, msg);
    });
  }

  /** Best player overall and the MVP of each team, for the final screen. */
  function awards() {
    const row = (p) => ({
      id: p.id,
      score: p.score,
      roundsWon: p.roundsWon,
      solveTries: p.solveTries || 0,
      solveMs: p.solveMs || 0,
    });
    const teamMvp = {};
    teams.forEach((t, i) => {
      const id = Rules.pickMvp(players.filter((p) => p.team === i).map(row));
      if (id) teamMvp[i] = id;
    });
    return { best: Rules.pickMvp(players.map(row)), teams: teamMvp };
  }

  function afterGuess() {
    emitState();
    checkRoundDone();
  }

  function checkRoundDone() {
    if (!match || !match.active || match.pending.size > 0 || match.endT) return;
    match.endT = setTimeout(endRound, REVEAL_MS);
  }

  function endRound() {
    if (!match || !match.active) return;
    match.active = false;
    clearTimeout(match.deadlineT);
    clearTimeout(match.endT);
    match.endT = null;
    players.forEach((p) => {
      if (p.r && !p.r.done) {
        p.r.done = true;
        p.r.won = false;
        p.r.points = -p.r.hintCost;
      }
    });
    if (chatLog.some((m) => m.hidden)) {
      chatLog.forEach((m) => delete m.hidden);
      players.forEach(sendChatLog);
    }
    const last = match.roundIndex + 1 >= match.rounds;
    const payload = {
      type: "roundEnd",
      round: match.roundIndex + 1,
      total: match.rounds,
      answer: match.answer,
      last,
      nextInMs: NEXT_ROUND_MS,
      players: players.map(pub),
      teamScores: teamScores(),
    };
    broadcast(payload);
    fire("onRoundEnd", payload);
    emitState();
    match.nextT = setTimeout(nextRound, NEXT_ROUND_MS);
  }

  function endMatch() {
    if (!match) return;
    clearMatchTimers();
    const payload = {
      type: "end",
      players: players.map(pub),
      teamScores: teamScores(),
      awards: awards(),
    };
    match = null;
    players = players.filter((p) => p.connected);
    players.forEach((p) => (p.r = null));
    broadcast(payload);
    fire("onEnd", payload);
    emitState();
  }

  /* ===================== GUEST ===================== */

  function guestConnect(opts) {
    reset();
    const local = opts.mode === "local";
    mode = local ? "local" : "online";
    session = {
      mode,
      roomId: cleanRoomId(opts.roomId),
      address: local ? opts.address || null : null, // host's local address, if already found
      password: Rules.cleanText(opts.password, 12),
      name: Rules.cleanText(opts.name, NAME_MAX) || "Player",
      token: randomString(20, "abcdefghijklmnopqrstuvwxyz0123456789"),
    };
    if (!session.roomId) return Promise.reject(new Error("Enter the Room ID"));
    return guestDial();
  }

  /**
   * Reconnect with the same identity (score and board are kept by the host).
   * If the host is gone, the players take over in the order they joined: the first one
   * becomes the host at once, the next one only if the first has not managed it, and so on.
   * Resolves with { host: true } when this player has become the host.
   */
  function rejoin() {
    if (!session) return Promise.reject(new Error("No room to rejoin"));
    const rank = successorRank();
    const myTurn = rank >= 0 && rejoinFails >= (handover ? rank * 2 : rank * 2 + 1);
    const dial = () =>
      guestDial().catch((err) => {
        rejoinFails += 1;
        throw err;
      });
    if (!myTurn) return dial();
    return becomeHost().then(
      () => ({ host: true }),
      () => dial(),
    );
  }

  /** My place in the line of players who may take over (0 = first). -1 = not in line. */
  function successorRank() {
    if (!view || !Array.isArray(view.players)) return -1;
    if (session && session.mode === "local" && !LocalNet.available()) return -1;
    return view.players.filter((p) => !p.isServer && p.connected).findIndex((p) => p.id === myId);
  }

  /** Open the room again on this device, carrying on from the last scores we were sent. */
  function becomeHost() {
    const s = session;
    const v = view;
    const me = myId;
    if (!s || !v || !me) return Promise.reject(new Error("Cannot take over"));
    const local = s.mode === "local";
    return (local ? Promise.resolve() : ensurePeerLib()).then(
      () =>
        new Promise((resolve, reject) => {
          const p = local ? new LocalNet.HostPeer() : new Peer(fullPeerId(s.roomId), { debug: 0 });
          let settled = false;
          const fail = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            try {
              p.destroy();
            } catch (e) {
              /* ignore */
            }
            reject(new Error("Could not take over the room"));
          };
          const timeout = setTimeout(fail, 10000);
          p.on("open", () => {
            if (settled) return;
            if (session !== s || role !== "guest") return fail();
            settled = true;
            clearTimeout(timeout);
            adoptRoom(p, s, v, me);
            p.on("connection", onIncoming);
            p.on("disconnected", () => {
              if (peer === p && !p.destroyed) setTimeout(() => peer === p && p.reconnect(), 2000);
            });
            resolve();
          });
          p.on("error", (err) => (settled ? onHostPeerError(p, err) : fail()));
        }),
    );
  }

  function adoptRoom(p, s, v, me) {
    stopHeartbeat();
    flushWaiting();
    const old = peer;
    peer = p;
    conn = null;
    if (old && old !== p) {
      try {
        old.destroy();
      } catch (e) {
        /* ignore */
      }
    }
    role = "host";
    mode = s.mode;
    roomId = s.roomId;
    roomPass = s.password;
    session = null;
    leaving = false;
    hostQuiet = false;
    handover = false;
    rejoinFails = 0;
    fails = [];
    teams = sanitizeTeams(v.teams);
    cfg = sanitizeCfg(v.cfg);
    ownerId = v.ownerId || (v.players.find((x) => x.isServer) || {}).id || null;
    ownerName = v.ownerName || "";
    chatLog = chatLog.filter((m) => !m.hidden);
    // A round that was being played cannot be finished (only the old host knew the word),
    // so it is played again with a new word and its points are taken back.
    const live = !!v.inMatch && v.players.some((x) => x.status === "playing");
    const now = Date.now();
    players = v.players
      .filter((x) => v.inMatch || x.id === me || !x.isServer) // in the lobby the old host just leaves
      .map((x) => {
        const done = x.status === "won" || x.status === "lost";
        const undo = live ? (done ? x.gained || 0 : -(x.hints || 0)) : 0;
        const wonNow = live && x.status === "won";
        return {
          id: x.id,
          name: x.name,
          team: x.team >= 0 && x.team < teams.length ? x.team : 0,
          isHost: x.id === me,
          conn: null,
          token: null,
          connected: x.id === me,
          lastSeen: now,
          score: (x.score || 0) - undo,
          roundsWon: (x.roundsWon || 0) - (wonNow ? 1 : 0),
          solveTries: (x.solveTries || 0) - (wonNow ? x.tries || 0 : 0),
          solveMs: x.solveMs || 0,
          r: null,
        };
      });
    match = null;
    if (v.inMatch) {
      match = {
        rounds: v.total,
        timer: cfg.timer,
        roundIndex: (v.round || 1) - (live ? 2 : 1),
        answer: null,
        used: new Set(),
        pending: new Set(),
        active: false,
        startedAt: 0,
        endsAt: 0,
        deadlineT: null,
        endT: null,
        nextT: null,
      };
      // Give the others a moment to find the new host before the next word.
      match.nextT = setTimeout(nextRound, RESUME_MS);
    }
    // Seats of players who never come back are cleared from the lobby.
    setTimeout(() => {
      if (peer !== p || role !== "host" || match) return;
      players = players.filter((x) => x.connected);
      emitState();
    }, 30000);
    startHeartbeat();
    emitState();
  }

  /** The host's link to the pairing server failed after the room was open. */
  function onHostPeerError(p, err) {
    if (peer !== p || role !== "host") return;
    const t = String((err && (err.type || err.message)) || "");
    // Our Room ID now belongs to someone else: the players carried on with a new host.
    if (/unavailable-id|taken/i.test(t)) stepDown();
  }

  /** Same Wi-Fi: after a long pause, see whether another phone now hosts this room. */
  function lookForNewHost() {
    const id = roomId;
    let found = false;
    LocalNet.scan({
      cancelled: () => found || role !== "host" || roomId !== id,
      onRoom: (room) => {
        if (room.roomId === id) found = true;
      },
    })
      .then(() => found && role === "host" && roomId === id && stepDown())
      .catch(() => {});
  }

  /** This device was the host, but the room moved on without it: join it as a player. */
  function stepDown() {
    const mine = hostPlayer();
    if (role !== "host" || !mine) return;
    stopHeartbeat();
    clearMatchTimers();
    session = {
      mode,
      roomId,
      address: null,
      password: roomPass,
      name: mine.name,
      token: randomString(20, "abcdefghijklmnopqrstuvwxyz0123456789"),
    };
    myId = mine.id;
    const p = peer;
    peer = null;
    conn = { open: false, close() {} }; // "was connected": lets the normal rejoin flow run
    try {
      if (p) p.destroy();
    } catch (e) {
      /* ignore */
    }
    players = [];
    match = null;
    role = "guest";
    leaving = false;
    handover = false;
    rejoinFails = 0;
    if (view) view.players = view.players.map((x) => Object.assign({}, x, { isServer: false }));
    conn = null;
    fire("onConnection", "lost");
  }

  function guestDial() {
    role = "guest";
    leaving = false;
    const s = session;
    const local = s.mode === "local";
    return (local ? Promise.resolve() : ensurePeerLib()).then(
      () =>
        new Promise((resolve, reject) => {
          const p = local ? new LocalNet.GuestPeer() : new Peer(undefined, { debug: 0 });
          let done = false;
          const fail = (text) => {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            try {
              p.destroy();
            } catch (e) {
              /* ignore */
            }
            reject(new Error(text));
          };
          const timeout = setTimeout(() => fail("Connection timed out"), OPEN_TIMEOUT_MS);

          p.on("error", (err) => {
            const t = String((err && (err.type || err.message)) || "");
            if (local) s.address = null; // look the room up again on the next try
            if (/no-network/.test(t)) fail("Connect to the host's Wi-Fi or hotspot first.");
            else if (!/peer-unavailable/i.test(t)) fail("Connection failed");
            else
              fail(
                local
                  ? "Room not found. Join the host's Wi-Fi or hotspot first."
                  : "Room not found",
              );
          });
          p.on("open", () => {
            if (done || session !== s) return fail("Cancelled");
            const c = p.connect(
              local ? { roomId: s.roomId, address: s.address } : fullPeerId(s.roomId),
              { reliable: true },
            );
            c.on("open", () => {
              send(c, {
                type: "join",
                name: s.name,
                password: s.password,
                token: s.token,
                pid: myId || undefined,
              });
            });
            c.on("data", (raw) => {
              const msg = parse(raw);
              if (!msg || typeof msg.type !== "string") return;
              if (!done) {
                if (msg.type === "denied") return fail(msg.reason || "Could not join");
                if (msg.type !== "hello" || session !== s) return;
                done = true;
                clearTimeout(timeout);
                if (peer && peer !== p) {
                  try {
                    peer.destroy();
                  } catch (e) {
                    /* ignore */
                  }
                }
                peer = p;
                conn = c;
                if (c.address) s.address = c.address; // remembered for rejoining
                myId = msg.you && msg.you.id;
                lastSeen = Date.now();
                hostQuiet = false;
                handover = false;
                rejoinFails = 0;
                startHeartbeat();
                resolve();
                return;
              }
              if (conn !== c) return;
              lastSeen = Date.now();
              if (hostQuiet) {
                hostQuiet = false;
                fire("onConnection", "hostBack");
              }
              handleHostMsg(msg);
            });
            c.on("close", () => {
              if (!done) return fail("Connection closed");
              if (conn === c) handleLost();
            });
            c.on("error", () => fail("Connection failed"));
          });
        }),
    );
  }

  function handleHostMsg(msg) {
    switch (msg.type) {
      case "state":
        view = msg;
        fire("onState", msg);
        break;
      case "round":
        fire("onRound", msg);
        break;
      case "hintResult":
      case "guessResult": {
        const resolve = waiting.get(msg.seq);
        if (resolve) {
          waiting.delete(msg.seq);
          resolve(msg);
        }
        break;
      }
      case "solved":
        fire("onTeammateSolved", msg);
        break;
      case "chat":
        chatLog.push(msg); // kept in case this player has to take over as host
        if (chatLog.length > CHAT_KEEP) chatLog.shift();
        fire("onChat", msg);
        break;
      case "chatLog":
        chatLog = Array.isArray(msg.items) ? msg.items.slice(-CHAT_KEEP) : [];
        fire("onChatLog", chatLog);
        break;
      case "handover":
        // The host left on purpose. The first player who joined becomes the host.
        handover = true;
        if (session && session.mode === "local") session.address = null;
        handleLost();
        break;
      case "roundEnd":
        fire("onRoundEnd", msg);
        break;
      case "end":
        fire("onEnd", msg);
        break;
      case "kicked": {
        const closed = msg.reason === "closed";
        reset();
        if (closed) fire("onConnection", "hostGone");
        else fire("onKicked");
        break;
      }
      default:
        break;
    }
  }

  function flushWaiting() {
    waiting.forEach((resolve) => resolve({ error: "Connection lost" }));
    waiting.clear();
  }

  function handleLost() {
    if (role !== "guest" || leaving || !conn) return;
    const c = conn;
    conn = null;
    safeClose(c);
    flushWaiting();
    fire("onConnection", "lost");
  }

  function guestSubmitGuess(guess) {
    if (!conn || !conn.open) return Promise.resolve({ error: "Not connected" });
    const id = ++seq;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        if (!waiting.has(id)) return;
        waiting.delete(id);
        // We don't know if the host counted it — ask for the true board.
        send(conn, { type: "sync" });
        resolve({ error: "No response from host" });
      }, GUESS_TIMEOUT_MS);
      waiting.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
      send(conn, { type: "guess", seq: id, guess });
    });
  }

  function guestRequestHint(kind) {
    if (!conn || !conn.open) return Promise.resolve({ error: "Not connected" });
    const id = ++seq;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        if (!waiting.has(id)) return;
        waiting.delete(id);
        send(conn, { type: "sync" }); // if the host did count it, the board will show it
        resolve({ error: "No response from host" });
      }, GUESS_TIMEOUT_MS);
      waiting.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
      send(conn, { type: "hint", seq: id, kind });
    });
  }

  /* ===================== Role-agnostic API ===================== */

  function on(handlers) {
    cb = Object.assign({}, cb, handlers);
  }

  function hostPlayer() {
    return players.find((p) => p.isHost);
  }

  function setName(name) {
    const nm = Rules.cleanText(name, NAME_MAX);
    if (role === "host") {
      hostPlayer().name = nm || "Host";
      if (myId === ownerId) ownerName = hostPlayer().name;
      emitState();
    } else if (role === "guest") {
      if (session) session.name = nm || "Player";
      send(conn, { type: "setName", name: nm });
    }
  }
  function chooseTeam(i) {
    if (role === "host") hostChooseTeam(hostPlayer(), i);
    else send(conn, { type: "chooseTeam", team: i });
  }
  function renameTeam(i, name) {
    if (role === "host") hostRenameTeam(i, name);
    else send(conn, { type: "renameTeam", i, name });
  }
  function addTeam() {
    if (role === "host") hostAddTeam();
    else send(conn, { type: "addTeam" });
  }
  /** True when this player holds the host controls (start, settings, remove players). */
  function isAdmin() {
    if (role === "host") return adminId() === myId;
    const mine = view && view.players.find((p) => p.id === myId);
    return !!(mine && mine.isHost);
  }
  function adminDo(cmd, arg, local) {
    if (!isAdmin()) return;
    if (role === "host") local();
    else send(conn, { type: "admin", cmd, arg });
  }
  function removeTeam(i) {
    adminDo("removeTeam", i, () => hostRemoveTeam(i));
  }
  function kick(id) {
    adminDo("kick", id, () => hostKick(id));
  }
  function setConfig(c) {
    adminDo("config", c, () => hostSetConfig(c));
  }
  function startMatch() {
    adminDo("start", null, hostStartMatch);
  }
  function endRoundNow() {
    adminDo("endRound", null, endRound);
  }
  function submitGuess(guess) {
    if (role === "host") {
      const res = submitGuessFor(hostPlayer(), guess);
      if (res.result) setTimeout(afterGuess, 0);
      return Promise.resolve(res);
    }
    return guestSubmitGuess(guess);
  }

  function requestHint(kind) {
    if (role === "host") {
      const res = hintFor(hostPlayer(), kind);
      if (res.letters) setTimeout(emitState, 0);
      return Promise.resolve(res);
    }
    return guestRequestHint(kind);
  }

  /** Leave / close the room and drop every connection. */
  function reset() {
    leaving = true;
    hostQuiet = false;
    stopHeartbeat();
    clearMatchTimers();
    if (role === "guest" && conn) send(conn, { type: "leave" });
    // The room does not close when the host leaves: the next player takes it over.
    if (role === "host") broadcast({ type: "handover" });
    handover = false;
    rejoinFails = 0;
    flushWaiting();
    const p = peer;
    peer = null;
    conn = null;
    if (p) {
      // Give the goodbye message a moment to flush.
      setTimeout(() => {
        try {
          p.destroy();
        } catch (e) {
          /* ignore */
        }
      }, 250);
    }
    players = [];
    teams = [];
    match = null;
    fails = [];
    chatLog = [];
    ownerId = null;
    ownerName = "";
    roomId = null;
    roomPass = "";
    role = null;
    myId = null;
    view = null;
    session = null;
  }

  return {
    on,
    reset,
    getRole: () => role,
    isAdmin,
    getMyId: () => myId,
    getView: () => view,
    getRoom: () =>
      role === "host"
        ? { roomId, password: roomPass }
        : session
          ? { roomId: session.roomId, password: session.password }
          : null,
    defaultTeams,
    sanitizeTeams,
    sanitizeCfg,
    cleanRoomId,
    getMode: () => mode,
    localAvailable: () => !!window.LocalNet && LocalNet.available(),
    findRooms: (opts) => LocalNet.scan(opts),
    generateRoomId,
    generatePassword,
    hostOpen,
    guestConnect,
    rejoin,
    setName,
    chooseTeam,
    renameTeam,
    addTeam,
    removeTeam,
    kick,
    setConfig,
    startMatch,
    endRoundNow,
    submitGuess,
    requestHint,
    sendChat,
    limits: { MAX_PLAYERS, MAX_TEAMS, NAME_MAX, TEAM_MAX },
  };
})();
