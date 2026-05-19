const $ = (id) => document.getElementById(id);

let cfg = null;
let alarm = null;

async function init() {
  cfg = await window.api.getConfig();
  $('interval').value = cfg.checkIntervalMinutes || 5;
  renderTargets([]);
}

function renderTargets(results) {
  const list = $('targets');
  list.innerHTML = '';
  for (const t of cfg.targets) {
    const r = results.find((x) => x.target === t.name);
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = t.name;
    const status = document.createElement('span');
    status.className = 'status ' + (r ? r.status : 'idle');
    status.textContent = r ? `${r.status}` + (r.detail ? ` — ${r.detail}` : '') : 'idle';
    li.appendChild(label);
    li.appendChild(status);
    list.appendChild(li);
  }
}

function setRunning(running) {
  $('badge').className = 'badge ' + (running ? 'running' : 'stopped');
  $('badge').textContent = running ? 'watching' : 'stopped';
  $('startBtn').disabled = running;
  $('stopBtn').disabled = !running;
}

function appendLog(line) {
  const el = $('log');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}

function startAlarm() {
  stopAlarm();
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    alarm = { ctx, oscillators: [] };
    let t = ctx.currentTime;
    for (let i = 0; i < 8; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = i % 2 === 0 ? 880 : 660;
      g.gain.value = 0.0;
      g.gain.setValueAtTime(0.0, t);
      g.gain.linearRampToValueAtTime(0.25, t + 0.02);
      g.gain.linearRampToValueAtTime(0.0, t + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.4);
      alarm.oscillators.push(o);
      t += 0.45;
    }
  } catch (_) {}
}
function stopAlarm() {
  if (!alarm) return;
  try { alarm.ctx.close(); } catch (_) {}
  alarm = null;
}

$('loginBtn').onclick = async () => {
  appendLog('[ui] opening login window...');
  const r = await window.api.openLogin();
  if (!r.ok) appendLog('[ui] login open failed: ' + r.error);
};
$('startBtn').onclick = () => window.api.start();
$('stopBtn').onclick = () => { window.api.stop(); stopAlarm(); };
$('checkBtn').onclick = () => window.api.checkNow();
$('saveCfgBtn').onclick = async () => {
  const v = parseInt($('interval').value, 10);
  if (!Number.isFinite(v) || v < 1) return;
  cfg.checkIntervalMinutes = v;
  await window.api.saveConfig(cfg);
  appendLog('[ui] interval saved: ' + v + ' min');
};
$('openFolderBtn').onclick = () => window.api.openFolder();
$('openShotBtn').onclick = () => window.api.openLastScreenshot();

window.api.onLog(appendLog);
window.api.onStatus((s) => {
  setRunning(s.running);
  if (s.lastResults) renderTargets(s.lastResults);
});
window.api.onSlotFound((r) => {
  $('badge').className = 'badge alert';
  $('badge').textContent = 'SLOT FOUND';
  appendLog('[ui] *** SLOT FOUND: ' + r.target + ' ***');
  startAlarm();
});

init();
