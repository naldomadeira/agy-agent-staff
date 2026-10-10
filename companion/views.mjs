import http from 'node:http';

// Rendering for `top` (terminal) and `dashboard` (local web page). Both draw
// the same snapshot the companion builds (`status --json` plus jobs, runs,
// inbox and usage history), so the terminal, the browser and a script agree.

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

export function remaining(ms) {
  if (typeof ms !== 'number' || ms <= 0) return '';
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h${String(minutes % 60).padStart(2, '0')}m` : `${Math.round(hours / 24)}d`;
}

function age(seconds) {
  if (typeof seconds !== 'number') return '-';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/** Per worker and per model, from usage.jsonl: jobs, how many ended done,
 *  tokens and time. "Which model actually delivers" is the question. */
export function aggregateUsage(entries) {
  const by = (key) => {
    const map = new Map();
    for (const entry of entries) {
      const name = entry[key] || '-';
      const row = map.get(name) || { name, jobs: 0, done: 0, tokens: 0, seconds: 0, quota_deaths: 0, spent: 0 };
      row.jobs++;
      if (entry.status === 'done') row.done++;
      if (entry.status === 'quota_exhausted') row.quota_deaths++;
      row.tokens += Number(entry.tokens) || 0;
      row.seconds += Number(entry.duration_seconds) || 0;
      if (typeof entry.slack_start === 'number' && typeof entry.slack_end === 'number') row.spent += Math.max(0, entry.slack_start - entry.slack_end);
      map.set(name, row);
    }
    return [...map.values()].sort((a, b) => b.jobs - a.jobs);
  };
  const days = new Map();
  for (const entry of entries) {
    const day = String(entry.ts).slice(0, 10);
    days.set(day, (days.get(day) || 0) + 1);
  }
  return { by_worker: by('worker'), by_model: by('model'), per_day: [...days.entries()].sort().map(([day, jobs]) => ({ day, jobs })) };
}

// ---------------------------------------------------------------------------
// terminal
// ---------------------------------------------------------------------------

const ESC = '\x1b[';
const color = (code, text, on) => (on ? `${ESC}${code}m${text}${ESC}0m` : text);

function bar(percent, width, on) {
  if (typeof percent !== 'number') return color('2', '·'.repeat(width), on);
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  const code = percent >= 50 ? '32' : percent >= 5 ? '33' : '31';
  return color(code, '█'.repeat(filled), on) + color('2', '░'.repeat(width - filled), on);
}

function cell(pool, on) {
  const slack = pool.slack_percent;
  const text = typeof slack === 'number' ? `${String(Math.round(slack)).padStart(3)}%` : '   -';
  const reopen = pool.blocked_until ? ` ↻${remaining(Date.parse(pool.blocked_until) - Date.now())}` : '';
  return `${bar(slack, 10, on)} ${text}${reopen.padEnd(9)}`;
}

export function renderTop(snapshot, { width = 100, colorOn = true } = {}) {
  const on = colorOn;
  const s = snapshot.summary;
  const lines = [];
  lines.push(color('1', `agy pool · mode ${snapshot.mode} · gemini ${s.gemini.open}/${s.total} open · 3p ${s.third_party.open}/${s.total} open` +
    `${s.stale.length ? ` · ${s.stale.length} stale` : ''} · ${snapshot.generated_at.slice(11, 19)}`, on));
  lines.push('');
  lines.push(color('2', 'worker   gemini                    anthropic/3p              read   jobs', on));
  for (const worker of snapshot.workers) {
    if (worker.status === 'unavailable') continue;
    lines.push(`${worker.id.padEnd(8)} ${cell(worker.gemini, on)} ${cell(worker.third_party, on)} ${age(worker.quota_age_seconds).padStart(5)}  ${worker.active_jobs}/${worker.capacity}`);
  }
  lines.push('');
  const running = snapshot.jobs.filter((job) => job.status === 'running');
  lines.push(color('1', `running here (${running.length})`, on));
  for (const job of running) {
    lines.push(`  ${job.id}  ${job.worker || '-'}/${job.model || '-'}  ${job.phase || ''}  ${age(job.elapsed_seconds)}  ${job.last_activity || ''}`.slice(0, width));
  }
  if (!running.length) lines.push(color('2', '  (none)', on));
  const runs = snapshot.runs.filter((run) => run.status === 'running');
  if (runs.length) {
    lines.push('', color('1', 'runs', on));
    for (const run of runs) lines.push(`  ${run.id}  ${run.name}  ${run.done}/${run.total} done  ${run.waiting ? `${run.waiting} waiting for quota` : ''}`);
  }
  lines.push('', color('1', 'recent', on));
  for (const entry of snapshot.inbox.slice(-6).reverse()) {
    const mark = entry.status === 'done' || entry.status === 'finished' ? color('32', '✓', on) : color('31', '✗', on);
    lines.push(`  ${mark} ${String(entry.ts).slice(11, 16)} ${entry.job || entry.run}  ${entry.line || ''}`.slice(0, width + 10));
  }
  if (snapshot.usage.by_model.length) {
    lines.push('', color('1', 'last 14 days by model (jobs · done · quota deaths)', on));
    for (const row of snapshot.usage.by_model.slice(0, 6)) {
      lines.push(`  ${row.name.padEnd(28)} ${String(row.jobs).padStart(4)} · ${String(row.done).padStart(4)} · ${row.quota_deaths}`);
    }
  }
  lines.push('', color('2', 'q quit · r refresh · p probe stale readings', on));
  return lines.map((line) => line.slice(0, width + 40)).join('\n');
}

/** Redraw every `everyMs` until q/Ctrl-C. Without a TTY, print once. */
export async function runTop({ snapshot, probe, everyMs = 2000, out = process.stdout, input = process.stdin }) {
  if (!out.isTTY || !input.isTTY) {
    out.write(renderTop(await snapshot(), { colorOn: false }) + '\n');
    return;
  }
  let timer;
  let busy = false;
  const draw = async () => {
    if (busy) return;
    busy = true;
    try {
      const frame = renderTop(await snapshot(), { width: (out.columns || 100) - 2 });
      out.write(`${ESC}H${ESC}2J${frame}\n`);
    } finally {
      busy = false;
    }
  };
  out.write(`${ESC}?25l`);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  await new Promise((resolve) => {
    const stop = () => {
      clearInterval(timer);
      input.setRawMode(false);
      input.pause();
      out.write(`${ESC}?25h\n`);
      resolve();
    };
    input.on('data', async (key) => {
      if (key === 'q' || key === '\u0003') stop();
      else if (key === 'r') draw();
      else if (key === 'p') { out.write(`${ESC}H${ESC}2Jprobing stale readings…\n`); await probe(); draw(); }
    });
    timer = setInterval(draw, everyMs);
    draw();
  });
}

// ---------------------------------------------------------------------------
// web
// ---------------------------------------------------------------------------

/** Local dashboard: 127.0.0.1 only. `/` the page, `/api/snapshot` the JSON,
 *  `/events` a server-sent stream of snapshots every `everyMs`. */
export function serveDashboard({ snapshot, port = 7377, host = '127.0.0.1', everyMs = 3000, log = () => {} }) {
  const clients = new Set();
  let latest = null;
  const tick = async () => {
    try {
      latest = await snapshot();
      const data = `data: ${JSON.stringify(latest)}\n\n`;
      for (const res of clients) res.write(data);
    } catch (error) {
      log(`snapshot failed: ${error.message}`);
    }
  };
  const timer = setInterval(tick, everyMs);
  const server = http.createServer(async (req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      clients.add(res);
      if (latest) res.write(`data: ${JSON.stringify(latest)}\n\n`);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.url === '/api/snapshot') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(latest || await snapshot()));
      return;
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(DASHBOARD_HTML);
      return;
    }
    res.writeHead(404).end();
  });
  server.on('close', () => clearInterval(timer));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { tick(); resolve(server); });
  });
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>agy pool</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--text:#e6e8ee;--muted:#8b93a7;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--line:#262b36;--accent:#7aa2f7}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--panel:#fff;--text:#1d2330;--muted:#5b6474;--line:#e3e6ec;--accent:#3b5bdb}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif}
header{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
h1{font-size:18px;margin:0}.pill{padding:2px 8px;border-radius:999px;background:var(--panel);border:1px solid var(--line);color:var(--muted);font-size:12px}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:16px;padding:16px 20px}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;min-width:0}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 10px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}td,th{padding:5px 6px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}
th{color:var(--muted);font-weight:500;font-size:12px}.bar{height:8px;border-radius:4px;background:var(--line);overflow:hidden;width:90px;display:inline-block;vertical-align:middle;margin-right:6px}
.bar>i{display:block;height:100%}.muted{color:var(--muted)}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
svg{width:100%;height:80px}
@media (max-width:480px){main{grid-template-columns:1fr;padding:12px}section{padding:12px}}
</style></head><body>
<header><h1>agy pool</h1><span class="pill" id="mode">mode …</span><span class="pill" id="open">…</span><span class="muted" id="at"></span></header>
<main>
<section><h2>Accounts</h2><table id="workers"></table></section>
<section><h2>Jobs in this repository</h2><table id="jobs"></table></section>
<section><h2>Runs</h2><table id="runs"></table></section>
<section><h2>Recent</h2><table id="inbox"></table></section>
<section><h2>By model, last 14 days</h2><table id="models"></table></section>
<section><h2>Jobs per day</h2><svg id="days" viewBox="0 0 300 80" preserveAspectRatio="none"></svg></section>
</main>
<script>
const $=(id)=>document.getElementById(id);
const esc=(v)=>String(v??'').replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const rem=(iso)=>{if(!iso)return'';const m=Math.round((Date.parse(iso)-Date.now())/60000);if(m<=0)return'';return m<60?m+'m':Math.floor(m/60)+'h'+String(m%60).padStart(2,'0')+'m'};
const bar=(p)=>{if(typeof p!=='number')return'<span class="muted">—</span>';const c=p>=50?'var(--ok)':p>=5?'var(--warn)':'var(--bad)';return '<span class="bar"><i style="width:'+Math.max(0,Math.min(100,p))+'%;background:'+c+'"></i></span>'+Math.round(p)+'%'};
const pool=(q)=>bar(q.slack_percent)+(q.blocked_until?' <span class="muted">↻'+rem(q.blocked_until)+'</span>':'');
const rows=(head,list)=>'<tr>'+head.map((h)=>'<th>'+h+'</th>').join('')+'</tr>'+(list.length?list.join(''):'<tr><td class="muted" colspan="'+head.length+'">none</td></tr>');
function draw(s){
  $('mode').textContent='mode '+s.mode;$('open').textContent='gemini '+s.summary.gemini.open+'/'+s.summary.total+' · 3p '+s.summary.third_party.open+'/'+s.summary.total+(s.summary.stale.length?' · '+s.summary.stale.length+' stale':'');
  $('at').textContent='updated '+new Date(s.generated_at).toLocaleTimeString();
  $('workers').innerHTML=rows(['worker','gemini','anthropic/3p','read','jobs'],s.workers.filter((w)=>w.status!=='unavailable').map((w)=>'<tr><td>'+esc(w.id)+'</td><td>'+pool(w.gemini)+'</td><td>'+pool(w.third_party)+'</td><td class="muted">'+(w.quota_age_seconds==null?'—':Math.round(w.quota_age_seconds/60)+'m')+'</td><td>'+w.active_jobs+'/'+w.capacity+'</td></tr>'));
  $('jobs').innerHTML=rows(['job','status','worker/model','phase','last'],s.jobs.slice(0,15).map((j)=>'<tr><td>'+esc(j.id)+'</td><td class="'+(j.status==='done'?'ok':j.status==='running'?'warn':'bad')+'">'+esc(j.status)+(j.reason?' · '+esc(j.reason):'')+'</td><td>'+esc((j.worker||'-')+'/'+(j.model||'-'))+'</td><td>'+esc(j.phase||'')+'</td><td class="muted">'+esc(j.last_activity||'')+'</td></tr>'));
  $('runs').innerHTML=rows(['run','name','status','done'],s.runs.slice(-10).reverse().map((r)=>'<tr><td>'+esc(r.id)+'</td><td>'+esc(r.name)+'</td><td>'+esc(r.status)+'</td><td>'+r.done+'/'+r.total+(r.waiting?' · '+r.waiting+' waiting':'')+'</td></tr>'));
  $('inbox').innerHTML=rows(['time','job/run','outcome'],s.inbox.slice(-12).reverse().map((e)=>'<tr><td class="muted">'+esc(String(e.ts).slice(11,16))+'</td><td>'+esc(e.job||e.run)+'</td><td>'+esc(e.line)+'</td></tr>'));
  $('models').innerHTML=rows(['model','jobs','done','quota deaths','tokens'],s.usage.by_model.map((m)=>'<tr><td>'+esc(m.name)+'</td><td>'+m.jobs+'</td><td>'+m.done+'</td><td>'+m.quota_deaths+'</td><td>'+m.tokens.toLocaleString()+'</td></tr>'));
  const d=s.usage.per_day;const max=Math.max(1,...d.map((x)=>x.jobs));const w=300/Math.max(1,d.length);
  $('days').innerHTML=d.map((x,i)=>'<rect x="'+(i*w+1)+'" y="'+(80-x.jobs/max*76)+'" width="'+Math.max(1,w-2)+'" height="'+(x.jobs/max*76)+'" fill="var(--accent)"><title>'+x.day+': '+x.jobs+'</title></rect>').join('');
}
fetch('/api/snapshot').then((r)=>r.json()).then(draw);
new EventSource('/events').onmessage=(e)=>draw(JSON.parse(e.data));
</script></body></html>`;
