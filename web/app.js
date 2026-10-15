/* Train-a-Bot Arcade: UI, rendering, game loop, training loop, sound, saves, test API. */
(function () {
  "use strict";
  const C = window.TBA_CORE;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const LS = "tba.v1.";
  const CKPTS = [
    { ep: 10, name: "Newborn" }, { ep: 100, name: "Rookie" }, { ep: 500, name: "Learner" },
    { ep: 2000, name: "Pro" }, { ep: 5000, name: "Legend" },
  ];
  const EVAL_CAP = 3000;

  /* ---------------- storage ---------------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(LS + k); } catch {} },
  };
  function b64(buf) { let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(str) { const s = atob(str); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; }
  /* Sparse Q-table pack: only situations the bot has actually met. */
  function packQ(Q) {
    const idx = [];
    for (let s = 0; s < C.N_STATES; s++) if (Q[s * 3] || Q[s * 3 + 1] || Q[s * 3 + 2]) idx.push(s);
    const buf = new ArrayBuffer(4 + idx.length * 2 + idx.length * 12 + 4);
    const dv = new DataView(buf); dv.setUint32(0, idx.length, true);
    let o = 4;
    for (const s of idx) { dv.setUint16(o, s, true); o += 2; }
    o = 4 + idx.length * 2; o += (4 - (o % 4)) % 4;
    const f = new Float32Array(buf, o, idx.length * 3);
    idx.forEach((s, i) => { f[i * 3] = Q[s * 3]; f[i * 3 + 1] = Q[s * 3 + 1]; f[i * 3 + 2] = Q[s * 3 + 2]; });
    return b64(buf);
  }
  function unpackQ(str) {
    const buf = unb64(str); const dv = new DataView(buf); const n = dv.getUint32(0, true);
    const Q = new Float32Array(C.N_STATES * 3);
    let o = 4 + n * 2; o += (4 - (o % 4)) % 4;
    const f = new Float32Array(buf, o, n * 3);
    for (let i = 0; i < n; i++) { const s = dv.getUint16(4 + i * 2, true); Q[s * 3] = f[i * 3]; Q[s * 3 + 1] = f[i * 3 + 1]; Q[s * 3 + 2] = f[i * 3 + 2]; }
    return Q;
  }

  /* ---------------- state ---------------- */
  const settings = Object.assign({ diff: "normal", track: "neon-alley", muted: false, pace: "fast", nEp: 2000, spd: 2, ghost: false }, store.get("settings", {}));
  const humanBest = store.get("human", {});   // "track|diff" -> score
  const aiBest = store.get("ai", {});         // "track|diff" -> {score, ep}
  const brains = {};
  const app = {
    screen: "title", tab: "title",
    stage: "attract",           // attract | ready | human | watch | feed
    run: null, acc: 0, frac: 0, laneDisp: 2, paused: false, frozen: false,
    pending: 0, queued: 0, ghost: null, lastHuman: null,
    watch: null,                // {Q, label, ep, run, speed}
    training: null,             // {target, done, pace, carry}
    feed: null, particles: [], shake: 0, flash: 0, banner: null,
    demo: null, demoAgent: null, help: false, thought: null, tickCount: 0, scrollT: 0,
  };
  const key = (t, d) => `${t}|${d || settings.diff}`;
  const trackById = (id) => C.TRACKS.find((t) => t.id === id) || C.TRACKS[0];
  let randomSeed = 1 + Math.floor(Math.random() * 1e6);
  function currentSeed() { return settings.track === "random" ? randomSeed : trackById(settings.track).seed; }
  function currentTrackName() { return settings.track === "random" ? `Surprise #${randomSeed}` : trackById(settings.track).name; }

  function newBrain() { return { agent: new C.Agent({ seed: (Math.random() * 1e9) | 0 }), hist: { score: [], eps: [] }, snaps: {}, best: 0 }; }
  function brain(d) {
    d = d || settings.diff;
    if (brains[d]) return brains[d];
    const b = newBrain();
    const saved = store.get("brain." + d, null);
    if (saved && saved.q) {
      try {
        b.agent.loadQ(unpackQ(saved.q));
        b.agent.episodes = saved.episodes || 0;
        b.hist.score = Array.from(new Int16Array(unb64(saved.hs || "")));
        b.hist.eps = Array.from(new Uint8Array(unb64(saved.he || ""))).map((v) => v / 255);
        b.best = saved.best || 0;
        for (const [ep, q] of Object.entries(saved.snaps || {})) b.snaps[ep] = unpackQ(q);
        for (let s = 0; s < C.N_STATES; s++) if (b.agent.Q[s * 3] || b.agent.Q[s * 3 + 1] || b.agent.Q[s * 3 + 2]) b.agent.visits[s] = 1;
      } catch (e) { console.warn("brain load failed", e); }
    }
    brains[d] = b;
    return b;
  }
  function saveBrain(d) {
    d = d || settings.diff; const b = brains[d]; if (!b) return;
    const snaps = {};
    for (const [ep, q] of Object.entries(b.snaps)) snaps[ep] = packQ(q);
    const hs = new Int16Array(b.hist.score.map((v) => Math.max(-32000, Math.min(32000, v))));
    const he = new Uint8Array(b.hist.eps.map((v) => Math.round(v * 255)));
    const ok = store.set("brain." + d, { q: packQ(b.agent.Q), episodes: b.agent.episodes, hs: b64(hs.buffer), he: b64(he.buffer), best: b.best, snaps });
    if (!ok) store.set("brain." + d, { q: packQ(b.agent.Q), episodes: b.agent.episodes, hs: b64(hs.buffer), he: b64(he.buffer), best: b.best, snaps: {} });
  }
  const saveSettings = () => store.set("settings", settings);

  /* ---------------- sound ---------------- */
  let actx = null;
  function sfx(name) {
    if (settings.muted) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
      const t = actx.currentTime;
      const tone = (f0, f1, dur, type = "square", vol = 0.06, delay = 0) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = type; o.frequency.setValueAtTime(f0, t + delay);
        o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + delay + dur);
        g.gain.setValueAtTime(vol, t + delay); g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
        o.connect(g).connect(actx.destination); o.start(t + delay); o.stop(t + delay + dur + 0.02);
      };
      if (name === "move") tone(520, 640, 0.05, "square", 0.025);
      else if (name === "cell") { tone(880, 1320, 0.08, "triangle", 0.07); tone(1320, 1760, 0.1, "triangle", 0.05, 0.06); }
      else if (name === "crash") { tone(220, 40, 0.45, "sawtooth", 0.09); tone(120, 30, 0.5, "square", 0.05, 0.03); }
      else if (name === "start") { [440, 554, 659, 880].forEach((f, i) => tone(f, f, 0.08, "square", 0.04, i * 0.07)); }
      else if (name === "done") { [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, f * 1.01, 0.1, "triangle", 0.06, i * 0.09)); }
      else if (name === "click") tone(700, 500, 0.04, "triangle", 0.03);
      else if (name === "best") { [659, 784, 988, 1319].forEach((f, i) => tone(f, f, 0.12, "triangle", 0.07, i * 0.1)); }
    } catch {}
  }

  /* ---------------- canvas setup ---------------- */
  const cv = $("#game"), ctx = cv.getContext("2d");
  const W = 480, H = 704, LW = 76, ROADX = (W - LW * 5) / 2, RH = 64, BOTY = H - 118;
  function fitCanvas(c, w, h) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = w * dpr; c.height = h * dpr; c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  fitCanvas(cv, W, H);
  const laneX = (l) => ROADX + (l + 0.5) * LW;
  const stars = Array.from({ length: 70 }, (_, i) => ({ x: (i * 97.3) % W, y: (i * 233.7) % H, s: (i % 3) + 1 }));

  function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

  function drawBot(c, x, y, tilt, col, alpha, look, now, label) {
    c.save(); c.globalAlpha = alpha; c.translate(x, y); c.rotate(tilt);
    // thruster
    const fl = 10 + Math.sin(now / 40) * 4;
    const g = c.createLinearGradient(0, 18, 0, 18 + fl + 10);
    g.addColorStop(0, "rgba(255,240,140,.95)"); g.addColorStop(1, "rgba(255,79,216,0)");
    c.fillStyle = g; c.beginPath(); c.moveTo(-9, 18); c.lineTo(9, 18); c.lineTo(0, 18 + fl + 12); c.closePath(); c.fill();
    c.shadowColor = col; c.shadowBlur = 18;
    c.fillStyle = col; rr(c, -22, -20, 44, 38, 11); c.fill();
    c.shadowBlur = 0;
    c.fillStyle = "rgba(0,0,0,.18)"; rr(c, -22, 6, 44, 12, 6); c.fill();
    c.fillStyle = "#0b1030"; rr(c, -16, -14, 32, 18, 6); c.fill();
    const ex = look * 3, blink = (Math.floor(now / 2600) % 7 === 0 && (now % 2600) < 140) ? 1 : 5;
    c.fillStyle = "#7dffb2"; c.shadowColor = "#7dffb2"; c.shadowBlur = 8;
    rr(c, -10 + ex, -8 + (5 - blink) / 2, 6, blink, 2); c.fill(); rr(c, 4 + ex, -8 + (5 - blink) / 2, 6, blink, 2); c.fill();
    c.shadowBlur = 0;
    c.strokeStyle = col; c.lineWidth = 2.5; c.beginPath(); c.moveTo(0, -20); c.lineTo(0, -30); c.stroke();
    c.fillStyle = Math.floor(now / 400) % 2 ? "#ff4fd8" : "#ffe45e"; c.beginPath(); c.arc(0, -32, 3.8, 0, 7); c.fill();
    c.fillStyle = col; rr(c, -27, -6, 6, 14, 3); c.fill(); rr(c, 21, -6, 6, 14, 3); c.fill();
    c.restore();
    if (label) { c.save(); c.globalAlpha = alpha; c.font = "bold 11px Trebuchet MS, Segoe UI, sans-serif"; c.fillStyle = col; c.textAlign = "center"; c.fillText(label, x, y + 44); c.restore(); }
  }

  function drawFirewall(c, x, y, now, hl) {
    const w = LW - 12, h = RH - 18, X = x - w / 2, Y = y - h / 2;
    c.save();
    c.shadowColor = "#ff2d55"; c.shadowBlur = 16;
    const g = c.createLinearGradient(0, Y, 0, Y + h);
    g.addColorStop(0, "#ff7a59"); g.addColorStop(1, "#c0163a");
    c.fillStyle = g; rr(c, X, Y, w, h, 7); c.fill();
    c.shadowBlur = 0;
    c.strokeStyle = "rgba(60,0,15,.45)"; c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(X + 3, Y + h / 2); c.lineTo(X + w - 3, Y + h / 2);
    for (let i = 1; i < 3; i++) { c.moveTo(X + (w * i) / 3, Y + 2); c.lineTo(X + (w * i) / 3, Y + h / 2); }
    for (let i = 0; i < 2; i++) { c.moveTo(X + w / 6 + (w * i) / 3 + w / 6, Y + h / 2); c.lineTo(X + w / 6 + (w * i) / 3 + w / 6, Y + h - 2); }
    c.stroke();
    // flames
    c.fillStyle = "rgba(255,214,94,.9)";
    for (let i = 0; i < 4; i++) {
      const fx = X + 8 + i * ((w - 16) / 3), fh = 6 + 4 * Math.sin(now / 90 + i * 1.7 + x);
      c.beginPath(); c.moveTo(fx - 5, Y + 1); c.quadraticCurveTo(fx, Y - fh * 1.6, fx + 5, Y + 1); c.fill();
    }
    if (hl) { c.strokeStyle = "#ffe45e"; c.lineWidth = 2.5; c.setLineDash([5, 4]); rr(c, X - 3, Y - 3, w + 6, h + 6, 9); c.stroke(); c.setLineDash([]); }
    c.restore();
  }
  function drawCell(c, x, y, now) {
    const p = 1 + 0.08 * Math.sin(now / 160 + x);
    c.save(); c.translate(x, y); c.scale(p, p);
    c.shadowColor = "#ffe45e"; c.shadowBlur = 18;
    c.fillStyle = "#ffe45e"; rr(c, -11, -15, 22, 30, 5); c.fill();
    c.shadowBlur = 0; c.fillStyle = "#ffe45e"; c.fillRect(-4, -19, 8, 5);
    c.fillStyle = "#3a2a00"; c.beginPath(); c.moveTo(2, -10); c.lineTo(-6, 2); c.lineTo(0, 2); c.lineTo(-2, 11); c.lineTo(6, -2); c.lineTo(0, -2); c.closePath(); c.fill();
    c.restore();
  }

  function drawWorld(now) {
    const c = ctx;
    const run = app.stage === "attract" ? app.demo && app.demo.run : app.stage === "watch" ? app.watch && app.watch.run : app.stage === "feed" ? app.feed && app.feed.run : app.run;
    c.save();
    if (app.shake > 0) c.translate((Math.random() - 0.5) * app.shake, (Math.random() - 0.5) * app.shake);
    // sky
    const bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0c0630"); bg.addColorStop(0.55, "#120a3a"); bg.addColorStop(1, "#1d0b3d");
    c.fillStyle = bg; c.fillRect(-10, -10, W + 20, H + 20);
    const viewT = run ? run.t + (run.dead ? 0 : app.frac) : app.scrollT;
    for (const s of stars) {
      const y = (s.y + viewT * 6 * s.s) % H;
      c.fillStyle = `rgba(200,210,255,${0.25 + s.s * 0.15})`; c.fillRect(s.x, y, s.s, s.s);
    }
    // side grid
    c.strokeStyle = "rgba(255,79,216,.18)"; c.lineWidth = 1;
    const off = (viewT * RH) % 32;
    for (let y = -32 + off; y < H; y += 32) { c.beginPath(); c.moveTo(0, y); c.lineTo(ROADX - 8, y); c.moveTo(ROADX + LW * 5 + 8, y); c.lineTo(W, y); c.stroke(); }
    // road
    const rg = c.createLinearGradient(ROADX, 0, ROADX + LW * 5, 0);
    rg.addColorStop(0, "#151649"); rg.addColorStop(0.5, "#1b1d5e"); rg.addColorStop(1, "#151649");
    c.fillStyle = rg; c.fillRect(ROADX, 0, LW * 5, H);
    c.strokeStyle = "rgba(59,232,255,.22)"; c.setLineDash([18, 22]); c.lineDashOffset = -(viewT * RH) % 40;
    for (let l = 1; l < 5; l++) { c.beginPath(); c.moveTo(ROADX + l * LW, 0); c.lineTo(ROADX + l * LW, H); c.stroke(); }
    c.setLineDash([]);
    c.shadowColor = "#ff4fd8"; c.shadowBlur = 14; c.strokeStyle = "#ff4fd8"; c.lineWidth = 3;
    c.beginPath(); c.moveTo(ROADX - 2, 0); c.lineTo(ROADX - 2, H); c.moveTo(ROADX + LW * 5 + 2, 0); c.lineTo(ROADX + LW * 5 + 2, H); c.stroke();
    c.shadowBlur = 0;
    if (!run) { c.restore(); return; }
    const rowY = (i) => BOTY - (i - viewT) * RH;
    const t0 = Math.floor(viewT) - 3, t1 = Math.ceil(viewT) + 11;
    // bot vision overlay
    const showSense = app.stage === "watch" || app.stage === "feed" || (app.stage === "attract");
    const senseSet = new Set();
    if (showSense && !run.dead) {
      for (let k = -2; k <= 2; k++) {
        const L = run.lane + k; if (L < 0 || L > 4) continue;
        for (let s = 1; s <= 4; s++) {
          const y = rowY(run.t + s);
          c.fillStyle = k === 0 ? "rgba(59,232,255,.10)" : "rgba(59,232,255,.05)";
          c.fillRect(ROADX + L * LW + 2, y - RH / 2 + 2, LW - 4, RH - 4);
          if (run.track.row(run.t + s).obs[L]) senseSet.add((run.t + s) * 8 + L);
        }
      }
      c.strokeStyle = "rgba(59,232,255,.45)"; c.lineWidth = 1.5; c.setLineDash([4, 5]);
      const L0 = Math.max(0, run.lane - 2), L1 = Math.min(4, run.lane + 2);
      c.strokeRect(ROADX + L0 * LW + 1, rowY(run.t + 4) - RH / 2, (L1 - L0 + 1) * LW - 2, RH * 4);
      c.setLineDash([]);
      c.fillStyle = "rgba(159,247,255,.85)"; c.font = "bold 11px Trebuchet MS, Segoe UI, sans-serif"; c.textAlign = "left";
      c.fillText("BOT VISION", ROADX + L0 * LW + 6, rowY(run.t + 4) - RH / 2 + 14);
    }
    // ghost wreck marker
    if (app.stage === "human" && app.ghost && app.ghost.crashT != null && app.ghost.crashT >= t0 && app.ghost.crashT <= t1) {
      const gl = app.ghost.lanes[app.ghost.crashT]; const y = rowY(app.ghost.crashT);
      c.save(); c.globalAlpha = 0.6; c.strokeStyle = "#ff4fd8"; c.lineWidth = 4;
      c.beginPath(); c.moveTo(laneX(gl) - 12, y - 12); c.lineTo(laneX(gl) + 12, y + 12); c.moveTo(laneX(gl) + 12, y - 12); c.lineTo(laneX(gl) - 12, y + 12); c.stroke();
      c.font = "bold 11px Trebuchet MS, Segoe UI, sans-serif"; c.fillStyle = "#ff4fd8"; c.textAlign = "center"; c.fillText("bot crashed here", laneX(gl), y + 28); c.restore();
    }
    for (let i = Math.max(0, t0); i <= t1; i++) {
      const row = run.track.row(i), y = rowY(i);
      if (y < -RH || y > H + RH) continue;
      if (i % 50 === 0 && i > 0) {
        c.fillStyle = "rgba(255,228,94,.25)"; c.fillRect(ROADX, y - 1, LW * 5, 2);
        c.font = "bold 11px ui-monospace, Menlo, Consolas, monospace"; c.fillStyle = "rgba(255,228,94,.6)"; c.textAlign = "right"; c.fillText(String(i), ROADX - 6, y + 4);
      }
      for (let l = 0; l < 5; l++) if (row.obs[l]) drawFirewall(c, laneX(l), y, now, senseSet.has(i * 8 + l));
      if (row.cell >= 0 && !run.taken.has(i)) drawCell(c, laneX(row.cell), y, now);
    }
    // ghost bot
    if (app.stage === "human" && app.ghost) {
      const gt = Math.min(run.t, app.ghost.lanes.length - 1);
      if (app.ghost.crashT == null || run.t < app.ghost.crashT) {
        const gl = app.ghost.lanes[gt];
        drawBot(c, laneX(gl), BOTY - app.frac * 0, 0, "#ff4fd8", 0.38, 0, now, "BOT GHOST");
      }
    }
    // bot
    if (!(run.dead && app.flash <= 0 && app.stage !== "human" && app.stage !== "watch")) {
      const tilt = (run.lane - app.laneDisp) * 0.35;
      const deadY = run.dead ? BOTY : BOTY;
      const col = app.stage === "human" || app.stage === "ready" ? "#3be8ff" : "#7dffb2";
      if (!run.dead) drawBot(c, laneX(app.laneDisp), deadY, tilt, col, 1, Math.sign(run.lane - app.laneDisp), now);
      else {
        c.save(); c.globalAlpha = 0.85; c.fillStyle = "#2a2f66"; rr(c, laneX(run.lane) - 22, BOTY - 10, 44, 26, 8); c.fill();
        c.strokeStyle = "#ff4d6d"; c.lineWidth = 3; c.beginPath(); c.moveTo(laneX(run.lane) - 8, BOTY - 2); c.lineTo(laneX(run.lane) + 8, BOTY + 10); c.moveTo(laneX(run.lane) + 8, BOTY - 2); c.lineTo(laneX(run.lane) - 8, BOTY + 10); c.stroke(); c.restore();
      }
    }
    // particles
    for (const p of app.particles) { c.globalAlpha = Math.max(0, p.life); c.fillStyle = p.col; c.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s); }
    c.globalAlpha = 1;
    c.restore();
    if (app.flash > 0) { c.fillStyle = `rgba(255,77,109,${app.flash * 0.35})`; c.fillRect(0, 0, W, H); }
    drawHud(run, now);
  }

  function pill(c, x, y, txt, col, align) {
    c.font = "bold 13px Trebuchet MS, Segoe UI, sans-serif";
    const w = c.measureText(txt).width + 18;
    const X = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
    c.fillStyle = "rgba(8,9,30,.78)"; rr(c, X, y, w, 24, 12); c.fill();
    c.strokeStyle = col; c.lineWidth = 1.2; rr(c, X, y, w, 24, 12); c.stroke();
    c.fillStyle = col; c.textAlign = "left"; c.fillText(txt, X + 9, y + 16.5);
  }
  function drawHud(run, now) {
    const c = ctx;
    c.fillStyle = "rgba(8,9,30,.8)"; rr(c, 10, 10, 196, 54, 12); c.fill();
    c.strokeStyle = "rgba(255,228,94,.5)"; rr(c, 10, 10, 196, 54, 12); c.stroke();
    c.textAlign = "left"; c.fillStyle = "#8f95c9"; c.font = "bold 10px Trebuchet MS, Segoe UI, sans-serif"; c.fillText("SCORE", 22, 26);
    c.fillStyle = "#ffe45e"; c.font = "bold 28px ui-monospace, Menlo, Consolas, monospace"; c.fillText(String(run.score), 22, 55);
    c.font = "12px Trebuchet MS, Segoe UI, sans-serif"; c.fillStyle = "#cfd3ff"; c.textAlign = "right";
    c.fillText(`rows ${run.t}`, 196, 30); c.fillText(`cells ${run.cells}`, 196, 50);
    const modeTxt = {
      attract: "DEMO · trained bot", ready: "READY", human: app.ghost ? "YOU vs BOT GHOST" : "YOU",
      watch: app.watch ? `BOT · ${app.watch.label}` : "BOT", feed: "LIVE PRACTICE",
    }[app.stage] || "";
    pill(c, W - 10, 10, modeTxt, app.stage === "human" || app.stage === "ready" ? "#3be8ff" : "#7dffb2", "right");
    pill(c, W - 10, 40, `${currentTrackName()} · ${C.DIFFS[settings.diff].name}`, "#ff4fd8", "right");
    if (app.stage === "feed" && app.feed) {
      const b = brain();
      pill(c, W / 2, H - 40, `practice run ${b.agent.episodes.toLocaleString()} · curiosity ${Math.round(b.agent.epsAt(b.agent.episodes) * 100)}%`, "#ffe45e", "center");
    }
    if (app.stage === "watch" && app.watch && app.watch.speed > 1) pill(c, 10, 72, `${app.watch.speed}x`, "#7dffb2", "left");
    if (app.stage === "ready") {
      c.fillStyle = "rgba(8,9,30,.7)"; rr(c, 60, 250, W - 120, 120, 18); c.fill();
      c.strokeStyle = "#3be8ff"; rr(c, 60, 250, W - 120, 120, 18); c.stroke();
      c.textAlign = "center"; c.fillStyle = "#fff"; c.font = "bold 26px Trebuchet MS, Segoe UI, sans-serif"; c.fillText(currentTrackName(), W / 2, 292);
      c.fillStyle = "#9ff7ff"; c.font = "16px Trebuchet MS, Segoe UI, sans-serif";
      c.fillText(Math.floor(now / 500) % 2 ? "Press SPACE to start" : "Press SPACE to start  ", W / 2, 324);
      c.fillStyle = "#8f95c9"; c.font = "13px Trebuchet MS, Segoe UI, sans-serif"; c.fillText("arrow keys or A / D to switch lanes", W / 2, 350);
    }
    if (app.paused && (app.stage === "human" || app.stage === "watch")) {
      c.fillStyle = "rgba(8,9,30,.7)"; c.fillRect(0, 0, W, H);
      c.fillStyle = "#fff"; c.textAlign = "center"; c.font = "bold 34px Trebuchet MS, Segoe UI, sans-serif"; c.fillText("PAUSED", W / 2, H / 2);
      c.font = "15px Trebuchet MS, Segoe UI, sans-serif"; c.fillStyle = "#9ff7ff"; c.fillText("press P to keep going", W / 2, H / 2 + 30);
    }
    if (app.banner && app.banner.until > now) {
      c.fillStyle = "rgba(8,9,30,.85)"; rr(c, 40, 120, W - 80, 64, 16); c.fill();
      c.strokeStyle = app.banner.col; c.lineWidth = 2; rr(c, 40, 120, W - 80, 64, 16); c.stroke();
      c.fillStyle = app.banner.col; c.textAlign = "center"; c.font = "bold 22px Trebuchet MS, Segoe UI, sans-serif"; c.fillText(app.banner.text, W / 2, 150);
      if (app.banner.sub) { c.fillStyle = "#cfd3ff"; c.font = "13px Trebuchet MS, Segoe UI, sans-serif"; c.fillText(app.banner.sub, W / 2, 172); }
    }
  }
  function burst(x, y, col, n, sp) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = (0.4 + Math.random()) * sp;
      app.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, col, s: 3 + Math.random() * 4 });
    }
  }
  function banner(text, col, sub, ms) { app.banner = { text, col: col || "#7dffb2", sub, until: performance.now() + (ms || 1800) }; }
  let toastT = 0;
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add("hidden"), 2600); }

  /* ---------------- runs ---------------- */
  function recordRun(policy, seed, diff, cap) {
    const run = new C.Run(seed, diff, cap || EVAL_CAP);
    const lanes = [run.lane]; let crashT = null;
    while (!run.dead && run.t < run.cap) { run.step(policy(run.stateKey())); lanes[run.t] = run.lane; }
    if (run.dead) crashT = run.t;
    return { lanes, crashT, score: run.score, steps: run.t, cells: run.cells, crashed: run.dead };
  }
  function latestPolicy(d) { const b = brain(d); return (s) => b.agent.best(s); }
  function evalTrack(trackId, d, Q) {
    d = d || settings.diff;
    const tr = trackById(trackId);
    const pol = Q ? C.policyFromQ(Q) : latestPolicy(d);
    return recordRun(pol, tr.seed, d, EVAL_CAP);
  }
  function hasBrain(d) { return brain(d).agent.episodes > 0; }
  function refreshAiBest(d) {
    d = d || settings.diff;
    if (!hasBrain(d)) return;
    const ep = brain(d).agent.episodes;
    for (const t of C.TRACKS) {
      const r = evalTrack(t.id, d);
      const k = key(t.id, d);
      if (!aiBest[k] || r.score > aiBest[k].score) aiBest[k] = { score: r.score, ep };
    }
    store.set("ai", aiBest);
  }

  function setStage(s) {
    app.stage = s; app.paused = false; app.acc = 0; app.frac = 0;
    $("#stage-over").classList.add("hidden");
    if (s !== "human") app.ghost = app.ghost && s === "human" ? app.ghost : null;
  }
  function readyStage() {
    if (app.training) return;
    setStage("ready");
    app.run = new C.Run(currentSeed(), settings.diff); app.laneDisp = 2;
  }

  function startHuman(opts = {}) {
    if (app.training) stopTraining();
    if (opts.track) setTrack(opts.track, true);
    if (opts.diff) setDiff(opts.diff, true);
    const ghostOn = opts.ghost != null ? opts.ghost : settings.ghost;
    setStage("human");
    app.run = new C.Run(currentSeed(), settings.diff);
    app.laneDisp = 2; app.pending = 0; app.queued = 0; app.particles = []; app.tickCount = 0;
    app.ghost = null;
    if (ghostOn && hasBrain()) app.ghost = recordRun(latestPolicy(), currentSeed(), settings.diff, 20000);
    else if (ghostOn) toast("Train the bot first to get a ghost to race");
    sfx("start");
    banner("GO!", "#3be8ff", app.ghost ? "the pink ghost is the bot on this same track" : null, 900);
    if (app.tab !== "play" && app.tab !== "compare") go("play", true);
    updatePlayStats(true);
  }
  function humanTps() { return C.DIFFS[settings.diff].tps * (1 + Math.min(0.45, app.run.t / 700)); }
  function humanMove(dir) {
    if (app.stage === "ready") { startHuman(); return; }
    if (app.stage !== "human" || app.run.dead || app.paused) return;
    const run = app.run;
    if (app.pending === 0) {
      const nl = run.lane + dir;
      if (nl < 0 || nl > 4) { app.shake = 3; return; }
      app.pending = dir; sfx("move");
      if (run.track.row(run.t).obs[nl]) { doHumanTick(); return; }   // sideswipe: instant crash
      run.lane = nl; // show immediately; step() is applied with action relative to start lane
      run._from = nl - dir;
    } else if (app.pending === -dir) {
      // change of mind inside the same row: undo
      run.lane = run._from; app.pending = 0; sfx("move");
    } else app.queued = dir;
  }
  function doHumanTick() {
    const run = app.run; if (run.dead) return;
    if (app.pending !== 0 && run._from != null) run.lane = run._from;
    const res = run.step(app.pending + 1);
    run._from = null; app.pending = 0; app.tickCount++;
    afterStep(run, res, true);
    if (run.dead) { humanOver(); return; }
    if (app.queued) { const q = app.queued; app.queued = 0; humanMove(q); }
  }
  function afterStep(run, res, loud) {
    if (res.event === "cell") { burst(laneX(run.lane), BOTY - 10, "#ffe45e", 14, 3); if (loud) sfx("cell"); }
    if (res.event === "crash") { burst(laneX(run.lane), BOTY - 10, "#ff4d6d", 34, 5); burst(laneX(run.lane), BOTY - 10, "#ffe45e", 14, 3); app.shake = 14; app.flash = 1; if (loud) sfx("crash"); }
    if (res.event === "bonk") app.shake = Math.max(app.shake, 3);
  }
  function humanOver() {
    const run = app.run, k = key(settings.track), prev = humanBest[k] || 0;
    const isNamed = settings.track !== "random";
    const best = run.score > prev;
    if (isNamed && best) { humanBest[k] = run.score; store.set("human", humanBest); }
    app.lastHuman = { score: run.score, rows: run.t, cells: run.cells, track: settings.track, diff: settings.diff, best };
    setTimeout(() => {
      if (app.stage !== "human" || !app.run.dead) return;
      $("#over-title").textContent = run.t >= 300 ? "GREAT RUN!" : "CRASHED!";
      $("#over-title").classList.toggle("win", run.t >= 300);
      $("#over-score").textContent = run.score;
      $("#over-detail").textContent = `${run.t} rows · ${run.cells} power cell${run.cells === 1 ? "" : "s"} · ${currentTrackName()} (${C.DIFFS[settings.diff].name})`;
      $("#over-best").textContent = !isNamed ? "Surprise tracks aren't saved. Pick a named track to set a record." : best ? (prev ? `NEW BEST! (old best ${prev})` : "First score on this track!") : `Your best here: ${prev}`;
      let vs = "The bot hasn't trained yet. Teach it in Train the Bot!";
      if (hasBrain()) {
        const r = recordRun(latestPolicy(), currentSeed(), settings.diff, EVAL_CAP);
        vs = r.score > run.score ? `The bot (after ${brain().agent.episodes.toLocaleString()} practice runs) scores ${r.score} here. It beats you by ${r.score - run.score}.`
          : `You beat the bot! It only scores ${r.score} here after ${brain().agent.episodes.toLocaleString()} practice runs.`;
      }
      $("#over-vs").textContent = vs;
      $("#stage-over").classList.remove("hidden");
      if (best && isNamed && prev) sfx("best");
    }, 650);
    updatePlayStats(true); renderTracks(); renderCompare();
  }
  function humanAuto(steps) {   // test helper: a cautious scripted "kid" that looks 1 row ahead
    if (app.stage !== "human") startHuman();
    for (let i = 0; i < steps && !app.run.dead; i++) {
      const run = app.run;
      const ok = (l) => l >= 0 && l < 5 && !run.track.row(run.t + 1).obs[l] && (l === run.lane || !run.track.row(run.t).obs[l]);
      let dir = 0;
      if (!ok(run.lane)) dir = ok(run.lane - 1) ? -1 : ok(run.lane + 1) ? 1 : 0;
      if (dir) humanMove(dir);
      doHumanTick();
    }
    return state();
  }

  /* ---------------- watch the bot ---------------- */
  function watch(which, speed) {
    if (app.training) stopTraining();
    const b = brain();
    let Q = null, label = "", ep = b.agent.episodes;
    if (which == null || which === "latest") { Q = b.agent.Q; label = `latest brain (${ep.toLocaleString()} runs)`; }
    else { const c = CKPTS.find((x) => String(x.ep) === String(which)); if (!c || !b.snaps[c.ep]) { toast("That checkpoint isn't unlocked yet"); return false; } Q = b.snaps[c.ep]; ep = c.ep; label = `${c.name} (${c.ep} runs)`; }
    if (!hasBrain()) toast("This bot is untrained, so it's going to crash fast. Try training it!");
    setStage("watch");
    app.watch = { Q, label, ep, which: which || "latest", speed: speed || settings.spd, run: new C.Run(currentSeed(), settings.diff, EVAL_CAP), policy: C.policyFromQ(Q) };
    app.laneDisp = 2; app.particles = [];
    if (app.tab !== "train" && app.tab !== "compare") go("train", true);
    think();
    renderCkpts();
    return true;
  }
  function watchStep() {
    const w = app.watch; if (!w || w.run.dead || w.run.t >= w.run.cap) return;
    const s = w.run.stateKey(), a = w.policy(s);
    const res = w.run.step(a);
    afterStep(w.run, res, w.speed <= 4);
    if (w.run.dead || w.run.t >= w.run.cap) watchOver();
    else think();
  }
  function watchOver() {
    const w = app.watch, r = w.run;
    const hb = humanBest[key(settings.track)];
    banner(r.dead ? `BOT CRASHED · ${r.score}` : `BOT FINISHED · ${r.score}`, r.dead ? "#ff4d6d" : "#7dffb2",
      hb != null && settings.track !== "random" ? (r.score > hb ? `beats your best (${hb}) by ${r.score - hb}` : `your best (${hb}) is still ahead by ${hb - r.score}`) : `${r.t} rows · ${r.cells} cells`, 3200);
    const k = key(settings.track);
    if (settings.track !== "random" && w.which === "latest" && (!aiBest[k] || r.score > aiBest[k].score)) { aiBest[k] = { score: r.score, ep: w.ep }; store.set("ai", aiBest); }
    think(true); renderCompare(); renderTracks();
  }
  function skipWatch() { const w = app.watch; if (!w) return; while (!w.run.dead && w.run.t < w.run.cap) { const res = w.run.step(w.policy(w.run.stateKey())); if (res.done) afterStep(w.run, res, false); } watchOver(); app.laneDisp = w.run.lane; }
  function stopWatch() { if (app.stage === "watch") { app.watch = null; readyStage(); } }
  function describe(sense) {
    const d = sense.d, bits = [];
    if (d[2] === 1) bits.push("Firewall right in front of me!");
    else if (d[2] === 2) bits.push("Firewall two rows ahead in my lane.");
    else if (d[2] === 3) bits.push("Something's coming up in my lane.");
    else bits.push("My lane looks clear.");
    if (d[1] === 0 && d[3] === 0) bits.push("Blocked on both sides.");
    else if (d[1] === 0) bits.push("Can't go left.");
    else if (d[3] === 0) bits.push("Can't go right.");
    if (sense.c === 0) bits.push("Power cell to my left."); else if (sense.c === 2) bits.push("Power cell to my right."); else if (sense.c === 1) bits.push("Power cell straight ahead!");
    return bits.join(" ");
  }
  function think(final) {
    const w = app.watch; if (!w) return;
    const s = w.run.stateKey(), q = [w.Q[s * 3], w.Q[s * 3 + 1], w.Q[s * 3 + 2]], a = w.policy(s);
    app.thought = { s, q, a, text: final ? (w.run.dead ? `Ouch. I crashed after ${w.run.t} rows. More practice would help!` : `Made it all ${w.run.t} rows!`) : describe(w.run.sense()) + ` So I'll pick ${C.ACTION_NAMES[a]}.` };
  }

  /* ---------------- training ---------------- */
  function trainEpisodes(n) {    // synchronous core used by both the loop and tests
    const b = brain();
    let last = null;
    for (let i = 0; i < n; i++) {
      last = b.agent.trainEpisode(settings.diff);
      b.hist.score.push(last.score); b.hist.eps.push(last.eps);
      if (last.score > b.best) b.best = last.score;
      const ck = CKPTS.find((c) => c.ep === b.agent.episodes);
      if (ck) { b.snaps[ck.ep] = b.agent.Q.slice(); app.newCk = ck; }
    }
    return last;
  }
  function startTraining(n, pace) {
    if (app.training) return;
    n = n || settings.nEp; pace = pace || settings.pace;
    app.watch = null;
    setStage("feed");
    app.training = { target: n, done: 0, pace, carry: 0, t0: performance.now(), startEp: brain().agent.episodes };
    newFeed();
    $("#btn-train").disabled = true; $("#btn-stop-train").disabled = false;
    if (app.tab !== "train") go("train", true);
    sfx("start");
    return new Promise((res) => { app.training.resolve = res; });
  }
  function trainFrame() {
    const tr = app.training; if (!tr) return;
    const t0 = performance.now();
    const perFrame = tr.pace === "instant" ? 1e9 : tr.pace === "fast" ? Math.max(1, tr.target / 300) : Math.max(0.5, tr.target / 1100);
    tr.carry += perFrame;
    let k = 0;
    while (tr.done < tr.target && tr.carry >= 1 && performance.now() - t0 < 14) {
      trainEpisodes(1); tr.done++; tr.carry--; k++;
    }
    if (tr.carry > 50) tr.carry = 50;
    if (app.newCk) { banner(`Checkpoint unlocked: ${app.newCk.name}`, "#ff4fd8", `saved a copy of the brain at ${app.newCk.ep} runs`, 1500); app.newCk = null; renderCkpts(); }
    if (tr.done >= tr.target) finishTraining();
  }
  function finishTraining(stopped) {
    const tr = app.training; if (!tr) return;
    app.training = null;
    $("#btn-train").disabled = false; $("#btn-stop-train").disabled = true;
    saveBrain(); refreshAiBest();
    const b = brain();
    sfx("done");
    const r = settings.track !== "random" ? evalTrack(settings.track) : recordRun(latestPolicy(), currentSeed(), settings.diff);
    banner(stopped ? "Training stopped" : "Training complete!", "#7dffb2", `${(b.agent.episodes - tr.startEp).toLocaleString()} new runs · bot now scores ${r.score} on ${currentTrackName()}`, 2600);
    renderAll();
    if (tr.resolve) tr.resolve(b.agent.episodes);
    // show off: watch the freshly trained brain
    setTimeout(() => { if (!app.training && app.stage === "feed") watch("latest"); }, 900);
  }
  function stopTraining() { if (app.training) finishTraining(true); }
  function newFeed() { app.feed = { run: new C.Run(100 + ((Math.random() * 1e9) | 0), settings.diff, 800), acc: 0, rng: C.mulberry32((Math.random() * 1e9) | 0) }; app.laneDisp = 2; }
  function feedStep() {
    const f = app.feed; if (!f) return;
    if (f.run.dead || f.run.t >= f.run.cap) { if ((f.deadFor = (f.deadFor || 0) + 1) > 6) { newFeed(); } return; }
    const ag = brain().agent, eps = ag.epsAt(ag.episodes);
    const s = f.run.stateKey();
    const a = f.rng() < eps ? Math.floor(f.rng() * 3) : ag.best(s);
    const res = f.run.step(a);
    afterStep(f.run, res, false);
  }
  function resetBrain() {
    if (app.training) stopTraining();
    brains[settings.diff] = newBrain(); store.del("brain." + settings.diff);
    for (const t of C.TRACKS) delete aiBest[key(t.id)];
    store.set("ai", aiBest);
    app.watch = null; readyStage();
    toast(`${C.DIFFS[settings.diff].name} brain wiped. Back to Newborn.`);
    renderAll();
  }

  /* ---------------- demo (attract) ---------------- */
  function initDemo() {
    const ag = new C.Agent({ seed: 99 });
    for (let i = 0; i < 1600; i++) ag.trainEpisode("normal");
    app.demoAgent = ag; newDemo();
  }
  function newDemo() { app.demo = { run: new C.Run(5000 + ((Math.random() * 1e6) | 0), "normal", 600) }; app.laneDisp = 2; }
  function demoStep() {
    const d = app.demo; if (!d) return;
    if (d.run.dead || d.run.t >= d.run.cap) { if ((d.deadFor = (d.deadFor || 0) + 1) > 8) newDemo(); return; }
    const res = d.run.step(app.demoAgent.best(d.run.stateKey()));
    afterStep(d.run, res, false);
  }

  /* ---------------- main loop ---------------- */
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!app.frozen) update(dt, now);
    drawWorld(now);
    if (now - (frame.ui || 0) > 100) { frame.ui = now; liveUI(); }
    requestAnimationFrame(frame);
  }
  function tickLoop(dt, tps, stepFn) {
    app.acc += dt; const iv = 1 / tps; let n = 0;
    while (app.acc >= iv && n < 40) { app.acc -= iv; stepFn(); n++; }
    app.frac = Math.min(1, app.acc / iv);
  }
  function update(dt, now) {
    if (!app.paused) {
      if (app.stage === "human" && app.run && !app.run.dead) tickLoop(dt, humanTps(), doHumanTick);
      else if (app.stage === "watch" && app.watch && !app.watch.run.dead && app.watch.run.t < app.watch.run.cap) tickLoop(dt, C.DIFFS[settings.diff].tps * app.watch.speed, watchStep);
      else if (app.stage === "attract") tickLoop(dt, 8, demoStep);
      else if (app.stage === "feed") tickLoop(dt, 26, feedStep);
      else if (app.stage === "ready") { app.frac = 0; }
      else app.frac = 0;
    }
    if (app.training) trainFrame();
    const run = app.stage === "attract" ? app.demo && app.demo.run : app.stage === "watch" ? app.watch && app.watch.run : app.stage === "feed" ? app.feed && app.feed.run : app.run;
    if (run && (run.dead || run.t >= run.cap)) app.frac = 0;
    if (run) app.laneDisp += (run.lane - app.laneDisp) * Math.min(1, dt * 22);
    app.scrollT += dt * 2;
    for (const p of app.particles) { p.x += p.vx; p.y += p.vy + 1.2; p.vx *= 0.95; p.vy *= 0.95; p.life -= dt * 1.4; }
    app.particles = app.particles.filter((p) => p.life > 0);
    app.shake = Math.max(0, app.shake - dt * 40); app.flash = Math.max(0, app.flash - dt * 2.5);
  }

  /* ---------------- panel UI ---------------- */
  function go(tab, keepStage) {
    if (app.help) toggleHelp(false);
    app.tab = tab; app.screen = tab;
    $$(".tab").forEach((t) => t.classList.toggle("on", t.id === "tab-" + tab));
    $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.go === tab));
    if (!keepStage) {
      if (tab === "title") { if (app.training) stopTraining(); setStage("attract"); newDemo(); }
      else if (tab === "play") { if (app.stage === "human" && app.run && !app.run.dead) app.paused = false; else if (!app.training) readyStage(); }
      else if (tab === "train") { if (app.stage === "human" && app.run && !app.run.dead) app.paused = true; if (!app.training && app.stage !== "watch" && app.stage !== "human") readyStage(); }
      else if (tab === "compare") { if (app.stage === "human" && app.run && !app.run.dead) app.paused = true; if (!app.training && app.stage !== "watch" && app.stage !== "human") readyStage(); }
    }
    renderAll();
  }
  function setDiff(d, silent) {
    if (!C.DIFFS[d]) return;
    if (app.training && d !== settings.diff) stopTraining();
    settings.diff = d; saveSettings();
    $$("#diff-seg button").forEach((b) => b.classList.toggle("on", b.dataset.diff === d));
    if (!silent) { app.watch = null; if (app.stage !== "attract") readyStage(); }
    renderAll();
  }
  function setTrack(id, silent) {
    if (id === "random") randomSeed = 1 + Math.floor(Math.random() * 1e6);
    settings.track = id; saveSettings();
    $("#track-sel").value = id;
    if (!silent) { app.watch = null; if (app.stage !== "attract" && !app.training) readyStage(); }
    renderAll();
  }
  function renderTracks() {
    const g = $("#track-grid");
    const cards = C.TRACKS.map((t) => {
      const hb = humanBest[key(t.id)], ab = aiBest[key(t.id)];
      return `<button class="tcard ${settings.track === t.id ? "on" : ""}" data-track="${t.id}"><b>${t.name}</b><span>seed ${t.seed} · ${C.DIFFS[settings.diff].name}</span><div class="sc"><i>You ${hb != null ? hb : "-"}</i><em>Bot ${ab ? ab.score : "-"}</em></div></button>`;
    });
    cards.push(`<button class="tcard ${settings.track === "random" ? "on" : ""}" data-track="random"><b>Surprise track</b><span>new random seed every time</span><div class="sc"><i>practice only</i></div></button>`);
    g.innerHTML = cards.join("");
  }
  function updatePlayStats() {
    const r = app.stage === "human" || app.stage === "ready" ? app.run : null;
    $("#ps-score").textContent = r ? r.score : 0;
    $("#ps-rows").textContent = r ? r.t : 0;
    $("#ps-cells").textContent = r ? r.cells : 0;
    $("#ps-speed").textContent = r && app.stage === "human" ? humanTps().toFixed(1) : C.DIFFS[settings.diff].tps.toFixed(1);
    const hb = humanBest[key(settings.track)], ab = aiBest[key(settings.track)];
    $("#ps-best").textContent = hb != null ? hb : "-";
    $("#ps-ai").textContent = ab ? ab.score : "-";
    $("#btn-pause").textContent = app.paused ? "Resume (P)" : "Pause (P)";
  }
  function renderTrainStats() {
    const b = brain(), ag = b.agent, hs = b.hist.score;
    $("#brain-title").textContent = `${C.DIFFS[settings.diff].name} brain · ${currentTrackName()}`;
    $("#ts-ep").textContent = ag.episodes.toLocaleString();
    $("#ts-eps").textContent = Math.round(ag.epsAt(ag.episodes) * 100) + "%";
    const lastN = hs.slice(-100);
    $("#ts-avg").textContent = lastN.length ? Math.round(lastN.reduce((a, v) => a + v, 0) / lastN.length) : 0;
    $("#ts-best").textContent = b.best;
    $("#ts-states").textContent = ag.statesSeen().toLocaleString();
    $("#ts-track-l").textContent = `bot score on ${currentTrackName()}`;
    const k = key(settings.track), ab = aiBest[k];
    $("#ts-track").textContent = app.training ? "..." : ab ? ab.score : (hasBrain() ? recordRun(latestPolicy(), currentSeed(), settings.diff).score : "-");
    $$("#ep-seg button").forEach((x) => x.classList.toggle("on", +x.dataset.n === settings.nEp));
    $$("#pace-seg button").forEach((x) => x.classList.toggle("on", x.dataset.pace === settings.pace));
    $$("#spd-seg button").forEach((x) => x.classList.toggle("on", +x.dataset.spd === settings.spd));
    $("#btn-train").disabled = !!app.training; $("#btn-stop-train").disabled = !app.training;
  }
  function renderCkpts() {
    const b = brain();
    const items = CKPTS.map((c) => {
      const have = !!b.snaps[c.ep];
      const sc = have && settings.track !== "random" ? evalTrack(settings.track, null, b.snaps[c.ep]).score : have ? recordRun(C.policyFromQ(b.snaps[c.ep]), currentSeed(), settings.diff).score : null;
      const on = app.watch && String(app.watch.which) === String(c.ep);
      return `<button class="ck ${have ? "" : "locked"} ${on ? "on" : ""}" data-ck="${c.ep}" ${have ? "" : "disabled"}><b>${c.name}</b><span>${c.ep.toLocaleString()} runs</span><i>${have ? sc : "locked"}</i></button>`;
    });
    const on = app.watch && app.watch.which === "latest";
    const lsc = hasBrain() ? recordRun(latestPolicy(), currentSeed(), settings.diff).score : "-";
    items.push(`<button class="ck ${on ? "on" : ""}" data-ck="latest"><b>Latest</b><span>${b.agent.episodes.toLocaleString()} runs</span><i>${lsc}</i></button>`);
    $("#ckpts").innerHTML = items.join("");
  }
  function renderThoughts() {
    const th = app.thought;
    if (!th || !app.watch) { $("#th-say").textContent = hasBrain() ? "Pick a checkpoint or press Watch to see what the bot is thinking. It scores each possible move from its cheat sheet." : "The bot is a blank slate. Press Train and watch the chart climb!"; ["0", "1", "2"].forEach((i) => { $("#qb-" + i).classList.remove("pick"); $("#qb-" + i + " i").style.width = "2%"; $("#qb-" + i + " b").textContent = "0"; }); return; }
    $("#th-say").textContent = th.text;
    const mn = Math.min(...th.q, 0), mx = Math.max(...th.q, 1);
    th.q.forEach((v, i) => {
      $("#qb-" + i).classList.toggle("pick", i === th.a);
      $("#qb-" + i + " i").style.width = (4 + 96 * (v - mn) / Math.max(1e-6, mx - mn)).toFixed(1) + "%";
      $("#qb-" + i + " b").textContent = (v >= 0 ? "+" : "") + v.toFixed(1);
    });
  }

  /* ---- training chart ---- */
  const ch = $("#chart"), chx = ch.getContext("2d"); fitCanvas(ch, 700, 200);
  function drawChart() {
    const c = chx, w = 700, h = 200, L = 44, R = 40, T = 16, B = 24;
    c.clearRect(0, 0, w, h);
    const b = brain(), hs = b.hist.score, he = b.hist.eps, n = hs.length;
    const xmax = Math.max(n + (app.training ? app.training.target - app.training.done : 0), 100);
    const hb = humanBest[key(settings.track)];
    let ymax = 100; for (const v of hs) if (v > ymax) ymax = v; if (hb && hb > ymax) ymax = hb;
    ymax = Math.ceil(ymax / 100) * 100;
    const X = (i) => L + (i / xmax) * (w - L - R), Y = (v) => T + (1 - v / ymax) * (h - T - B);
    c.strokeStyle = "#1e2160"; c.lineWidth = 1; c.fillStyle = "#6d73b0"; c.font = "11px Trebuchet MS, Segoe UI, sans-serif"; c.textAlign = "right";
    for (let k = 0; k <= 4; k++) { const v = (ymax * k) / 4, y = Y(v); c.beginPath(); c.moveTo(L, y); c.lineTo(w - R, y); c.stroke(); c.fillText(Math.round(v), L - 6, y + 4); }
    c.textAlign = "center";
    for (let k = 0; k <= 5; k++) { const i = Math.round((xmax * k) / 5); c.fillText(i.toLocaleString(), X(i), h - 8); }
    c.save(); c.translate(12, T + (h - T - B) / 2); c.rotate(-Math.PI / 2); c.fillText("score per practice run", 0, 0); c.restore();
    c.textAlign = "left"; c.fillStyle = "#b9a64a"; c.fillText("100%", w - R + 4, T + 8); c.fillText("0%", w - R + 4, h - B);
    // checkpoint lines
    let lastLbl = -1e9;
    for (const ck of CKPTS) if (ck.ep <= xmax) {
      const x = X(ck.ep); c.strokeStyle = b.snaps[ck.ep] ? "rgba(255,79,216,.35)" : "rgba(255,79,216,.12)"; c.setLineDash([3, 4]); c.beginPath(); c.moveTo(x, T); c.lineTo(x, h - B); c.stroke(); c.setLineDash([]);
      if (x - lastLbl > 46) { c.fillStyle = "rgba(255,79,216,.75)"; c.textAlign = "left"; c.fillText(ck.name, Math.min(x + 3, w - R - 40), T - 4); lastLbl = x; }
    }
    if (!n) { c.fillStyle = "#8f95c9"; c.font = "15px Trebuchet MS, Segoe UI, sans-serif"; c.textAlign = "center"; c.fillText("No practice yet. Press Train and watch this chart climb.", L + (w - L - R) / 2, h / 2); }
    // dots / buckets
    const cols = Math.floor(w - L - R);
    if (n <= cols * 2) {
      c.fillStyle = "rgba(125,140,255,.55)";
      for (let i = 0; i < n; i++) c.fillRect(X(i + 1) - 1, Y(hs[i]) - 1, 2.2, 2.2);
    } else {
      const per = n / cols;
      c.strokeStyle = "rgba(125,140,255,.35)"; c.lineWidth = 1;
      for (let x = 0; x < cols; x++) {
        const a = Math.floor(x * per), z = Math.min(n, Math.floor((x + 1) * per)); let mn = 1e9, mx = -1e9;
        for (let i = a; i < z; i++) { if (hs[i] < mn) mn = hs[i]; if (hs[i] > mx) mx = hs[i]; }
        if (z > a) { const px = X((a + z) / 2); c.beginPath(); c.moveTo(px, Y(mn)); c.lineTo(px, Y(mx)); c.stroke(); }
      }
    }
    // epsilon curve
    if (n) {
      c.strokeStyle = "rgba(255,228,94,.75)"; c.lineWidth = 1.5; c.setLineDash([5, 4]); c.beginPath();
      const step = Math.max(1, Math.floor(n / 400));
      for (let i = 0; i < n; i += step) { const x = X(i + 1), y = T + (1 - he[i]) * (h - T - B); i ? c.lineTo(x, y) : c.moveTo(x, y); }
      c.stroke(); c.setLineDash([]);
      // moving average
      const win = 50; let s = 0; c.strokeStyle = "#3be8ff"; c.lineWidth = 2.6; c.shadowColor = "#3be8ff"; c.shadowBlur = 8; c.beginPath();
      const st2 = Math.max(1, Math.floor(n / 700));
      for (let i = 0; i < n; i++) { s += hs[i]; if (i >= win) s -= hs[i - win]; if (i % st2 === 0 || i === n - 1) { const x = X(i + 1), y = Y(s / Math.min(win, i + 1)); i ? c.lineTo(x, y) : c.moveTo(x, y); } }
      c.stroke(); c.shadowBlur = 0;
    }
    if (hb != null && settings.track !== "random") { c.strokeStyle = "#ff4fd8"; c.lineWidth = 1.5; c.setLineDash([8, 5]); c.beginPath(); c.moveTo(L, Y(hb)); c.lineTo(w - R, Y(hb)); c.stroke(); c.setLineDash([]); c.fillStyle = "#ff4fd8"; c.textAlign = "left"; c.fillText(`your best ${hb}`, L + 6, Y(hb) - 5); }
    if (app.training) { const x = X(n); c.strokeStyle = "rgba(125,255,178,.6)"; c.beginPath(); c.moveTo(x, T); c.lineTo(x, h - B); c.stroke(); }
  }
  function chartPixels() { const d = chx.getImageData(0, 0, ch.width, ch.height).data; let k = 0; for (let i = 3; i < d.length; i += 16) if (d[i] > 0) k++; return k; }

  /* ---- compare ---- */
  const cc = $("#cmp-chart"), ccx = cc.getContext("2d"); fitCanvas(cc, 700, 180);
  function renderCompare() {
    const tid = settings.track === "random" ? C.TRACKS[0].id : settings.track;
    const t = trackById(tid), d = settings.diff;
    $("#cmp-sub").textContent = `${t.name} · seed ${t.seed} · ${C.DIFFS[d].name}. Same walls for both of you.`;
    const hb = humanBest[key(tid)];
    const now = hasBrain() ? evalTrack(tid).score : null;
    const ab = aiBest[key(tid)];
    const botBest = Math.max(now || 0, ab ? ab.score : 0) || null;
    $("#vs-you").textContent = hb != null ? hb : "-";
    $("#vs-bot").textContent = botBest != null ? botBest : "-";
    const mx = Math.max(hb || 0, botBest || 0, 1);
    $("#vs-you-bar").style.width = ((hb || 0) / mx * 100).toFixed(1) + "%";
    $("#vs-bot-bar").style.width = ((botBest || 0) / mx * 100).toFixed(1) + "%";
    let verdict;
    if (hb == null && botBest == null) verdict = "No scores yet. Play a run, then train the bot!";
    else if (hb == null) verdict = `The bot has ${botBest} here. Your turn: can you beat it?`;
    else if (botBest == null) verdict = `You have ${hb}. The bot hasn't practiced yet, so go train it!`;
    else if (hb > botBest) verdict = `YOU WIN by ${hb - botBest}! The bot needs more practice.`;
    else if (hb < botBest) verdict = `BOT WINS by ${botBest - hb}. It's had ${brain().agent.episodes.toLocaleString()} practice runs.`;
    else verdict = "It's a TIE!";
    $("#vs-verdict").textContent = verdict;
    // table
    const rows = C.TRACKS.map((tr) => {
      const h = humanBest[key(tr.id)], a = aiBest[key(tr.id)], nw = hasBrain() ? evalTrack(tr.id).score : null;
      const bb = Math.max(a ? a.score : 0, nw || 0) || null;
      const lead = h == null && bb == null ? "-" : (h || 0) >= (bb || 0) ? `<span class="lead-you">You</span>` : `<span class="lead-bot">Bot</span>`;
      return `<tr class="${tr.id === tid ? "on" : ""}"><td>${tr.name}</td><td class="n">${h != null ? h : "-"}</td><td class="n">${nw != null ? nw : "-"}</td><td class="n">${bb != null ? bb : "-"}${a ? ` <small class="muted">@${a.ep}</small>` : ""}</td><td>${lead}</td></tr>`;
    });
    $("#cmp-table tbody").innerHTML = rows.join("");
    drawCmpChart(tid, hb);
  }
  function drawCmpChart(tid, hb) {
    const c = ccx, w = 700, h = 180; c.clearRect(0, 0, w, h);
    const b = brain();
    const bars = CKPTS.map((ck) => ({ name: ck.name, sub: `${ck.ep} runs`, v: b.snaps[ck.ep] ? evalTrack(tid, null, b.snaps[ck.ep]).score : null }));
    bars.push({ name: "Latest", sub: `${b.agent.episodes} runs`, v: hasBrain() ? evalTrack(tid).score : null });
    const mx = Math.max(100, hb || 0, ...bars.map((x) => x.v || 0)) * 1.12;
    const L = 20, Bm = 38, T = 26, bw = (w - L * 2) / bars.length;
    c.fillStyle = "#cfd3ff"; c.font = "bold 13px Trebuchet MS, Segoe UI, sans-serif"; c.textAlign = "left"; c.fillText("How the bot got better on this exact track", L, 17);
    bars.forEach((x, i) => {
      const X = L + i * bw + 10, bh = x.v != null ? ((h - T - Bm) * x.v) / mx : 0, Y = h - Bm - bh;
      c.fillStyle = "#16184a"; rr(c, X, T, bw - 20, h - T - Bm, 8); c.fill();
      if (x.v != null) { const g = c.createLinearGradient(0, Y, 0, h - Bm); g.addColorStop(0, "#ff4fd8"); g.addColorStop(1, "#7a2b9c"); c.fillStyle = g; rr(c, X, Y, bw - 20, Math.max(4, bh), 8); c.fill(); c.fillStyle = "#fff"; c.textAlign = "center"; c.font = "bold 13px ui-monospace, Menlo, Consolas, monospace"; c.fillText(String(x.v), X + (bw - 20) / 2, Math.max(T + 14, Y - 5)); }
      else { c.fillStyle = "#4a4f88"; c.textAlign = "center"; c.font = "12px Trebuchet MS, Segoe UI, sans-serif"; c.fillText("locked", X + (bw - 20) / 2, h - Bm - 10); }
      c.fillStyle = "#cfd3ff"; c.font = "bold 12px Trebuchet MS, Segoe UI, sans-serif"; c.textAlign = "center"; c.fillText(x.name, X + (bw - 20) / 2, h - 22);
      c.fillStyle = "#6d73b0"; c.font = "11px Trebuchet MS, Segoe UI, sans-serif"; c.fillText(x.sub, X + (bw - 20) / 2, h - 8);
    });
    if (hb != null) { const y = h - Bm - ((h - T - Bm) * hb) / mx; c.strokeStyle = "#ffe45e"; c.lineWidth = 2; c.setLineDash([8, 5]); c.beginPath(); c.moveTo(L, y); c.lineTo(w - L, y); c.stroke(); c.setLineDash([]); c.fillStyle = "#ffe45e"; c.textAlign = "right"; c.font = "bold 12px Trebuchet MS, Segoe UI, sans-serif"; c.fillText(`YOUR BEST ${hb}`, w - L, y - 5); }
  }

  function renderAll() {
    renderTracks(); updatePlayStats(); renderTrainStats(); renderCkpts(); drawChart(); renderThoughts();
    if (app.tab === "compare") renderCompare();
    $("#btn-mute").textContent = settings.muted ? "Muted" : "Sound on";
    $("#btn-mute").classList.toggle("off", settings.muted);
    $("#chk-ghost").checked = !!settings.ghost;
  }
  function liveUI() {
    if (app.tab === "play") updatePlayStats();
    if (app.tab === "train") {
      if (app.training) { renderTrainStats(); drawChart(); }
      renderThoughts();
    }
  }

  function toggleHelp(force) {
    app.help = force != null ? !!force : !app.help;
    $("#help").classList.toggle("hidden", !app.help);
    if (app.help && app.stage === "human" && app.run && !app.run.dead) app.paused = true;
  }
  function toggleMute() { settings.muted = !settings.muted; saveSettings(); renderAll(); if (!settings.muted) sfx("click"); return settings.muted; }
  function togglePause() { if (app.stage === "human" || app.stage === "watch") { app.paused = !app.paused; updatePlayStats(); } }

  /* ---------------- events ---------------- */
  document.addEventListener("click", (e) => {
    const g = e.target.closest("[data-go]"); if (g) { sfx("click"); go(g.dataset.go); if (g.id === "btn-start") startHuman(); return; }
    const d = e.target.closest("[data-diff]"); if (d) { sfx("click"); setDiff(d.dataset.diff); return; }
    const t = e.target.closest("[data-track]"); if (t) { sfx("click"); setTrack(t.dataset.track); return; }
    const n = e.target.closest("[data-n]"); if (n) { settings.nEp = +n.dataset.n; saveSettings(); renderTrainStats(); return; }
    const p = e.target.closest("[data-pace]"); if (p) { settings.pace = p.dataset.pace; saveSettings(); renderTrainStats(); return; }
    const s = e.target.closest("[data-spd]"); if (s) { settings.spd = +s.dataset.spd; saveSettings(); if (app.watch) app.watch.speed = settings.spd; renderTrainStats(); return; }
    const ck = e.target.closest("[data-ck]"); if (ck && !ck.disabled) { sfx("click"); watch(ck.dataset.ck); return; }
  });
  const on = (id, fn) => $(id).addEventListener("click", (e) => { e.stopPropagation(); sfx("click"); fn(); });
  on("#btn-play", () => startHuman());
  on("#btn-retry", () => startHuman());
  on("#btn-pause", togglePause);
  on("#btn-over-watch", () => { go("train", true); watch("latest"); });
  on("#btn-over-train", () => { go("train"); startTraining(); });
  on("#btn-train", () => startTraining());
  on("#btn-stop-train", stopTraining);
  on("#btn-reset-brain", () => { if (confirm(`Wipe the ${C.DIFFS[settings.diff].name} brain and start over?`)) resetBrain(); });
  on("#btn-watch", () => watch("latest"));
  on("#btn-skip", skipWatch);
  on("#btn-stop-watch", stopWatch);
  on("#btn-mute", toggleMute);
  on("#btn-help", () => toggleHelp());
  on("#btn-title-help", () => toggleHelp(true));
  on("#btn-help-close", () => toggleHelp(false));
  on("#btn-race", () => { if (settings.track === "random") setTrack(C.TRACKS[0].id, true); settings.ghost = true; saveSettings(); go("play", true); startHuman({ ghost: true }); });
  on("#btn-cmp-watch", () => { if (settings.track === "random") setTrack(C.TRACKS[0].id, true); watch("latest"); go("compare", true); });
  on("#btn-retest", () => { refreshAiBest(); renderCompare(); toast("Re-tested the bot on every track"); });
  $("#chk-ghost").addEventListener("change", (e) => { settings.ghost = e.target.checked; saveSettings(); });
  $("#help").addEventListener("click", (e) => { if (e.target.id === "help") toggleHelp(false); });
  $("#track-sel").innerHTML = C.TRACKS.map((t) => `<option value="${t.id}">${t.name}</option>`).join("") + `<option value="random">Surprise track</option>`;
  $("#track-sel").addEventListener("change", (e) => setTrack(e.target.value));
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") { if (e.key !== "Escape") return; }
    const k = e.key;
    if (k === "ArrowLeft" || k === "a" || k === "A") { e.preventDefault(); humanMove(-1); return; }
    if (k === "ArrowRight" || k === "d" || k === "D") { e.preventDefault(); humanMove(1); return; }
    if (k === "m" || k === "M") { toggleMute(); return; }
    if (k === "h" || k === "H" || k === "?") { toggleHelp(); return; }
    if (k === "Escape") { if (app.help) toggleHelp(false); else if (app.stage === "watch") stopWatch(); return; }
    if (app.help) return;
    if (k === " " || k === "Enter") {
      e.preventDefault();
      if (app.tab === "title" || app.tab === "play" || app.tab === "compare" || (app.stage === "human" && app.run.dead)) { if (app.tab === "title") go("play", true); if (app.stage !== "human" || app.run.dead) startHuman(); }
      return;
    }
    if (k === "p" || k === "P") { togglePause(); return; }
    if (k === "t" || k === "T") { go("train"); startTraining(); return; }
    if (k === "w" || k === "W") { watch("latest"); return; }
    if (k === "1") go("play"); else if (k === "2") go("train"); else if (k === "3") go("compare");
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden && app.stage === "human" && app.run && !app.run.dead) { app.paused = true; } });

  /* ---------------- test API ---------------- */
  function state() {
    const r = app.stage === "watch" ? app.watch && app.watch.run : app.stage === "feed" ? app.feed && app.feed.run : app.stage === "attract" ? app.demo && app.demo.run : app.run;
    const b = brain();
    return {
      screen: app.screen, tab: app.tab, stage: app.stage, diff: settings.diff, track: settings.track, seed: currentSeed(),
      muted: settings.muted, help: app.help, paused: app.paused, training: !!app.training,
      run: r ? { t: r.t, score: r.score, lane: r.lane, cells: r.cells, dead: r.dead } : null,
      ghost: app.ghost ? { score: app.ghost.score, crashT: app.ghost.crashT } : null,
      brain: { episodes: b.agent.episodes, states: b.agent.statesSeen(), eps: b.agent.epsAt(b.agent.episodes), best: b.best, snaps: Object.keys(b.snaps).map(Number), hist: b.hist.score.length },
      humanBest: humanBest[key(settings.track)] ?? null, aiBest: aiBest[key(settings.track)] || null,
      watch: app.watch ? { which: app.watch.which, speed: app.watch.speed, t: app.watch.run.t, dead: app.watch.run.dead, score: app.watch.run.score } : null,
      thought: app.thought ? { a: app.thought.a, q: app.thought.q, text: app.thought.text } : null,
      overVisible: !$("#stage-over").classList.contains("hidden"), lastHuman: app.lastHuman,
    };
  }
  window.__TBA__ = {
    core: C, CKPTS, state, getState: state,
    reset() { try { Object.keys(localStorage).filter((k) => k.startsWith(LS)).forEach((k) => localStorage.removeItem(k)); } catch {} for (const d of Object.keys(brains)) delete brains[d]; for (const k of Object.keys(humanBest)) delete humanBest[k]; for (const k of Object.keys(aiBest)) delete aiBest[k]; app.training = null; app.watch = null; app.ghost = null; app.thought = null; Object.assign(settings, { diff: "normal", track: "neon-alley", muted: false, pace: "fast", nEp: 2000, spd: 2, ghost: false }); app.frozen = false; setDiff("normal", true); setTrack("neon-alley", true); go("title"); return state(); },
    go, setDiff, setTrack, startHuman, humanMove, humanTick(n = 1) { for (let i = 0; i < n && app.stage === "human" && !app.run.dead; i++) doHumanTick(); return state(); }, humanAuto,
    trainSync(n) { const s0 = brain().agent.episodes; trainEpisodes(n); saveBrain(); refreshAiBest(); renderAll(); return brain().agent.episodes - s0; },
    trainAsync: (n, pace) => startTraining(n, pace), stopTraining,
    evaluate: (trackId, ck) => { const b = brain(); return evalTrack(trackId || settings.track, null, ck ? b.snaps[ck] : null); },
    history: () => brain().hist.score.slice(),
    watch, watchTick(n = 1) { for (let i = 0; i < n; i++) watchStep(); return state(); }, skipWatch, stopWatch,
    toggleMute, toggleHelp, pause: (v) => { app.paused = v == null ? !app.paused : !!v; return app.paused; },
    freeze: (v) => { app.frozen = v == null ? true : !!v; return app.frozen; }, chartPixels, renderAll, resetBrain,
    setFrac: (f) => { app.frac = f; }, settle: () => { const r = app.stage === "watch" ? app.watch.run : app.stage === "feed" ? app.feed.run : app.run; if (r) app.laneDisp = r.lane; app.particles = []; app.shake = 0; app.flash = 0; app.banner = null; },
  };

  /* ---------------- boot ---------------- */
  initDemo();
  $$("#diff-seg button").forEach((b) => b.classList.toggle("on", b.dataset.diff === settings.diff));
  $("#track-sel").value = settings.track === "random" ? "random" : settings.track;
  go("title");
  requestAnimationFrame(frame);
})();
