// Minimal Chrome DevTools Protocol helper (Node 20 + --experimental-websocket).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch(opts = {}) {
  const port = opts.port || 9465;
  const w = opts.width || 1280;
  const h = opts.height || 800;
  const prof = mkdtempSync(join(tmpdir(), "tbacdp-"));
  const chrome = "/usr/bin/google-chrome";
  const proc = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
    "--allow-file-access-from-files", `--remote-debugging-port=${port}`,
    `--user-data-dir=${prof}`, `--window-size=${w},${h}`, "about:blank",
  ], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 120 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === "page");
    } catch {}
  }
  if (!target) { proc.kill(); throw new Error("chrome did not start"); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  let id = 0;
  const pending = new Map();
  const errors = [];
  const requests = [];
  ws.addEventListener("message", (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); }
    if (j.method === "Runtime.exceptionThrown") {
      errors.push(j.params.exceptionDetails.exception?.description || j.params.exceptionDetails.text);
    }
    if (j.method === "Runtime.consoleAPICalled" && j.params.type === "error") {
      errors.push("console.error: " + j.params.args.map((a) => a.value ?? a.description).join(" "));
    }
    if (j.method === "Log.entryAdded" && j.params.entry.level === "error") {
      errors.push("log: " + j.params.entry.text);
    }
    if (j.method === "Network.requestWillBeSent") {
      const u = j.params.request.url;
      if (!u.startsWith("data:") && !u.startsWith("file:") && !u.startsWith("blob:")) requests.push(u);
    }
  });
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id;
    pending.set(i, (j) => r(j.result || { error: j.error }));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Log.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: w, height: h, deviceScaleFactor: 1, mobile: false,
  });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error("eval failed: " + expr.slice(0, 100) + " :: " +
        (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  };
  const goto = async (url, waitMs = 400) => {
    await send("Page.navigate", { url });
    for (let i = 0; i < 80; i++) {
      await sleep(200);
      try {
        const ready = await ev("typeof window.__TBA__ === 'object' && document.readyState === 'complete'");
        if (ready) break;
      } catch {}
    }
    await sleep(waitMs);
  };
  const shot = async (path) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(r.data, "base64"));
  };
  const click = async (sel) => {
    await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('missing '+${JSON.stringify(sel)}); el.click(); })()`);
  };
  const close = async () => {
    try { ws.close(); } catch {}
    proc.kill();
    await sleep(300);
    rmSync(prof, { recursive: true, force: true });
  };
  return { send, ev, goto, shot, click, close, errors, requests, sleep };
}
