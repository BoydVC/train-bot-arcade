// Screenshot tour of Train-a-Bot Arcade via window.__TBA__ (1280x800).
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { copyFileSync } from "node:fs";
import { launch, sleep } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIST = pathToFileURL(join(ROOT, "dist", "train-bot-arcade.html")).href;
const OUT = join(ROOT, "screenshots");
const J = (x) => JSON.stringify(x);

async function main() {
  const c = await launch({ width: 1280, height: 800, port: 9466 });
  const T = (expr) => c.ev(`window.__TBA__.${expr}`);
  try {
    await c.goto(DIST, 600);
    await T("reset()");
    await sleep(1600);
    await c.shot(join(OUT, "01-title.png"));

    // human play mid-run
    await T("go('play')");
    await T("setTrack('neon-alley')");
    await sleep(200);
    await c.shot(join(OUT, "02-play-ready.png"));
    await T("startHuman({ghost:false})");
    await T("humanAuto(60)");
    await T("freeze(true)"); await T("settle()"); await T("setFrac(0.4)");
    await sleep(250);
    await c.shot(join(OUT, "03-play-midrun.png"));
    await T("freeze(false)");
    await T("humanAuto(4000)");
    await sleep(1400);
    await c.shot(join(OUT, "04-play-crash.png"));

    // training: run async at fast pace, grab mid-training frame
    await T("go('train')");
    await sleep(200);
    await c.ev("window.__TBA__.trainAsync(2000, 'fast'); 1");
    await sleep(2600);
    await c.shot(join(OUT, "05-training-live.png"));
    await c.ev("new Promise(r => { const iv = setInterval(() => { if (!window.__TBA__.state().training) { clearInterval(iv); r(1); } }, 100); })");
    await T("trainSync(3000)");
    await sleep(300);
    // watch the trained bot
    await T("watch('latest', 2)");
    await T("watchTick(140)");
    await T("freeze(true)"); await T("settle()"); await T("setFrac(0.3)");
    await sleep(300);
    await c.shot(join(OUT, "06-watch-bot-thinking.png"));
    await c.shot(join(OUT, "00-best-watch-bot-learn.png"));
    await T("freeze(false)");
    // newborn checkpoint for contrast
    await T("watch(10, 1)");
    await T("watchTick(8)");
    await T("freeze(true)"); await T("settle()");
    await sleep(250);
    await c.shot(join(OUT, "07-newborn-bot.png"));
    await T("freeze(false)");

    // compare + ghost race
    await T("stopWatch()");
    await T("go('compare')");
    await sleep(400);
    await c.shot(join(OUT, "08-compare.png"));
    await T("startHuman({ghost:true})");
    await T("humanAuto(30)");
    await T("freeze(true)"); await T("settle()"); await T("setFrac(0.5)");
    await sleep(250);
    await c.shot(join(OUT, "09-ghost-race.png"));
    await T("freeze(false)");
    await T("go('title')");
    await T("toggleHelp(true)");
    await sleep(300);
    await c.shot(join(OUT, "10-help.png"));
    await T("toggleHelp(false)");
    console.log("errors:", J(c.errors));
    console.log("requests:", J(c.requests));
    console.log("shots done");
  } finally {
    await c.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
