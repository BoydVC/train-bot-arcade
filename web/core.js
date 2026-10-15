/* Train-a-Bot Arcade: pure deterministic game core + tabular Q-learning trainer.
   Shared by the browser (window.TBA_CORE) and Node (module.exports). */
(function (root) {
  "use strict";
  const LANES = 5;
  const ACTIONS = [-1, 0, 1];           // left, stay, right
  const ACTION_NAMES = ["Left", "Stay", "Right"];
  const R_ALIVE = 1, R_CELL = 10, R_CRASH = -100;
  const DIFFS = {
    easy:   { name: "Easy",   tps: 5.5, base: 0.16, ramp: 0.16, cell: 0.35, maxRow: 2 },
    normal: { name: "Normal", tps: 7.5, base: 0.24, ramp: 0.20, cell: 0.30, maxRow: 3 },
    hard:   { name: "Hard",   tps: 10,  base: 0.32, ramp: 0.24, cell: 0.28, maxRow: 3 },
  };
  const TRACKS = [
    { id: "neon-alley", name: "Neon Alley", seed: 1013 },
    { id: "byte-canyon", name: "Byte Canyon", seed: 2026 },
    { id: "glitch-gulch", name: "Glitch Gulch", seed: 777 },
    { id: "char-circuit", name: "Char's Circuit", seed: 212 },
    { id: "vic-velocity", name: "Vic's Velocity", seed: 623 },
  ];

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* A track is an infinite, seeded sequence of rows. Rows are generated in order,
     independent of what the player does, so a human and the bot can race the
     exact same course. A hidden "safe lane" random-walks so a path always exists. */
  class Track {
    constructor(seed, diff) {
      this.seed = seed >>> 0;
      this.diff = DIFFS[diff] ? diff : "normal";
      this.cfg = DIFFS[this.diff];
      this.rng = mulberry32(this.seed * 2654435761 + (this.diff === "easy" ? 11 : this.diff === "hard" ? 33 : 22));
      this.rows = [];
      this.safe = 2;
    }
    density(i) { return this.cfg.base + this.cfg.ramp * Math.min(1, i / 500); }
    _gen() {
      const i = this.rows.length, r = this.rng;
      const row = { obs: [0, 0, 0, 0, 0], cell: -1 };
      if (i >= 6 && i % 2 === 0) {
        const roll = r();
        if (roll < 0.33) this.safe = Math.max(0, this.safe - 1);
        else if (roll < 0.66) this.safe = Math.min(LANES - 1, this.safe + 1);
        const p = this.density(i);
        let n = 0;
        const order = [0, 1, 2, 3, 4].filter((l) => l !== this.safe);
        for (let j = order.length - 1; j > 0; j--) { const k = Math.floor(r() * (j + 1)); [order[j], order[k]] = [order[k], order[j]]; }
        for (const l of order) {
          if (n < this.cfg.maxRow && r() < p) { row.obs[l] = 1; n++; }
        }
        if (n === 0 && i > 40 && r() < 0.5) {   // never totally empty for long
          let l = Math.floor(r() * LANES); if (l === this.safe) l = (l + 2) % LANES; row.obs[l] = 1;
        }
      } else if (i >= 3 && r() < this.cfg.cell) {
        row.cell = Math.floor(r() * LANES);
      }
      this.rows.push(row);
    }
    row(i) { while (this.rows.length <= i) this._gen(); return this.rows[i]; }
  }

  /* One run of the game. step(actionIndex) advances one row. */
  class Run {
    constructor(seed, diff, cap) {
      this.track = new Track(seed, diff);
      this.lane = 2; this.t = 0; this.cells = 0; this.dead = false;
      this.cap = cap || Infinity; this.taken = new Set(); this.reward = 0;
    }
    get score() { return this.t + this.cells * 10; }
    step(ai) {
      if (this.dead) return { r: 0, done: true };
      const a = ACTIONS[ai];
      let r = R_ALIVE;
      const nl = this.lane + a;
      let event = null;
      if (nl < 0 || nl >= LANES) { r -= 2; event = "bonk"; }    // bonk the guard rail
      else if (a !== 0 && this.track.row(this.t).obs[nl]) {    // sideswipe a wall beside you
        this.lane = nl; this.dead = true; this.reward += R_CRASH;
        return { r: R_CRASH, done: true, event: "crash" };
      } else this.lane = nl;
      this.t++;
      const row = this.track.row(this.t);
      if (row.obs[this.lane]) { this.dead = true; r = R_CRASH; event = "crash"; }
      else if (row.cell === this.lane && !this.taken.has(this.t)) {
        this.taken.add(this.t); this.cells++; r += R_CELL; event = "cell";
      }
      const done = this.dead || this.t >= this.cap;
      this.reward += r;
      return { r, done, event };
    }
    /* What the bot "sees": for lanes lane-2..lane+2, how far until the next wall
       (0 = off the road, 1 = next row ... 4 = nothing close), plus where the
       nearest power cell is (left / here / right / none). */
    sense() {
      const d = [];
      for (let k = -2; k <= 2; k++) {
        const L = this.lane + k;
        if (L < 0 || L >= LANES || (k !== 0 && this.track.row(this.t).obs[L])) { d.push(0); continue; }
        let dist = 4;
        for (let s = 1; s <= 4; s++) {
          if (this.track.row(this.t + s).obs[L]) { dist = s === 4 ? 3 : s; break; }
        }
        d.push(dist);
      }
      let c = 3;
      for (let s = 1; s <= 3 && c === 3; s++) {
        const cl = this.track.row(this.t + s).cell;
        if (cl >= 0 && !this.taken.has(this.t + s)) c = cl < this.lane ? 0 : cl === this.lane ? 1 : 2;
      }
      return { d, c };
    }
    stateKey() { return encode(this.sense()); }
  }
  function encode(s) { let k = 0; for (const v of s.d) k = k * 5 + v; return k * 4 + s.c; }
  function decode(k) {
    const c = k % 4; k = Math.floor(k / 4); const d = [];
    for (let i = 0; i < 5; i++) { d.unshift(k % 5); k = Math.floor(k / 5); }
    return { d, c };
  }
  /* Left/right mirror of a state: the bot learns both sides from one experience. */
  const MIRROR = new Int32Array(5 ** 5 * 4);
  for (let k = 0; k < MIRROR.length; k++) {
    const s = decode(k);
    MIRROR[k] = encode({ d: s.d.slice().reverse(), c: s.c === 3 ? 3 : 2 - s.c });
  }
  const N_STATES = 5 ** 5 * 4;

  /* Tabular Q-learning agent. The Q-table is a Float32Array (states x 3 actions). */
  class Agent {
    constructor(opts = {}) {
      this.alpha = opts.alpha ?? 0.3;
      this.mirror = opts.mirror ?? true;
      this.decay = opts.decay ?? 150;
      this.gamma = opts.gamma ?? 0.88;
      this.epsStart = opts.epsStart ?? 1.0;
      this.epsEnd = opts.epsEnd ?? 0.02;
      this.Q = new Float32Array(N_STATES * 3);
      this.visits = new Uint32Array(N_STATES);
      this.episodes = 0;
      this.rng = mulberry32(opts.seed ?? 4242);
      this.history = [];   // per-episode {ep, reward, score, steps, eps}
    }
    best(s) {
      const q = this.Q, b = s * 3;
      let bi = 1, bv = q[b + 1];               // prefer "stay" on ties
      if (q[b] > bv) { bi = 0; bv = q[b]; }
      if (q[b + 2] > bv) { bi = 2; bv = q[b + 2]; }
      return bi;
    }
    qvals(s) { return [this.Q[s * 3], this.Q[s * 3 + 1], this.Q[s * 3 + 2]]; }
    act(s, eps) {
      if (eps > 0 && this.rng() < eps) return Math.floor(this.rng() * 3);
      return this.best(s);
    }
    /* Curiosity schedule: starts at 100% random, fades as experience grows. */
    epsAt(ep) { return Math.max(this.epsEnd, this.epsStart * Math.exp(-ep / this.decay)); }
    /* Train one episode on a random track; returns its stats. */
    trainEpisode(diff, cap) {
      const eps = this.epsAt(this.episodes);
      const seed = 100000 + Math.floor(this.rng() * 1e9);
      const run = new Run(seed, diff, cap || 800);
      let s = run.stateKey();
      for (;;) {
        const a = this.act(s, eps);
        const { r, done } = run.step(a);
        const s2 = run.stateKey();
        const i = s * 3 + a;
        const target = run.dead ? r : r + this.gamma * this.Q[s2 * 3 + this.best(s2)];
        this.Q[i] += this.alpha * (target - this.Q[i]);
        if (this.mirror) {   // same lesson, mirrored left<->right
          const ms = MIRROR[s], ms2 = MIRROR[s2], mi = ms * 3 + (2 - a);
          const mt = run.dead ? r : r + this.gamma * this.Q[ms2 * 3 + this.best(ms2)];
          this.Q[mi] += this.alpha * (mt - this.Q[mi]);
          this.visits[ms]++;
        }
        this.visits[s]++;
        s = s2;
        if (done) break;
      }
      this.episodes++;
      const h = { ep: this.episodes, reward: run.reward, score: run.score, steps: run.t, eps, crashed: run.dead };
      this.history.push(h);
      return h;
    }
    /* Greedy evaluation on a fixed track (no learning). */
    evaluate(seed, diff, cap) {
      const run = new Run(seed, diff, cap || 3000);
      while (!run.dead && run.t < run.cap) run.step(this.best(run.stateKey()));
      return { score: run.score, steps: run.t, cells: run.cells, crashed: run.dead };
    }
    statesSeen() { let n = 0; for (let i = 0; i < N_STATES; i++) if (this.visits[i]) n++; return n; }
    snapshot() { return { Q: this.Q.slice(), episodes: this.episodes }; }
    loadQ(Q) { this.Q.set(Q); }
  }

  /* A frozen policy (e.g. snapshot at episode 10) that can drive a Run. */
  function policyFromQ(Q) {
    return (s) => {
      const b = s * 3; let bi = 1, bv = Q[b + 1];
      if (Q[b] > bv) { bi = 0; bv = Q[b]; }
      if (Q[b + 2] > bv) { bi = 2; }
      return bi;
    };
  }

  const API = { LANES, ACTIONS, ACTION_NAMES, DIFFS, TRACKS, N_STATES, R_ALIVE, R_CELL, R_CRASH,
    mulberry32, encode, decode, MIRROR, Track, Run, Agent, policyFromQ };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.TBA_CORE = API;
})(typeof window !== "undefined" ? window : globalThis);
