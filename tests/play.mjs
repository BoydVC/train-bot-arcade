// Headless Chrome playthrough of Train-a-Bot Arcade via window.__TBA__ + real key/click events.
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { launch, sleep } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIST = pathToFileURL(join(ROOT, "dist", "train-bot-arcade.html")).href;
const checks = [];
const check = (ok, msg, info = "") => checks.push({ ok: !!ok, msg, info: String(info) });

async function main() {
  const c = await launch({ width: 1280, height: 800, port: 9465 });
  const S = async () => JSON.parse(await c.ev("JSON.stringify(window.__TBA__.state())"));
  const key = (k, code) => c.ev(`document.dispatchEvent(new KeyboardEvent('keydown', {key: ${JSON.stringify(k)}, code: ${JSON.stringify(code || k)}, bubbles: true})); 1`);
  try {
    await c.goto(DIST, 500);
    check(await c.ev("typeof window.__TBA__ === 'object'"), "__TBA__ test API present");
    const title = await c.ev("document.title");
    check(title.includes("Train-a-Bot Arcade"), "document title", title);
    await c.ev("window.__TBA__.reset()");
    await sleep(500);
    let st = await S();
    check(st.tab === "title" && st.stage === "attract", "title screen with attract demo", `${st.tab}/${st.stage}`);
    const demoT0 = st.run ? st.run.t : -1;
    await sleep(900);
    st = await S();
    check(st.run && st.run.t > demoT0, "attract demo bot is moving", `${demoT0} -> ${st.run && st.run.t}`);
    check(await c.ev("!!document.querySelector('#tab-title.on h1')"), "title hero visible");

    // determinism: same seed + diff => identical track; different diff => different
    const det = await c.ev(`(() => { const C = window.__TBA__.core; const a = new C.Track(1013,'normal'), b = new C.Track(1013,'normal'), h = new C.Track(1013,'hard');
      let same = true, diff = false; for (let i = 0; i < 400; i++) { if (a.row(i).obs.join() !== b.row(i).obs.join() || a.row(i).cell !== b.row(i).cell) same = false; if (a.row(i).obs.join() !== h.row(i).obs.join()) diff = true; } return same && diff; })()`);
    check(det, "tracks are seed-deterministic (same seed = same walls)");
    const solv = await c.ev(`(() => { const C = window.__TBA__.core; let bad = 0;
      for (const t of C.TRACKS) for (const d of ['easy','normal','hard']) { const tr = new C.Track(t.seed, d); let reach = new Set([2]);
        for (let i = 0; i < 1500; i++) { const nx = new Set(); for (const l of reach) for (const a of [-1,0,1]) { const n = l + a; if (n < 0 || n > 4) continue; if (a && tr.row(i).obs[n]) continue; if (tr.row(i+1).obs[n]) continue; nx.add(n); } if (!nx.size) { bad++; break; } reach = nx; } } return bad; })()`);
    check(solv === 0, "every named track is survivable for 1,500 rows on all difficulties", `unsolvable=${solv}`);

    // Play via UI: Space from title starts a run
    await key(" ", "Space");
    await sleep(250);
    st = await S();
    check(st.tab === "play" && st.stage === "human" && st.run && !st.run.dead, "Space on title starts a human run", `${st.tab}/${st.stage}`);
    await c.ev("window.__TBA__.freeze(true)");
    const lane0 = (await S()).run.lane;
    await key("ArrowLeft");
    const lane1 = (await S()).run.lane;
    check(lane1 === lane0 - 1, "ArrowLeft switches lane", `${lane0} -> ${lane1}`);
    await c.ev("window.__TBA__.humanTick(1)");
    await key("d", "KeyD");
    const lane2 = (await S()).run.lane;
    check(lane2 === lane1 + 1, "D key switches lane right", `${lane1} -> ${lane2}`);
    await c.ev("window.__TBA__.freeze(false)");
    await sleep(600);
    st = await S();
    check(st.run.t >= 3, "game loop advances rows in real time", st.run.t);
    // pause
    await key("p", "KeyP");
    const tp = (await S()).run.t; await sleep(500); const tp2 = (await S()).run.t;
    check((await S()).paused && tp === tp2, "P pauses the run", `${tp}/${tp2}`);
    await key("p", "KeyP");
    // scripted human (a cautious kid that looks one row ahead) on a fresh run
    st = JSON.parse(await c.ev("window.__TBA__.startHuman(); JSON.stringify(window.__TBA__.humanAuto(5000))"));
    check(st.run.dead, "run ends in a crash", JSON.stringify(st.run));
    await sleep(900);
    st = await S();
    check(st.overVisible, "game-over card shown");
    check(st.humanBest >= st.lastHuman.score && st.humanBest > 20, "human best saved for track", `${st.humanBest}`);
    const lsHuman = await c.ev("localStorage.getItem('tba.v1.human') || ''");
    check(lsHuman.includes("neon-alley|normal"), "human best persisted to localStorage", lsHuman.slice(0, 80));
    const humanScore = st.humanBest;

    // Untrained bot = bad
    const untrained = JSON.parse(await c.ev("JSON.stringify(window.__TBA__.evaluate('neon-alley'))"));
    // Train synchronously and verify it improved
    await c.ev("window.__TBA__.go('train')");
    const n1 = await c.ev("window.__TBA__.trainSync(100)");
    const at100 = JSON.parse(await c.ev("JSON.stringify(window.__TBA__.evaluate('neon-alley'))"));
    const n2 = await c.ev("window.__TBA__.trainSync(2900)");
    check(n1 === 100 && n2 === 2900, "trainSync ran 3,000 practice runs", `${n1}+${n2}`);
    const hist = JSON.parse(await c.ev("JSON.stringify(window.__TBA__.history())"));
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const first = avg(hist.slice(0, 200)), lastA = avg(hist.slice(-200));
    check(lastA > first * 3, "practice scores improve (last 200 avg vs first 200 avg)", `${first.toFixed(1)} -> ${lastA.toFixed(1)}`);
    const trained = JSON.parse(await c.ev("JSON.stringify(window.__TBA__.evaluate('neon-alley'))"));
    check(trained.score > at100.score && trained.score > untrained.score, "greedy bot on Neon Alley improves with training", `untrained ${untrained.score}, @100 ${at100.score}, @3000 ${trained.score}`);
    let multi = 0;
    for (const t of ["neon-alley", "byte-canyon", "glitch-gulch", "char-circuit", "vic-velocity"]) multi += JSON.parse(await c.ev(`JSON.stringify(window.__TBA__.evaluate('${t}'))`)).score;
    check(multi / 5 > 250, "trained bot averages >250 across the 5 named tracks", (multi / 5).toFixed(0));
    st = await S();
    check(st.brain.snaps.includes(10) && st.brain.snaps.includes(100) && st.brain.snaps.includes(500) && st.brain.snaps.includes(2000), "checkpoints 10/100/500/2000 saved", st.brain.snaps.join(","));
    check(st.brain.states > 1000 && st.brain.eps < 0.05, "Q-table explored >1,000 situations and curiosity decayed", `${st.brain.states} states, eps ${st.brain.eps.toFixed(3)}`);
    const ckScores = JSON.parse(await c.ev("JSON.stringify([10,100,500,2000].map(k => window.__TBA__.evaluate('neon-alley', k).score))"));
    check(ckScores[3] > ckScores[0], "Pro checkpoint beats Newborn on same track", ckScores.join(" -> "));
    await sleep(200);
    const px = await c.ev("window.__TBA__.chartPixels()");
    check(px > 2000, "reward chart drawn", px);
    const ck = await c.ev("document.querySelectorAll('#ckpts .ck:not(.locked)').length");
    check(ck >= 5, "checkpoint chips unlocked in UI", ck);

    // Async training through the real UI button (Instant pace) + persistence
    await c.ev("document.querySelector('#pace-seg [data-pace=instant]').click(); document.querySelector('#ep-seg [data-n=\"500\"]').click(); 1");
    await c.click("#btn-train");
    await sleep(100);
    const wasTraining = (await S()).training;
    for (let i = 0; i < 50 && (await S()).training; i++) await sleep(100);
    st = await S();
    check(st.brain.episodes === 3500 && !st.training, "Train button runs +500 async episodes", `${wasTraining} -> ${st.brain.episodes}`);
    const saved = await c.ev("(localStorage.getItem('tba.v1.brain.normal') || '').length");
    check(saved > 1000, "brain persisted to localStorage", `${saved} chars`);

    // Watch mode
    await sleep(1200); // finishTraining auto-launches watch after 900ms
    st = await S();
    check(st.stage === "watch" && st.watch && st.watch.which === "latest", "auto watch of fresh brain after training", st.stage);
    await c.ev("window.__TBA__.watch('latest', 8)");
    await sleep(800);
    st = await S();
    check(st.watch.t > 10, "watch mode plays in real time at 8x", st.watch.t);
    check(st.thought && st.thought.q.length === 3 && /pick (Left|Stay|Right)/.test(st.thought.text), "bot 'thoughts' + Q-values shown", st.thought && st.thought.text);
    const bars = await c.ev("document.querySelectorAll('.qbar.pick').length");
    check(bars === 1, "chosen action highlighted in Q-bars", bars);
    await c.ev("window.__TBA__.skipWatch()");
    st = await S();
    check(st.watch.dead || st.watch.t >= 3000, "skip to end finishes the bot run", JSON.stringify(st.watch));
    await c.ev("window.__TBA__.watch(10, 1)");
    st = await S();
    check(String(st.watch.which) === "10", "can watch the Newborn checkpoint", st.watch.which);

    // Compare
    await c.click("[data-go=compare]");
    await sleep(200);
    const youTxt = await c.ev("document.querySelector('#vs-you').textContent");
    const botTxt = await c.ev("document.querySelector('#vs-bot').textContent");
    check(+youTxt === humanScore && +botTxt > 0, "compare shows human vs bot on same track", `you ${youTxt} bot ${botTxt}`);
    const rows = await c.ev("document.querySelectorAll('#cmp-table tbody tr').length");
    check(rows === 5, "compare table lists 5 tracks", rows);
    const verdict = await c.ev("document.querySelector('#vs-verdict').textContent");
    check(/WIN|TIE/.test(verdict), "verdict rendered", verdict);
    // Ghost race
    await c.click("#btn-race");
    await sleep(200);
    st = await S();
    check(st.stage === "human" && st.ghost && st.ghost.score > 0, "race the bot ghost on same track", JSON.stringify(st.ghost));

    // Mute + help
    await key("m", "KeyM");
    st = await S();
    check(st.muted === true, "M mutes");
    const muteLbl = await c.ev("document.querySelector('#btn-mute').textContent");
    check(/Muted/.test(muteLbl), "mute button reflects state", muteLbl);
    await key("m", "KeyM");
    check((await S()).muted === false, "M unmutes");
    await key("h", "KeyH");
    check((await S()).help && await c.ev("!document.querySelector('#help').classList.contains('hidden')"), "H opens help");
    await key("Escape");
    check(!(await S()).help, "Esc closes help");

    // Difficulty switch gives a separate brain; reload keeps normal brain
    await c.ev("document.querySelector('[data-diff=hard]').click(); 1");
    st = await S();
    check(st.diff === "hard" && st.brain.episodes === 0, "hard difficulty has its own fresh brain", `${st.diff} ${st.brain.episodes}`);
    await c.ev("document.querySelector('[data-diff=normal]').click(); 1");
    await c.goto(DIST, 600);
    st = await S();
    check(st.brain.episodes === 3500 && st.humanBest === humanScore, "reload restores brain + human best", `${st.brain.episodes} ${st.humanBest}`);
    const restored = JSON.parse(await c.ev("JSON.stringify(window.__TBA__.evaluate('neon-alley'))"));
    check(restored.score > 0, "restored brain still plays", restored.score);

    check(c.errors.length === 0, "no JS errors", c.errors.slice(0, 3).join(" | "));
    check(c.requests.length === 0, "no network requests", c.requests.slice(0, 3).join(" "));
  } catch (e) {
    check(false, "playthrough threw", e.message);
  } finally {
    await c.close();
  }
  const passed = checks.filter((x) => x.ok).length;
  console.log(JSON.stringify({ checks, passed, failed: checks.length - passed }));
}
main();
