#!/usr/bin/env node
/**
 * claude-dash — canlı Claude Code subagent + task panosu
 *
 *   node claude-dash.js install        hook'ları ~/.claude/settings.json'a ekler
 *   node claude-dash.js serve [--port 4317] [--open]
 *   node claude-dash.js hook           (hook tarafından çağrılır, elle çalıştırmayın)
 *   node claude-dash.js uninstall      hook'ları kaldırır
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const HOME = os.homedir();
const DIR = process.env.CLAUDE_DASH_DIR || path.join(HOME, '.claude', 'dash');
const PORT_DEFAULT = parseInt(process.env.CLAUDE_DASH_PORT || '4317', 10);
const SESSDIR = path.join(DIR, 'sessions');
const LEGACY  = path.join(DIR, 'events.jsonl');
const KEEP    = process.env.CLAUDE_DASH_KEEP === '1';
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const SELF = path.resolve(__filename);
const MAX_EVENTS_BYTES = 8 * 1024 * 1024;

function ensureDir() { fs.mkdirSync(SESSDIR, { recursive: true }); }

function sessFile(sid) {
  return path.join(SESSDIR, String(sid).replace(/[^A-Za-z0-9_.-]/g, '_') + '.jsonl');
}

/* ------------------------------------------------------------------ hook -- */

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(buf), 4000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(buf); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(buf); });
  });
}

function append(ev) {
  ensureDir();
  const file = sessFile(ev.sid);
  try {
    const st = fs.existsSync(file) ? fs.statSync(file) : null;
    if (st && st.size > MAX_EVENTS_BYTES) fs.writeFileSync(file, '');
  } catch (_) {}
  fs.appendFileSync(file, JSON.stringify(ev) + '\n');
}

function dropSession(sid) { try { fs.unlinkSync(sessFile(sid)); } catch (_) {} }

// Oturum açılışında sunucu ayakta değilse arka planda başlat.
function spawnServer() {
  try {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [SELF, 'serve', '--port', String(PORT_DEFAULT)], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  } catch (_) {}
}

function ensureServer() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT_DEFAULT, path: '/state.json', timeout: 1200 },
      (res) => { res.resume(); resolve(); }
    );
    req.on('error', () => { spawnServer(); resolve(); });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} });
  });
}

function short(s, n) {
  if (typeof s !== 'string') return '';
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// IDE/sistem bağlam etiketlerini ayıkla; slash komutlarını "/komut argüman" etiketine çevir;
// bildirim turlarında etiketi hiç değiştirme (boş text → sunucu tarafında eski label korunur).
function cleanPrompt(s) {
  if (typeof s !== 'string') return '';
  const cm = s.match(/<command-name>\s*\/?([^<\n]+?)\s*<\/command-name>/);
  if (cm) {
    const am = s.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const args = am ? am[1].replace(/\s+/g, ' ').trim() : '';
    return '/' + cm[1] + (args ? ' ' + args : '');
  }
  s = s.replace(/<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics)>[\s\S]*?<\/\1>/g, ' ').trim();
  if (/^(\[SYSTEM NOTIFICATION|<task-notification>)/.test(s)) return '';
  return s;
}

// mcp__server__tool → server:tool
function toolLabel(tool) {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool || '');
  return m ? m[1] + ':' + m[2] : (tool || '');
}

function baseName(fp) {
  if (typeof fp !== 'string' || !fp) return '';
  const a = fp.split(/[\\/]/).filter(Boolean);
  return a[a.length - 1] || fp;
}

// "şu an" satırı için tool girdisinden kısa, anlamlı bir özet
function toolDetail(tool, inp) {
  switch (tool) {
    case 'Bash': case 'PowerShell': return inp.description || inp.command || '';
    case 'Read': case 'Write': case 'Edit': return baseName(inp.file_path);
    case 'NotebookEdit': return baseName(inp.notebook_path);
    case 'Glob': case 'Grep': return inp.pattern || '';
    case 'WebFetch': return inp.url || '';
    case 'WebSearch': return inp.query || '';
    case 'Skill': return inp.skill || '';
    case 'SendMessage': return inp.to || '';
    default:
      for (const k of ['description', 'query', 'prompt', 'message', 'url', 'path', 'file_path']) {
        if (typeof inp[k] === 'string' && inp[k]) return inp[k];
      }
      return '';
  }
}

function wfName(inp) {
  if (inp && typeof inp.name === 'string' && inp.name) return inp.name;
  const m = /name\s*:\s*['"]([^'"]+)['"]/.exec((inp && inp.script) || '');
  return m ? m[1] : 'workflow';
}

async function runHook() {
  let p = {};
  try { p = JSON.parse((await readStdin() || '{}').replace(/^\uFEFF/, '')); } catch (_) {}
  const base = {
    t: Date.now(),
    sid: p.session_id || 'unknown',
    cwd: p.cwd || '',
  };
  const ev = p.hook_event_name;
  const tool = p.tool_name;
  const inp = p.tool_input || {};

  if (ev === 'SessionStart') {
    append({ ...base, kind: 'session_start', source: p.source || '' });
    await ensureServer();
  } else if (ev === 'SessionEnd') {
    if (KEEP) append({ ...base, kind: 'session_end' });
    else dropSession(base.sid);
  } else if (ev === 'UserPromptSubmit') {
    const raw = typeof p.prompt === 'string' ? p.prompt : '';
    if (/^\s*<task-notification>/.test(raw)) {
      // arka plan iş/subagent bitiş bildirimi: etiketi bozmadan ilgili kaydı kapatmakta kullanılır
      append({ ...base, kind: 'task_note', text: short(raw.replace(/<[^>]+>/g, ' '), 500) });
    } else {
      append({ ...base, kind: 'prompt', text: short(cleanPrompt(raw), 1000) });
    }
    // SessionStart görmeden uyanan (resume/bildirim) oturumlar için de sunucuyu garanti et.
    await ensureServer();
  } else if (ev === 'Stop') {
    append({ ...base, kind: 'idle' });
  } else if (ev === 'SubagentStop') {
    append({ ...base, kind: 'subagent_stop', id: p.agent_id || p.tool_use_id || '' });
  } else if (ev === 'Notification') {
    append({ ...base, kind: 'wait', msg: short(p.message || p.title || '', 160) });
  } else if (ev === 'PreToolUse') {
    if (tool === 'Task' || tool === 'Agent') {
      append({
        ...base, kind: 'task_start',
        id: p.tool_use_id || (inp.subagent_type + '|' + inp.description),
        agent: inp.subagent_type || 'agent',
        desc: short(inp.description || '', 90),
        prompt: short(inp.prompt || '', 300),
        model: inp.model || '',
      });
    } else if (tool === 'Workflow') {
      append({
        ...base, kind: 'task_start',
        id: p.tool_use_id || ('Workflow|' + wfName(inp)),
        agent: 'workflow', desc: short(wfName(inp), 90), prompt: '', model: '',
      });
    } else if ((tool === 'Bash' || tool === 'PowerShell') && inp.run_in_background) {
      append({
        ...base, kind: 'bg_start',
        id: p.tool_use_id || (tool + '|' + base.t),
        agent: tool.toLowerCase(),
        desc: short(inp.description || inp.command || '', 90),
      });
    } else if (tool && tool !== 'TodoWrite') {
      append({
        ...base, kind: 'tool_start',
        id: p.tool_use_id || (tool + '|' + base.t),
        tool: toolLabel(tool),
        detail: short(toolDetail(tool, inp), 90),
      });
    }
  } else if (ev === 'PostToolUse' && (tool === 'Task' || tool === 'Agent' || tool === 'Workflow')) {
    const r = p.tool_response;
    let ok = true, size = 0, bg = false;
    try {
      const txt = typeof r === 'string' ? r : JSON.stringify(r || '');
      size = txt.length;
      if (/\"?is_?error\"?\s*:\s*true/i.test(txt)) ok = false;
      // launch cevabı "arka planda başlatıldı" kokuyorsa iş bitmemiştir
      if (/\bbackground\b/i.test(txt) || /\b(agent|task|run)[_-]?id\b/i.test(txt) || /\bwf_[a-z0-9-]{4,}\b/.test(txt)) bg = true;
    } catch (_) {}
    append({
      ...base, kind: 'task_end',
      id: p.tool_use_id || (tool === 'Workflow' ? ('Workflow|' + wfName(inp)) : (inp.subagent_type + '|' + inp.description)),
      agent: tool === 'Workflow' ? 'workflow' : (inp.subagent_type || 'agent'),
      desc: short(tool === 'Workflow' ? wfName(inp) : (inp.description || ''), 90),
      ok, size, bg,
    });
  } else if (ev === 'PostToolUse' && tool === 'TodoWrite') {
    const todos = Array.isArray(inp.todos) ? inp.todos.map((x) => ({
      c: short(x.content || x.subject || '', 140),
      s: x.status || 'pending',
      a: short(x.activeForm || '', 140),
    })) : [];
    append({ ...base, kind: 'todos', todos });
  } else if (ev === 'PostToolUse' && tool) {
    append({ ...base, kind: 'tool_end', id: p.tool_use_id || '' });
  }
  process.exit(0);
}

/* ----------------------------------------------------------------- state -- */

function newSession(sid, cwd) {
  return {
    sid, cwd: cwd || '', label: '',
    startedAt: 0, lastActivity: 0,
    status: 'idle', ended: false,
    current: null, waiting: '',
    agents: [], agentIdx: {}, todos: [],
  };
}

function applyEvent(state, e) {
  if (!e || !e.sid) return;
  let s = state.sessions[e.sid];
  if (!s) { s = state.sessions[e.sid] = newSession(e.sid, e.cwd); s.startedAt = e.t; }
  if (e.cwd) s.cwd = e.cwd;
  s.lastActivity = e.t;

  switch (e.kind) {
    case 'session_start':
      s.startedAt = e.t; s.ended = false; s.status = 'idle';
      break;
    case 'session_end':
      s.ended = true; s.status = 'ended'; s.current = null; s.waiting = '';
      s.agents.forEach((a) => { if (a.status === 'running' || a.status === 'background') { a.status = 'unknown'; a.endedAt = e.t; } });
      break;
    case 'prompt':
      s.label = e.text || s.label; s.status = 'working'; s.ended = false;
      s.current = null; s.waiting = '';
      break;
    case 'idle':
      s.status = 'idle'; s.current = null; s.waiting = '';
      break;
    case 'wait':
      s.waiting = e.msg || 'onay/girdi bekleniyor';
      break;
    case 'tool_start':
      s.status = 'working'; s.waiting = '';
      s.current = { id: e.id, tool: e.tool, detail: e.detail || '', t: e.t };
      break;
    case 'tool_end':
      if (s.current && (!e.id || s.current.id === e.id)) s.current = null;
      s.waiting = '';
      break;
    case 'task_start': {
      s.status = 'working'; s.waiting = '';
      const a = {
        id: e.id, agent: e.agent, desc: e.desc, prompt: e.prompt || '',
        status: 'running', startedAt: e.t, endedAt: 0, size: 0, model: e.model || '',
      };
      s.agentIdx[e.id] = s.agents.length;
      s.agents.push(a);
      break;
    }
    case 'bg_start': {
      s.status = 'working'; s.waiting = '';
      const a = {
        id: e.id, agent: e.agent, desc: e.desc, prompt: '',
        status: 'background', startedAt: e.t, endedAt: 0, size: 0, model: '',
      };
      s.agentIdx[e.id] = s.agents.length;
      s.agents.push(a);
      break;
    }
    case 'task_end': {
      s.waiting = '';
      let i = s.agentIdx[e.id];
      if (i === undefined) {
        for (let j = s.agents.length - 1; j >= 0; j--) {
          if (s.agents[j].status === 'running' && s.agents[j].desc === e.desc) { i = j; break; }
        }
      }
      if (i === undefined) {
        s.agents.push({ id: e.id, agent: e.agent, desc: e.desc, prompt: '', status: e.ok ? 'done' : 'error', startedAt: e.t, endedAt: e.t, size: e.size || 0 });
      } else {
        const a = s.agents[i];
        if (e.ok && e.bg && e.t - a.startedAt < 20000) {
          // hızlı dönen "arka planda başlatıldı" cevabı: iş bitmedi, arka planda sürüyor
          a.status = 'background';
        } else {
          a.status = e.ok ? 'done' : 'error';
          a.endedAt = e.t;
          a.size = e.size || 0;
        }
      }
      break;
    }
    case 'subagent_stop': {
      const i = e.id ? s.agentIdx[e.id] : undefined;
      if (i !== undefined) {
        const a = s.agents[i];
        if (a.status === 'running' || a.status === 'background') { a.status = 'done'; a.endedAt = e.t; }
      } else {
        // kimlik yoksa temkinli davran: yalnızca tek arka plan ajanı varken kapat
        const fg = s.agents.filter((a) => a.status === 'running');
        const bg = s.agents.filter((a) => a.status === 'background');
        if (!fg.length && bg.length === 1) { bg[0].status = 'done'; bg[0].endedAt = e.t; }
      }
      break;
    }
    case 'task_note': {
      s.status = 'working'; s.waiting = ''; s.current = null;
      const txt = (e.text || '').toLowerCase();
      const failed = /(fail|error|abort|kill|exceed)/.test(txt);
      let hit = false;
      for (const a of s.agents) {
        if (a.status !== 'running' && a.status !== 'background') continue;
        const key = (a.desc || '').toLowerCase().slice(0, 40);
        if ((key.length >= 8 && txt.indexOf(key) >= 0) || (a.id && txt.indexOf(String(a.id).toLowerCase()) >= 0)) {
          a.status = failed ? 'error' : 'done'; a.endedAt = e.t; hit = true;
        }
      }
      if (!hit) {
        const bg = s.agents.filter((a) => a.status === 'background');
        if (bg.length === 1) { bg[0].status = failed ? 'error' : 'done'; bg[0].endedAt = e.t; }
      }
      break;
    }
    case 'todos':
      s.todos = e.todos || [];
      s.status = 'working'; s.waiting = '';
      break;
  }
}

function snapshot(state) {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const sessions = Object.values(state.sessions)
    .filter((s) => s.lastActivity >= cutoff)
    .sort((a, b) => {
      const act = (s) => s.agents.some((x) => x.status === 'running' || x.status === 'background');
      const ar = act(a) ? 0 : 1;
      const br = act(b) ? 0 : 1;
      return ar - br || b.lastActivity - a.lastActivity;
    })
    .map((s) => ({
      sid: s.sid, cwd: s.cwd, label: s.label,
      startedAt: s.startedAt, lastActivity: s.lastActivity,
      status: s.ended ? 'ended' : (s.waiting ? 'waiting' : s.status),
      waiting: s.waiting || '',
      current: s.current,
      todos: s.todos,
      agents: s.agents.map((a) => ({
        agent: a.agent, desc: a.desc, prompt: a.prompt, status: a.status,
        startedAt: a.startedAt, endedAt: a.endedAt, size: a.size, model: a.model,
      })),
    }));
  return { now: Date.now(), sessions };
}

/* ---------------------------------------------------------------- server -- */

function openBrowser(u) {
  // Tarayici acilamazsa sunucu ASLA olmemeli.
  try {
    const { spawn } = require('child_process');
    let cmd, args;
    if (process.platform === 'win32') {
      // "start" cmd.exe yerlesigidir, ayri bir program degil.
      cmd = process.env.COMSPEC || 'cmd.exe';
      args = ['/c', 'start', '', u];
    } else if (process.platform === 'darwin') {
      cmd = 'open'; args = [u];
    } else {
      cmd = 'xdg-open'; args = [u];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {
      process.stdout.write('  (tarayici otomatik acilamadi, adresi elle acin)\n');
    });
    child.unref();
  } catch (_) {}
}

function serve(port, doOpen) {
  ensureDir();
  if (fs.existsSync(LEGACY)) { try { fs.unlinkSync(LEGACY); } catch (_) {} }

  const state = { sessions: {} };
  const files = new Map(); // dosya adı -> { offset, tail, replay: [] }
  const clients = new Set();
  let everHadFiles = false;
  let emptyScans = 0;

  function scan() {
    let names = [];
    try { names = fs.readdirSync(SESSDIR).filter((n) => n.endsWith('.jsonl')); } catch (_) {}
    const onDisk = new Set(names);
    let changed = false;

    // Diskten silinen oturumlar panodan düşsün.
    for (const name of Array.from(files.keys())) {
      if (!onDisk.has(name)) { files.delete(name); changed = true; }
    }

    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const name of names) {
      const full = path.join(SESSDIR, name);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      if (st.mtimeMs < cutoff) {
        // SessionEnd alamadan ölen oturum artığı
        try { fs.unlinkSync(full); } catch (_) {}
        if (files.delete(name)) changed = true;
        continue;
      }
      let f = files.get(name);
      if (!f) { f = { offset: 0, tail: '', replay: [] }; files.set(name, f); }
      if (st.size < f.offset) { f.offset = 0; f.tail = ''; f.replay = []; changed = true; }
      if (st.size === f.offset) continue;
      let buf;
      try {
        const fd = fs.openSync(full, 'r');
        buf = Buffer.alloc(st.size - f.offset);
        fs.readSync(fd, buf, 0, buf.length, f.offset);
        fs.closeSync(fd);
      } catch (_) { continue; }
      f.offset = st.size;
      f.tail += buf.toString('utf8');
      const lines = f.tail.split('\n');
      f.tail = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { f.replay.push(JSON.parse(line)); changed = true; } catch (_) {}
      }
    }

    if (changed) {
      state.sessions = {};
      for (const f of files.values()) for (const e of f.replay) applyEvent(state, e);
      broadcast();
    }

    // Son oturum da kapanınca sunucu kendini kapatır (~2 sn kararlılık payı).
    if (files.size > 0) { everHadFiles = true; emptyScans = 0; }
    else if (everHadFiles && ++emptyScans >= 5) {
      process.stdout.write('\n  tüm oturumlar kapandı → sunucu kapanıyor\n');
      process.exit(0);
    }
  }

  function broadcast() {
    const payload = 'data: ' + JSON.stringify(snapshot(state)) + '\n\n';
    for (const res of clients) { try { res.write(payload); } catch (_) {} }
  }

  scan();

  setInterval(scan, 400);
  setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch (_) {} } }, 15000);

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      res.write('data: ' + JSON.stringify(snapshot(state)) + '\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url === '/state.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(snapshot(state), null, 2));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });

  server.listen(port, '127.0.0.1', () => {
    const u = 'http://127.0.0.1:' + port;
    process.stdout.write('\n  claude-dash çalışıyor →  ' + u + '\n  olay klasörü: ' + SESSDIR + '\n  durdurmak için Ctrl+C\n\n');
    if (doOpen) openBrowser(u);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('Port ' + port + ' dolu. Başka bir port deneyin: --port ' + (port + 1));
      process.exit(1);
    }
    throw err;
  });
}

/* ------------------------------------------------------------------ page -- */

const PAGE = `<!doctype html>
<html lang="tr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>claude-dash</title>
<style>
  :root{
    --bg:#0d0f12; --panel:#14171c; --panel2:#1a1e24; --line:#252a32;
    --fg:#e6e9ee; --dim:#8b95a3; --dim2:#5d6672;
    --run:#4aa8ff; --done:#3ecf8e; --err:#ff6b6b; --wait:#f0b429; --idle:#5d6672;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased}
  header{position:sticky;top:0;z-index:5;background:rgba(13,15,18,.92);
    backdrop-filter:blur(8px);border-bottom:1px solid var(--line);
    padding:12px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  h1{font-size:14px;font-weight:600;margin:0;letter-spacing:.3px}
  .pill{font-size:12px;color:var(--dim);background:var(--panel2);
    border:1px solid var(--line);border-radius:999px;padding:3px 10px}
  .pill b{color:var(--fg);font-weight:600}
  .live{display:inline-block;width:7px;height:7px;border-radius:50%;
    background:var(--done);margin-right:6px;vertical-align:middle}
  .live.off{background:var(--err)}
  main{padding:18px 20px 60px;display:flex;flex-direction:column;gap:16px;
    max-width:1400px;margin:0 auto}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .chead{display:flex;align-items:center;gap:10px;padding:12px 16px;
    border-bottom:1px solid var(--line);background:var(--panel2);flex-wrap:wrap}
  .dot{width:8px;height:8px;border-radius:50%;flex:none}
  .dot.working{background:var(--run);box-shadow:0 0 0 0 rgba(74,168,255,.6);animation:pulse 1.6s infinite}
  .dot.waiting{background:var(--wait);box-shadow:0 0 0 0 rgba(240,180,41,.6);animation:pulse 1.6s infinite}
  .dot.idle{background:var(--idle)} .dot.ended{background:var(--dim2)}
  @keyframes pulse{70%{box-shadow:0 0 0 7px rgba(74,168,255,0)}100%{box-shadow:0 0 0 0 rgba(74,168,255,0)}}
  .cwd{font-weight:600;font-size:13px}
  .sid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dim2)}
  .meta{margin-left:auto;font-size:12px;color:var(--dim);display:flex;gap:12px;align-items:center}
  .prompt{padding:9px 16px;font-size:12.5px;color:var(--dim);border-bottom:1px solid var(--line);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
  .prompt:hover{color:var(--fg)}
  .prompt.open{white-space:pre-wrap;overflow:visible;text-overflow:clip;word-break:break-word}
  .now{padding:8px 16px;font-size:12.5px;color:var(--run);border-bottom:1px solid var(--line);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .now .tname{font-weight:600}
  .now.wait{color:var(--wait)}
  .now.dimline{color:var(--dim2);font-style:italic}
  .cols{display:grid;grid-template-columns:1.25fr 1fr;gap:0}
  @media(max-width:820px){.cols{grid-template-columns:1fr}}
  .col{padding:12px 16px 16px}
  .col+.col{border-left:1px solid var(--line)}
  @media(max-width:820px){.col+.col{border-left:0;border-top:1px solid var(--line)}}
  .ctitle{font-size:11px;letter-spacing:.9px;text-transform:uppercase;color:var(--dim2);
    margin:0 0 10px;font-weight:600}
  .ctitle span{color:var(--dim);margin-left:6px}
  ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
  li{display:flex;gap:9px;align-items:flex-start;padding:7px 9px;border-radius:8px;
    background:var(--panel2);border:1px solid transparent;font-size:13px}
  li.running{border-color:rgba(74,168,255,.35);background:rgba(74,168,255,.07)}
  li.background{border-color:rgba(240,180,41,.35);background:rgba(240,180,41,.06)}
  li.background .time{color:var(--wait)}
  li.error{border-color:rgba(255,107,107,.35);background:rgba(255,107,107,.07)}
  .mark{font-family:ui-monospace,Menlo,monospace;font-size:12px;flex:none;width:14px;
    text-align:center;line-height:1.5}
  .mark.running{color:var(--run)} .mark.done{color:var(--done)}
  .mark.error{color:var(--err)} .mark.pending{color:var(--dim2)}
  .mark.unknown{color:var(--wait)}
  .mark.background{color:var(--wait)}
  .body{flex:1;min-width:0}
  .name{font-weight:600;font-size:12px;color:var(--run)}
  li.done .name,li.unknown .name{color:var(--dim)}
  .desc{color:var(--fg);word-break:break-word}
  li.done .desc{color:var(--dim)}
  .todo-done .desc{color:var(--dim2);text-decoration:line-through}
  .todo-active .desc{color:var(--fg);font-weight:600}
  .time{flex:none;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--dim2);
    padding-top:1px;min-width:46px;text-align:right}
  li.running .time{color:var(--run)}
  .empty{color:var(--dim2);font-size:12.5px;font-style:italic;padding:4px 2px}
  .spin{display:inline-block;animation:sp 1s steps(8) infinite}
  @keyframes sp{to{transform:rotate(360deg)}}
  .hint{color:var(--dim2);font-size:13px;text-align:center;padding:60px 20px;line-height:1.8}
  code{background:var(--panel2);border:1px solid var(--line);border-radius:5px;
    padding:2px 6px;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--fg)}
  .toggle{margin-left:auto;font-size:12px;color:var(--dim);cursor:pointer;user-select:none;
    display:flex;align-items:center;gap:6px}
  .toggle input{accent-color:var(--run)}
</style></head><body>
<header>
  <h1>claude-dash</h1>
  <span class="pill"><span class="live" id="live"></span><span id="conn">bağlanıyor…</span></span>
  <span class="pill">aktif subagent <b id="kRun">0</b></span>
  <span class="pill">açık görev <b id="kTodo">0</b></span>
  <label class="toggle"><input type="checkbox" id="onlyActive"> yalnızca aktif oturumlar</label>
</header>
<main id="root"><div class="hint">bekleniyor…</div></main>
<script>
var snap={now:Date.now(),sessions:[]}, skew=0, onlyActive=false, openPrompts={};
var MARK={running:'\\u25CF',done:'\\u2713',error:'\\u2717',pending:'\\u25CB',
          in_progress:'\\u25D0',completed:'\\u2713',unknown:'?',background:'\\u25D4'};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function dur(ms){ if(ms<0)ms=0; var s=Math.floor(ms/1000);
  if(s<60)return s+'s';
  var m=Math.floor(s/60), r=s%60;
  if(m<60)return m+'d '+(r<10?'0':'')+r+'s';
  var h=Math.floor(m/60); return h+'sa '+(m%60)+'d';}
function ago(ts){return dur(Date.now()+skew-ts)+' önce';}
function base(p){ if(!p)return '(dizin yok)'; var a=p.split(/[\\/\\\\]/).filter(Boolean); return a[a.length-1]||p;}
function isActive(a){return a.status==='running'||a.status==='background';}

function render(){
  var now=Date.now()+skew, root=document.getElementById('root');
  var sess=snap.sessions||[];
  if(onlyActive) sess=sess.filter(function(s){return s.status!=='ended';});
  var nRun=0,nTodo=0;
  sess.forEach(function(s){
    s.agents.forEach(function(a){if(isActive(a))nRun++;});
    s.todos.forEach(function(t){if(t.s!=='completed')nTodo++;});
  });
  document.getElementById('kRun').textContent=nRun;
  document.getElementById('kTodo').textContent=nTodo;

  if(!sess.length){
    root.innerHTML='<div class="hint">Henüz olay yok.<br><br>'+
      'Bir Claude Code oturumu başlatın; hook\\'lar kurulu ise<br>'+
      'subagent ve görev hareketleri burada anlık görünür.<br><br>'+
      '<code>node claude-dash.js install</code> ile hook\\'ları ekleyebilirsiniz.</div>';
    return;
  }
  root.innerHTML=sess.map(function(s){
    var agents=s.agents.slice().sort(function(a,b){
      var ar=isActive(a)?0:1, br=isActive(b)?0:1;
      return ar-br || b.startedAt-a.startedAt;});
    var running=s.agents.filter(isActive).length;
    var aHtml=agents.length? agents.map(function(a){
      var el=(isActive(a)? now-a.startedAt : a.endedAt-a.startedAt);
      var nm=a.agent+(a.status==='background'?' \\u00B7 arka plan':'');
      return '<li class="'+a.status+'" title="'+esc(a.prompt)+'">'+
        '<span class="mark '+a.status+'">'+(MARK[a.status]||'?')+'</span>'+
        '<span class="body"><span class="name">'+esc(nm)+'</span> '+
        '<span class="desc">'+esc(a.desc)+'</span></span>'+
        '<span class="time">'+dur(el)+'</span></li>';
    }).join('') : '<div class="empty">subagent / arka plan işi yok</div>';

    var open=s.todos.filter(function(t){return t.s!=='completed';}).length;
    var tHtml=s.todos.length? s.todos.map(function(t){
      var cls=t.s==='completed'?'todo-done':(t.s==='in_progress'?'todo-active':'');
      var txt=(t.s==='in_progress'&&t.a)?t.a:t.c;
      return '<li class="'+cls+'"><span class="mark '+(t.s==='in_progress'?'running':t.s==='completed'?'done':'pending')+'">'+
        (MARK[t.s]||'\\u25CB')+'</span><span class="body"><span class="desc">'+esc(txt)+'</span></span></li>';
    }).join('') : '<div class="empty">görev listesi boş</div>';

    var nowLine='';
    if(s.status==='waiting'){
      nowLine='<div class="now wait">\\u23F8 bekliyor: '+esc(s.waiting||'onay/girdi')+'</div>';
    }else if(s.current){
      nowLine='<div class="now">\\u2699 <span class="tname">'+esc(s.current.tool)+'</span>'+
        (s.current.detail?' \\u2014 '+esc(s.current.detail):'')+
        ' \\u00B7 '+dur(now-s.current.t)+'</div>';
    }else if(s.status==='working'){
      nowLine='<div class="now dimline">\\u270D yanıt hazırlanıyor\\u2026</div>';
    }

    return '<section class="card"><div class="chead">'+
      '<span class="dot '+s.status+'"></span>'+
      '<span class="cwd">'+esc(base(s.cwd))+'</span>'+
      '<span class="sid">'+esc(s.sid.slice(0,8))+'</span>'+
      '<span class="meta"><span>'+(running?('<span class="spin">\\u25E0</span> '+running+' aktif'):
        (s.status==='ended'?'bitti':s.status==='waiting'?'bekliyor':s.status==='working'?'çalışıyor':'boşta'))+'</span>'+
      '<span>'+ago(s.lastActivity)+'</span></span></div>'+
      (s.label?'<div class="prompt'+(openPrompts[s.sid]?' open':'')+'" data-sid="'+esc(s.sid)+
        '" title="tıkla: tam metni aç/kapat">\\u203A '+esc(s.label)+'</div>':'')+
      nowLine+
      '<div class="cols"><div class="col"><h2 class="ctitle">Subagent & arka plan'+
      '<span>'+s.agents.length+'</span></h2><ul>'+aHtml+'</ul></div>'+
      '<div class="col"><h2 class="ctitle">Görevler<span>'+open+' açık / '+s.todos.length+'</span></h2>'+
      '<ul>'+tHtml+'</ul></div></div></section>';
  }).join('');
}

document.getElementById('onlyActive').addEventListener('change',function(e){
  onlyActive=e.target.checked; render();});

document.getElementById('root').addEventListener('click',function(ev){
  var el=ev.target;
  while(el&&el.classList&&!el.classList.contains('prompt'))el=el.parentNode;
  if(!el||!el.classList||!el.classList.contains('prompt'))return;
  var sid=el.getAttribute('data-sid');
  openPrompts[sid]=!openPrompts[sid]; render();});

function connect(){
  var es=new EventSource('/events');
  es.onopen=function(){document.getElementById('live').className='live';
    document.getElementById('conn').textContent='canlı';};
  es.onmessage=function(ev){ snap=JSON.parse(ev.data); skew=snap.now-Date.now(); render();};
  es.onerror=function(){document.getElementById('live').className='live off';
    document.getElementById('conn').textContent='bağlantı koptu';};
}
connect();
setInterval(render,1000);
</script></body></html>`;

/* --------------------------------------------------------------- install -- */

const MARKER = 'claude-dash.js';
const CMD = `node "${JSON.stringify(SELF).slice(1, -1)}" hook`;
const HOOK_SPEC = [
  ['PreToolUse', '.*'],
  ['PostToolUse', '.*'],
  ['UserPromptSubmit', null],
  ['Stop', null],
  ['SubagentStop', null],
  ['Notification', null],
  ['SessionStart', null],
  ['SessionEnd', null],
];

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  const raw = fs.readFileSync(SETTINGS, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeSettings(obj) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, SETTINGS + '.claude-dash.bak');
  fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, 2) + '\n');
}

function stripOurs(list) {
  return (list || [])
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !(h.command || '').includes(MARKER)) }))
    .filter((g) => (g.hooks || []).length > 0);
}

function install() {
  let s;
  try { s = readSettings(); } catch (e) {
    console.error('~/.claude/settings.json okunamadı (geçersiz JSON?): ' + e.message);
    process.exit(1);
  }
  s.hooks = s.hooks || {};
  for (const [event, matcher] of HOOK_SPEC) {
    s.hooks[event] = stripOurs(s.hooks[event]);
    const entry = { hooks: [{ type: 'command', command: CMD, timeout: 5 }] };
    if (matcher) entry.matcher = matcher;
    s.hooks[event].push(entry);
  }
  writeSettings(s);
  console.log('Hook\'lar eklendi → ' + SETTINGS);
  console.log('Yedek: ' + SETTINGS + '.claude-dash.bak');
  console.log('\nÇalışan Claude Code oturumlarını yeniden başlatın (veya /hooks ile yeniden yükleyin).');
  console.log('Sonra:  node ' + SELF + ' serve --open');
}

function uninstall() {
  let s;
  try { s = readSettings(); } catch (e) { console.error(e.message); process.exit(1); }
  if (!s.hooks) { console.log('Kurulu hook yok.'); return; }
  for (const key of Object.keys(s.hooks)) {
    s.hooks[key] = stripOurs(s.hooks[key]);
    if (!s.hooks[key].length) delete s.hooks[key];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  writeSettings(s);
  console.log('claude-dash hook\'ları kaldırıldı.');
}

/* ------------------------------------------------------------------ main -- */

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'serve';
  const pi = args.indexOf('--port');
  const port = pi >= 0 ? parseInt(args[pi + 1], 10) : PORT_DEFAULT;

  if (cmd === 'hook') { runHook(); return; }
  if (cmd === 'install') { install(); return; }
  if (cmd === 'uninstall') { uninstall(); return; }
  if (cmd === 'reset') {
    ensureDir();
    let n = 0;
    try { if (fs.existsSync(LEGACY)) { fs.unlinkSync(LEGACY); n++; } } catch (_) {}
    try {
      for (const name of fs.readdirSync(SESSDIR)) {
        if (!name.endsWith('.jsonl')) continue;
        try { fs.unlinkSync(path.join(SESSDIR, name)); n++; } catch (_) {}
      }
    } catch (_) {}
    console.log('Olay geçmişi temizlendi (' + n + ' dosya silindi).');
    return;
  }
  if (cmd === 'serve') { serve(port, args.includes('--open')); return; }
  console.log('Kullanım: node claude-dash.js [install|serve|uninstall|reset] [--port N] [--open]');
  process.exit(1);
}

if (process.argv[2] === 'hook') {
  // hook asla oturumu bozmasın
  process.on('uncaughtException', () => process.exit(0));
  runHook();
} else {
  process.on('uncaughtException', (e) => {
    if (e && e.code === 'EADDRINUSE') { console.error(e.message); process.exit(1); }
    console.error('[claude-dash] yakalanan hata: ' + (e && e.message ? e.message : e));
  });
  main();
}
