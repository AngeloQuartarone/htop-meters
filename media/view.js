// @ts-check
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const out = /** @type {HTMLElement} */ (document.getElementById('out'));
  const probe = /** @type {HTMLElement} */ (document.getElementById('probe'));

  const LABEL_W = 3; // "  0", "Mem", "Swp"
  const MIN_INNER = 12; // minimum width inside the brackets to show two columns
  let last = null;

  // ---------- formatting, as in htop ----------

  // htop's Meter_humanUnit: K/M/G/T, 2 decimals below 10, 1 below 100, then integers.
  function human(bytes) {
    const units = ['K', 'M', 'G', 'T', 'P'];
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    const digits = v < 10 ? 2 : v < 100 ? 1 : 0;
    return v.toFixed(i === 0 ? 0 : digits) + units[i];
  }

  function uptime(sec) {
    const days = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const pad = (n) => String(n).padStart(2, '0');
    const clock = `${pad(h)}:${pad(m)}:${pad(s)}`;
    if (days === 0) return clock;
    return `${days} day${days > 1 ? 's' : ''}, ${clock}`;
  }

  // ---------- drawing ----------

  function spans(cells) {
    let html = '';
    let cls = null;
    let buf = '';
    for (const [ch, c] of cells) {
      if (c !== cls) {
        if (buf) html += cls ? `<span class="${cls}">${buf}</span>` : buf;
        cls = c;
        buf = '';
      }
      buf += ch;
    }
    if (buf) html += cls ? `<span class="${cls}">${buf}</span>` : buf;
    return html;
  }

  /**
   * An htop bar: label[|||||     text]
   * The text is right-aligned inside the bar; where the bar covers it, it takes the
   * segment's color, elsewhere it is grey (htop's BAR_SHADOW).
   * @param {string} label
   * @param {{frac:number, cls:string}[]} segments
   * @param {string} text
   * @param {number} width total width in characters
   */
  function bar(label, segments, text, width) {
    const inner = Math.max(1, width - LABEL_W - 2);
    if (text.length > inner) text = text.slice(text.length - inner);
    const textStart = inner - text.length;

    /** @type {(string|null)[]} */
    const colors = new Array(inner).fill(null);
    let pos = 0;
    for (const seg of segments) {
      if (!(seg.frac > 0.0005)) continue;
      const n = Math.min(inner - pos, Math.ceil(Math.min(1, seg.frac) * inner));
      for (let k = 0; k < n; k++) colors[pos + k] = seg.cls;
      pos += n;
      if (pos >= inner) break;
    }

    /** @type {[string, string|null][]} */
    const cells = [];
    for (let k = 0; k < inner; k++) {
      const inText = k >= textStart;
      const ch = inText ? text[k - textStart] : colors[k] ? '|' : ' ';
      cells.push([ch, colors[k] || (inText ? 'shadow' : null)]);
    }

    return (
      `<span class="lbl">${label.padStart(LABEL_W)}</span>` +
      `<span class="br">[</span>${spans(cells)}<span class="br">]</span>`
    );
  }

  function cpuBar(i, c, width) {
    const total = c.nice + c.user + c.sys + c.irq;
    const segs = [
      { frac: c.nice, cls: 'blue' },
      { frac: c.user, cls: 'green' },
      { frac: c.sys, cls: 'red' },
      { frac: c.irq, cls: 'yellow' },
    ];
    return bar(String(i), segs, (total * 100).toFixed(1) + '%', width);
  }

  function columns() {
    const cw = probe.getBoundingClientRect().width / 10 || 7;
    return Math.max(LABEL_W + 8, Math.floor(out.clientWidth / cw));
  }

  function render() {
    const d = last;
    if (!d) return;
    const cols = columns();
    const lines = [];

    // CPU: two columns like htop when there is room, otherwise one
    const n = d.cpus.length;
    const colW = Math.floor((cols - 1) / 2);
    if (n > 1 && colW - LABEL_W - 2 >= MIN_INNER) {
      const half = Math.ceil(n / 2);
      for (let r = 0; r < half; r++) {
        const left = cpuBar(r, d.cpus[r], colW);
        const j = r + half;
        const right = j < n ? cpuBar(j, d.cpus[j], colW) : '';
        lines.push(left + ' ' + right);
      }
    } else {
      d.cpus.forEach((c, i) => lines.push(cpuBar(i, c, cols)));
    }

    // Mem: the extension picks the segments and colors for each system
    const m = d.mem;
    lines.push(
      bar(
        'Mem',
        m.segments.map((s) => ({ frac: s.bytes / m.total, cls: s.cls })),
        `${human(m.used)}/${human(m.total)}`,
        cols
      )
    );

    // Swp: used (red), cached (yellow)
    if (d.swap) {
      const s = d.swap;
      const frac = (b) => (s.total > 0 ? b / s.total : 0);
      lines.push(
        bar(
          'Swp',
          [
            { frac: frac(s.used), cls: 'red' },
            { frac: frac(s.cached), cls: 'yellow' },
          ],
          `${human(s.used)}/${human(s.total)}`,
          cols
        )
      );
    }

    // Tasks and Uptime, like htop's right column
    if (d.tasks) {
      const t = d.tasks;
      lines.push(
        `<span class="lbl">Tasks: </span><span class="val">${t.procs}</span>` +
          `<span class="lbl">, </span><span class="val">${t.threads}</span>` +
          `<span class="lbl"> thr; </span><span class="run">${t.running}</span>` +
          `<span class="lbl"> running</span>`
      );
    }
    lines.push(`<span class="lbl">Uptime: </span><span class="val">${uptime(d.uptime)}</span>`);

    out.innerHTML = lines.join('\n');
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'data') {
      last = e.data;
      render();
    }
  });

  new ResizeObserver(() => render()).observe(out);
  vscode.postMessage({ type: 'ready' });
})();
