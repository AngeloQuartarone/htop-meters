'use strict';

const vscode = require('vscode');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : stdout)
    );
  });

// ---------- metrics ----------

function cpuTimes() {
  return os.cpus().map((c) => ({ ...c.times }));
}

function cpuDelta(prev, curr) {
  return curr.map((t, i) => {
    const p = prev[i] || t;
    const d = {
      user: t.user - p.user,
      nice: t.nice - p.nice,
      sys: t.sys - p.sys,
      irq: t.irq - p.irq,
      idle: t.idle - p.idle,
    };
    const total = d.user + d.nice + d.sys + d.irq + d.idle;
    if (total <= 0) return { nice: 0, user: 0, sys: 0, irq: 0 };
    return { nice: d.nice / total, user: d.user / total, sys: d.sys / total, irq: d.irq / total };
  });
}

// Memory reaches the view as { total, used, segments: [{ bytes, cls }] }.

function fallbackMemory() {
  const total = os.totalmem();
  const used = total - os.freemem();
  return { total, used, segments: [{ bytes: used, cls: 'green' }] };
}

// /proc/meminfo, in bytes
async function meminfo() {
  try {
    const txt = await fs.promises.readFile('/proc/meminfo', 'utf8');
    const out = {};
    for (const line of txt.split('\n')) {
      const m = line.match(/^(\w+(?:\(\w+\))?):\s+(\d+)/);
      if (m) out[m[1]] = Number(m[2]) * 1024;
    }
    return out;
  } catch {
    return null;
  }
}

async function memory() {
  if (process.platform === 'darwin') return memoryDarwin();
  if (process.platform === 'linux') return memoryLinux();
  return fallbackMemory();
}

// Linux, like htop: used (green), buffers (blue), shared (magenta), cache (yellow).
async function memoryLinux() {
  const mi = await meminfo();
  if (!mi || !mi.MemTotal) return fallbackMemory();
  const total = mi.MemTotal;
  const buffers = mi.Buffers || 0;
  const shared = mi.Shmem || 0;
  const cache = Math.max(0, (mi.Cached || 0) + (mi.SReclaimable || 0) - shared);
  const used = Math.max(0, total - (mi.MemFree || 0) - buffers - cache - shared);
  return {
    total,
    used: used + shared,
    segments: [
      { bytes: used, cls: 'green' },
      { bytes: buffers, cls: 'blue' },
      { bytes: shared, cls: 'magenta' },
      { bytes: cache, cls: 'yellow' },
    ],
  };
}

// macOS, like Activity Monitor: app, wired, compressed, cached files.
async function memoryDarwin() {
  const total = os.totalmem();
  const out = await run('vm_stat', []);
  if (!out) return fallbackMemory();
  const pageSize = Number((out.match(/page size of (\d+) bytes/) || [])[1]) || 16384;
  const pages = (label) => {
    const m = out.match(new RegExp(label + ':\\s+(\\d+)'));
    return m ? Number(m[1]) * pageSize : 0;
  };
  const purgeable = pages('Pages purgeable');
  const app = Math.max(0, pages('Anonymous pages') - purgeable);
  const wired = pages('Pages wired down');
  const compressed = pages('Pages occupied by compressor');
  return {
    total,
    used: app + wired + compressed,
    segments: [
      { bytes: app, cls: 'green' },
      { bytes: wired, cls: 'blue' },
      { bytes: compressed, cls: 'magenta' },
      { bytes: pages('File-backed pages') + purgeable, cls: 'yellow' },
    ],
  };
}

// Swap: { total, used, cached }
async function swap() {
  if (process.platform === 'linux') {
    const mi = await meminfo();
    if (!mi || mi.SwapTotal === undefined) return null;
    const cached = mi.SwapCached || 0;
    return {
      total: mi.SwapTotal,
      used: Math.max(0, mi.SwapTotal - (mi.SwapFree || 0) - cached),
      cached,
    };
  }
  if (process.platform !== 'darwin') return null;
  const out = await run('sysctl', ['-n', 'vm.swapusage']);
  if (!out) return null;
  const val = (key) => {
    const m = out.match(new RegExp(key + '\\s*=\\s*([\\d.]+)([KMGT])'));
    if (!m) return 0;
    const mult = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2]];
    return Number(m[1]) * mult;
  };
  return { total: val('total'), used: val('used'), cached: 0 };
}

// Tasks: processes, threads, running threads.
async function tasks() {
  if (process.platform === 'linux') return tasksLinux();
  if (process.platform === 'darwin') return tasksDarwin();
  if (process.platform === 'win32') return winTasks.sample();
  return null;
}

// Linux: processes = numeric folders in /proc; threads and running ones from /proc/loadavg.
async function tasksLinux() {
  try {
    const [entries, loadavg] = await Promise.all([
      fs.promises.readdir('/proc'),
      fs.promises.readFile('/proc/loadavg', 'utf8'),
    ]);
    const procs = entries.filter((e) => e.charCodeAt(0) >= 48 && e.charCodeAt(0) <= 57).length;
    const m = loadavg.match(/(\d+)\/(\d+)/);
    return { procs, threads: m ? Number(m[2]) : procs, running: m ? Number(m[1]) : 0 };
  } catch {
    return null;
  }
}

// macOS: from `ps -A -M`, one line per thread.
async function tasksDarwin() {
  const out = await run('ps', ['-A', '-M']);
  if (!out) return null;
  const lines = out.split('\n').slice(1).filter((l) => l.trim());
  let procs = 0;
  let running = 0;
  for (const line of lines) {
    const isProc = line[0] !== ' ';
    if (isProc) procs++;
    const f = line.trim().split(/\s+/);
    const stat = isProc ? f[4] : f[2];
    if (stat && stat[0] === 'R') running++;
  }
  return { procs, threads: lines.length, running };
}

// Windows: neither /proc nor a ps that shows thread states, so the counts come
// from .NET's Process.GetProcesses(), in PowerShell. PowerShell takes about half
// a second to start, so one copy stays open and answers each line it reads with
// "procs threads running" (~30 ms); it exits when its stdin closes, which we do
// after WIN_IDLE_MS without requests (and which happens anyway if VS Code quits).
// Running = threads Ready (1), Running (2), Standby (3) or DeferredReady (7),
// like htop's R state. The System Idle Process (PID 0) is left out: its threads,
// one per core, are "Running" whenever that core is idle.
// The script has no double quotes, so it passes safely as a -Command argument
// (-Command needs no -ExecutionPolicy, unlike a .ps1 file).
const WIN_TASKS_PS = `
while ($null -ne [Console]::In.ReadLine()) {
  $procs = 0; $threads = 0; $running = 0
  try {
    foreach ($p in [Diagnostics.Process]::GetProcesses()) {
      try {
        if ($p.Id -ne 0) {
          $ts = $p.Threads
          $procs++
          $threads += $ts.Count
          foreach ($t in $ts) {
            $s = [int]$t.ThreadState
            if ($s -eq 1 -or $s -eq 2 -or $s -eq 3 -or $s -eq 7) { $running++ }
          }
        }
      } catch {} finally { $p.Dispose() }
    }
    [Console]::Out.WriteLine([string]$procs + ' ' + $threads + ' ' + $running)
  } catch { [Console]::Out.WriteLine('') }
}`;
const WIN_IDLE_MS = 30000; // longer than the longest refresh interval (10 s)
const WIN_REPLY_MS = 2000;

class WindowsTasks {
  constructor() {
    this.ps = null;
    this.buf = '';
    this.pending = []; // one resolver per line asked for, in order
    this.idle = null;
    this.answered = false; // the current PowerShell has answered at least once
    this.broken = false; // PowerShell can't run here (missing, blocked): stop trying
  }

  // Starts PowerShell if it isn't running; also called ahead of the first
  // sample, so that it starts while the view waits for it.
  start() {
    this.touch();
    if (this.ps || this.broken) return;
    const root = process.env.SystemRoot || 'C:\\Windows';
    const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let ps;
    try {
      ps = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WIN_TASKS_PS], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      this.broken = true;
      return;
    }
    this.ps = ps;
    this.buf = '';
    this.answered = false;
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (chunk) => this.read(chunk));
    ps.stdin.on('error', () => {}); // EPIPE, if it has just exited
    const gone = () => {
      if (this.ps !== ps) return;
      this.ps = null;
      if (!this.answered) this.broken = true; // it died at start: it would again
      this.flush();
    };
    ps.on('error', gone);
    ps.on('exit', gone);
  }

  sample() {
    this.start();
    const ps = this.ps;
    if (!ps) return Promise.resolve(null);
    return new Promise((resolve) => {
      // On timeout the resolver stays queued, to take the late line: lines and
      // requests stay paired.
      const timer = setTimeout(() => resolve(null), WIN_REPLY_MS);
      this.pending.push((t) => {
        clearTimeout(timer);
        resolve(t);
      });
      ps.stdin.write('\n');
    });
  }

  read(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const m = this.buf.slice(0, i).trim().match(/^(\d+) (\d+) (\d+)$/);
      this.buf = this.buf.slice(i + 1);
      this.answered = true;
      const resolve = this.pending.shift();
      if (resolve) resolve(m ? { procs: +m[1], threads: +m[2], running: +m[3] } : null);
    }
  }

  flush() {
    for (const resolve of this.pending.splice(0)) resolve(null);
  }

  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), WIN_IDLE_MS);
  }

  stop() {
    clearTimeout(this.idle);
    this.idle = null;
    const ps = this.ps;
    if (!ps) return;
    this.ps = null;
    this.flush();
    ps.stdin.end(); // PowerShell exits when its stdin closes
  }
}

const winTasks = new WindowsTasks();

// ---------- view ----------

const showTasks = () => vscode.workspace.getConfiguration('htopMeters').get('showTasks', true);

class HtopViewProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = null;
    this.timer = null;
    this.prevCpu = null;
    this.busy = false;
  }

  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);

    view.onDidChangeVisibility(() => (view.visible ? this.start() : this.stop()));
    view.onDidDispose(() => {
      this.stop();
      this.view = null;
    });
    view.webview.onDidReceiveMessage((msg) => {
      if (msg && msg.type === 'ready' && view.visible) this.start();
    });
  }

  interval() {
    const ms = vscode.workspace.getConfiguration('htopMeters').get('refreshInterval', 1500);
    return Math.min(10000, Math.max(500, Number(ms) || 1500));
  }

  start() {
    if (this.timer) return;
    this.prevCpu = cpuTimes();
    if (process.platform === 'win32' && showTasks()) winTasks.start();
    // a quick first sample, then at the configured pace
    this.timer = setTimeout(() => this.loop(), 300);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  restart() {
    if (this.timer) {
      this.stop();
      this.start();
    }
  }

  async loop() {
    await this.tick();
    if (this.timer) this.timer = setTimeout(() => this.loop(), this.interval());
  }

  async tick() {
    if (!this.view || this.busy) return;
    this.busy = true;
    try {
      const curr = cpuTimes();
      const cpus = cpuDelta(this.prevCpu || curr, curr);
      this.prevCpu = curr;
      const [mem, swp, tsk] = await Promise.all([memory(), swap(), showTasks() ? tasks() : null]);
      if (!this.view) return;
      this.view.webview.postMessage({
        type: 'data',
        cpus,
        mem,
        swap: swp,
        tasks: tsk,
        uptime: os.uptime(),
      });
    } finally {
      this.busy = false;
    }
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'view.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'view.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
</head>
<body>
<pre id="out"></pre>
<span id="probe">0000000000</span>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

// One copy of the section in each side bar view: only the visible one
// updates, so it costs as much as a single one.
const VIEW_IDS = [
  'htopMeters.explorer',
  'htopMeters.scm',
  'htopMeters.debug',
  'htopMeters.test',
  'htopMeters.view', // under the Claude Code sessions list
];

function activate(context) {
  const providers = VIEW_IDS.map((id) => {
    const p = new HtopViewProvider(context.extensionUri);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(id, p),
      { dispose: () => p.stop() }
    );
    return p;
  });
  context.subscriptions.push(
    { dispose: () => winTasks.stop() },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('htopMeters')) providers.forEach((p) => p.restart());
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
