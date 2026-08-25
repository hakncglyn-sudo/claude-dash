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
  // subagent içinden gelen olaylar agent_id taşır → ilgili satıra bağlanır, oturumun "şu an"ını ezmez
  if (p.agent_id) { base.aid = String(p.agent_id); base.atype = p.agent_type || ''; }
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
  } else if (ev === 'SubagentStart') {
    append({ ...base, kind: 'subagent_start', id: String(p.agent_id || ''), agent: p.agent_type || 'agent' });
  } else if (ev === 'PermissionRequest') {
    // çıktı vermiyoruz → Claude normal izin ekranına düşer; biz sadece "seni bekliyor" diye gösteririz
    append({ ...base, kind: 'perm', id: p.tool_use_id || '', tool: toolLabel(tool), detail: short(toolDetail(tool, inp), 160) });
  } else if (ev === 'TaskCreated' || ev === 'TaskCompleted') {
    // alan adları resmî dokümanda yok; savunmacı oku
    const text = short(p.task_subject || p.subject || p.task_description || p.description || p.task_title || '', 140);
    append({ ...base, kind: ev === 'TaskCreated' ? 'task_new' : 'task_done', tid: String(p.task_id || p.id || ''), text });
  } else if (ev === 'Notification') {
    append({ ...base, kind: 'wait', ntype: p.notification_type || '', msg: short(p.message || p.title || '', 160) });
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
    current: null, waiting: '', perm: null,
    recent: [],
    agents: [], agentIdx: {}, todos: [],
  };
}

function findByAid(s, aid) {
  if (!aid) return null;
  for (let i = s.agents.length - 1; i >= 0; i--) if (s.agents[i].aid === aid) return s.agents[i];
  return null;
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
      s.current = null; s.waiting = ''; s.perm = null;
      break;
    case 'idle':
      s.status = 'idle'; s.current = null; s.waiting = ''; s.perm = null;
      break;
    case 'wait':
      if (e.ntype === 'idle_prompt') { s.status = 'idle'; s.current = null; break; }
      if (!s.perm) s.waiting = e.msg || 'onay/girdi bekleniyor';
      break;
    case 'perm':
      s.perm = { id: e.id || '', tool: e.tool || '', detail: e.detail || '', t: e.t };
      s.waiting = (e.tool || 'araç') + (e.detail ? ' — ' + e.detail : '');
      break;
    case 'tool_start': {
      s.status = 'working'; s.waiting = ''; s.perm = null;
      const cur = { id: e.id, tool: e.tool, detail: e.detail || '', t: e.t };
      const a = findByAid(s, e.aid);
      if (a) { a.current = cur; break; }
      s.current = cur;
      s.recent.push({ tool: e.tool, t: e.t });
      if (s.recent.length > 6) s.recent.shift();
      break;
    }
    case 'tool_end': {
      const a = findByAid(s, e.aid);
      if (a) a.current = null;
      else if (s.current && (!e.id || s.current.id === e.id)) s.current = null;
      s.waiting = ''; s.perm = null;
      break;
    }
    case 'subagent_start': {
      if (!e.id || findByAid(s, e.id)) break;
      const open = s.agents.filter((x) => (x.status === 'running' || x.status === 'background') && !x.aid).reverse();
      let a = open.find((x) => x.agent === e.agent) || open.find((x) => x.agent !== 'workflow');
      if (a && e.t - a.startedAt < 15000) { a.aid = e.id; break; }
      // task_start'sız doğan ajan (workflow'un iç ajanı gibi): aktif workflow'un altına çocuk satır
      const wf = s.agents.slice().reverse().find((x) => x.agent === 'workflow' && (x.status === 'running' || x.status === 'background'));
      a = { id: 'sa|' + e.id, aid: e.id, agent: e.agent, desc: '', prompt: '', status: 'running',
        startedAt: e.t, endedAt: 0, size: 0, model: '', parent: wf ? wf.id : '' };
      s.agentIdx[a.id] = s.agents.length;
      s.agents.push(a);
      break;
    }
    case 'task_new': {
      if (!e.text && !e.tid) break;
      const it = { id: e.tid, c: e.text || e.tid, s: 'pending', a: '' };
      const k = e.tid ? s.todos.findIndex((t) => t.id === e.tid) : -1;
      if (k >= 0) s.todos[k] = it; else s.todos.push(it);
      break;
    }
    case 'task_done': {
      const k = e.tid ? s.todos.findIndex((t) => t.id === e.tid) : -1;
      if (k >= 0) s.todos[k].s = 'completed';
      else if (e.text) s.todos.push({ id: e.tid, c: e.text, s: 'completed', a: '' });
      break;
    }
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
      let i = e.id ? s.agentIdx[e.id] : undefined;
      if (i === undefined && e.id) { const k = s.agents.findIndex((x) => x.aid === e.id); if (k >= 0) i = k; }
      if (i !== undefined) {
        const a = s.agents[i];
        a.current = null;
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
      // sıra: seni bekliyor › aktif subagent › çalışıyor › boşta › bitti; eşitlikte son etkinlik
      const rank = (s) => s.ended ? 4 : s.waiting ? 0
        : s.agents.some((x) => x.status === 'running' || x.status === 'background') ? 1
        : s.status === 'working' ? 2 : 3;
      return rank(a) - rank(b) || b.lastActivity - a.lastActivity;
    })
    .map((s) => ({
      sid: s.sid, cwd: s.cwd, label: s.label,
      startedAt: s.startedAt, lastActivity: s.lastActivity,
      status: s.ended ? 'ended' : (s.waiting ? 'waiting' : s.status),
      waiting: s.waiting || '',
      perm: s.perm,
      current: s.current,
      recent: s.recent,
      todos: s.todos,
      agents: s.agents.map((a) => ({
        id: a.id, parent: a.parent || '', agent: a.agent, desc: a.desc, prompt: a.prompt, status: a.status,
        startedAt: a.startedAt, endedAt: a.endedAt, size: a.size, model: a.model, current: a.current || null,
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
    --run-a:rgba(74,168,255,.35); --run-b:rgba(74,168,255,.07);
    --wait-a:rgba(240,180,41,.45); --wait-b:rgba(240,180,41,.08);
    --err-a:rgba(255,107,107,.35); --err-b:rgba(255,107,107,.07);
  }
  @media(prefers-color-scheme:light){
    :root{ --bg:#f3f4f6; --panel:#ffffff; --panel2:#eceef2; --line:#d8dce3;
      --fg:#1b1f26; --dim:#59626e; --dim2:#8b94a1; --idle:#8b94a1;
      --run:#1c7ed6; --done:#12925f; --err:#d6455d; --wait:#b7791f;
      --run-a:rgba(28,126,214,.35); --run-b:rgba(28,126,214,.06);
      --wait-a:rgba(183,121,31,.5); --wait-b:rgba(183,121,31,.08);
      --err-a:rgba(214,69,93,.35); --err-b:rgba(214,69,93,.06); }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased}
  header{position:sticky;top:0;z-index:5;background:var(--panel);
    border-bottom:1px solid var(--line);
    padding:10px 20px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  h1{font-size:14px;font-weight:600;margin:0;letter-spacing:.3px}
  .pill{font-size:12px;color:var(--dim);background:var(--panel2);
    border:1px solid var(--line);border-radius:999px;padding:3px 10px;white-space:nowrap}
  .pill b{color:var(--fg);font-weight:600}
  .pill.warn{color:var(--wait);background:var(--wait-b);border-color:var(--wait-a);font-weight:600}
  .live{display:inline-block;width:7px;height:7px;border-radius:50%;
    background:var(--done);margin-right:6px;vertical-align:middle}
  .live.off{background:var(--err)}
  .btn{font-size:12px;color:var(--dim);background:var(--panel2);border:1px solid var(--line);
    border-radius:999px;padding:3px 10px;cursor:pointer;user-select:none}
  .btn:hover{color:var(--fg)}
  .toggle{font-size:12px;color:var(--dim);cursor:pointer;user-select:none;
    display:flex;align-items:center;gap:6px}
  .toggle input{accent-color:var(--run)}
  .right{margin-left:auto;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  main{padding:16px 20px 60px;display:flex;flex-direction:column;gap:12px;
    max-width:1400px;margin:0 auto}
  .gtitle{font-size:11px;letter-spacing:.9px;text-transform:uppercase;color:var(--dim2);
    font-weight:600;padding:6px 2px 0}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .card.waiting{border-color:var(--wait-a);box-shadow:0 0 0 4px var(--wait-b)}
  .chead{display:flex;align-items:center;gap:10px;padding:10px 16px;
    border-bottom:1px solid var(--line);background:var(--panel2);flex-wrap:wrap}
  .card.waiting .chead{background:var(--wait-b);border-bottom-color:var(--wait-a)}
  .dot{width:9px;height:9px;border-radius:50%;flex:none}
  .dot.working{background:var(--run);box-shadow:0 0 0 0 var(--run-a);animation:pulse 1.6s infinite}
  .dot.waiting{background:var(--wait);box-shadow:0 0 0 0 var(--wait-a);animation:pulse 1.2s infinite}
  .dot.idle{background:var(--idle)} .dot.ended{background:var(--dim2);opacity:.5}
  @keyframes pulse{70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
  .cwd{font-weight:600;font-size:13px}
  .sid{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dim2)}
  .state{font-size:12.5px;color:var(--dim)}
  .card.waiting .state{color:var(--wait);font-weight:600}
  .meta{margin-left:auto;font-size:12px;color:var(--dim);display:flex;gap:12px;align-items:center;white-space:nowrap}
  .prompt{padding:8px 16px;font-size:12.5px;color:var(--dim);border-bottom:1px solid var(--line);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
  .prompt:hover{color:var(--fg)}
  .prompt.open{white-space:pre-wrap;overflow:visible;text-overflow:clip;word-break:break-word}
  .perm{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--line)}
  .perm svg{flex:none}
  .perm .plabel{font-size:12px;color:var(--dim)}
  .perm .pcmd{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;color:var(--fg);
    background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:5px 10px;margin-top:3px;
    word-break:break-all}
  .now{display:flex;align-items:center;gap:8px;padding:7px 16px;font-size:12.5px;color:var(--run);
    border-bottom:1px solid var(--line);flex-wrap:wrap}
  .now .tname{font-weight:600}
  .now .detail{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
  .now.dimline{color:var(--dim2);font-style:italic}
  .recent{margin-left:auto;display:flex;gap:4px;align-items:center;flex:none}
  .recent .rl{font-size:10.5px;color:var(--dim2);margin-right:2px}
  .chip{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;color:var(--dim);
    background:var(--panel2);border:1px solid var(--line);border-radius:4px;padding:0 5px}
  .chip.cur{color:var(--run);background:var(--run-b);border-color:var(--run-a)}
  .cols{display:grid;grid-template-columns:1.25fr 1fr;gap:0}
  .cols.one{grid-template-columns:1fr}
  @media(max-width:820px){.cols{grid-template-columns:1fr}}
  .col{padding:10px 16px 14px}
  .col+.col{border-left:1px solid var(--line)}
  @media(max-width:820px){.col+.col{border-left:0;border-top:1px solid var(--line)}}
  .ctitle{font-size:11px;letter-spacing:.9px;text-transform:uppercase;color:var(--dim2);
    margin:0 0 8px;font-weight:600}
  .ctitle span{color:var(--dim);margin-left:6px;letter-spacing:0;text-transform:none}
  ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
  li{display:flex;gap:9px;align-items:flex-start;padding:6px 9px;border-radius:8px;
    background:var(--panel2);border:1px solid transparent;font-size:13px}
  li.child{margin-left:22px;padding:4px 9px;font-size:12.5px}
  li.running{border-color:var(--run-a);background:var(--run-b)}
  li.background{border-color:var(--wait-a);background:var(--wait-b)}
  li.background .time{color:var(--wait)}
  li.error{border-color:var(--err-a);background:var(--err-b)}
  .mark{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;flex:none;width:14px;
    text-align:center;line-height:1.5}
  .mark.running{color:var(--run)} .mark.done{color:var(--done)}
  .mark.error{color:var(--err)} .mark.pending{color:var(--dim2)}
  .mark.unknown,.mark.background{color:var(--wait)}
  .body{flex:1;min-width:0}
  .name{font-weight:600;font-size:12px;color:var(--run)}
  li.done .name,li.unknown .name{color:var(--dim)}
  .desc{color:var(--fg);word-break:break-word}
  li.done .desc{color:var(--dim)}
  .acur{display:block;font-size:11px;color:var(--dim2);font-family:ui-monospace,Menlo,Consolas,monospace;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .todo-done .desc{color:var(--dim2);text-decoration:line-through}
  .todo-active .desc{color:var(--fg);font-weight:600}
  .time{flex:none;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:var(--dim2);
    padding-top:1px;min-width:46px;text-align:right}
  li.running .time{color:var(--run)}
  .empty{color:var(--dim2);font-size:12.5px;font-style:italic;padding:4px 2px}
  .strip{display:flex;align-items:center;gap:10px;padding:7px 14px;border-radius:8px;
    background:var(--panel);border:1px solid var(--line);font-size:12.5px;cursor:pointer}
  .strip:hover{border-color:var(--dim2)}
  .strip .lbl{color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
  .strip .ago{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:var(--dim2);white-space:nowrap}
  .spin{display:inline-block;animation:sp 1s steps(8) infinite}
  @keyframes sp{to{transform:rotate(360deg)}}
  .hint{color:var(--dim2);font-size:13px;text-align:center;padding:60px 20px;line-height:1.8}
  code{background:var(--panel2);border:1px solid var(--line);border-radius:5px;
    padding:2px 6px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--fg)}
</style></head><body>
<header>
  <h1>claude-dash</h1>
  <span class="pill"><span class="live" id="live"></span><span id="conn">bağlanıyor…</span></span>
  <span class="pill warn" id="kWait" style="display:none"></span>
  <span class="pill">aktif subagent <b id="kRun">0</b></span>
  <span class="right">
    <span class="btn" id="notif" style="display:none" title="izin/girdi beklerken masaüstü bildirimi">bildirimleri aç</span>
    <label class="toggle"><input type="checkbox" id="showEnded"> bitenleri göster</label>
  </span>
</header>
<main id="root"><div class="hint">bekleniyor…</div></main>
<script>
var snap={now:Date.now(),sessions:[]}, skew=0, showEnded=false, openPrompts={}, openStrips={}, notified={};
var MARK={running:'●',done:'✓',error:'✗',pending:'○',in_progress:'◐',completed:'✓',unknown:'?',background:'◔'};
var PAUSE='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="7" y="5" width="3" height="14" rx="1"></rect><rect x="14" y="5" width="3" height="14" rx="1"></rect></svg>';
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
function stateText(s,running){
  if(s.status==='ended')return 'bitti';
  if(s.status==='waiting')return s.perm?'izin bekliyor':'girdi bekliyor';
  if(running)return '<span class="spin">◠</span> '+running+' aktif';
  return s.status==='working'?'çalışıyor':'boşta';}

function agentRow(a,now,child){
  var el=(isActive(a)? now-a.startedAt : a.endedAt-a.startedAt);
  var nm=a.agent+(a.status==='background'?' · arka plan':'');
  var cur=(a.current&&isActive(a))?'<span class="acur">⚙ '+esc(a.current.tool)+(a.current.detail?' — '+esc(a.current.detail):'')+'</span>':'';
  return '<li class="'+a.status+(child?' child':'')+'" title="'+esc(a.prompt)+'">'+
    '<span class="mark '+a.status+'">'+(MARK[a.status]||'?')+'</span>'+
    '<span class="body"><span class="name">'+esc(nm)+'</span> '+
    '<span class="desc">'+esc(a.desc)+'</span>'+cur+'</span>'+
    '<span class="time">'+dur(el)+'</span></li>';}

function agentsHtml(s,now){
  var tops=s.agents.filter(function(a){return !a.parent;}).sort(function(a,b){
    var ar=isActive(a)?0:1, br=isActive(b)?0:1; return ar-br || b.startedAt-a.startedAt;});
  if(!tops.length) return '<div class="empty">subagent / arka plan işi yok</div>';
  return tops.map(function(a){
    var kids=s.agents.filter(function(k){return k.parent===a.id;});
    return agentRow(a,now,false)+kids.map(function(k){return agentRow(k,now,true);}).join('');
  }).join('');}

function card(s,now){
  var running=s.agents.filter(isActive).length;
  var open=s.todos.filter(function(t){return t.s!=='completed';}).length;
  var tHtml=s.todos.map(function(t){
    var cls=t.s==='completed'?'todo-done':(t.s==='in_progress'?'todo-active':'');
    var txt=(t.s==='in_progress'&&t.a)?t.a:t.c;
    return '<li class="'+cls+'"><span class="mark '+(t.s==='in_progress'?'running':t.s==='completed'?'done':'pending')+'">'+
      (MARK[t.s]||'○')+'</span><span class="body"><span class="desc">'+esc(txt)+'</span></span></li>';}).join('');

  var permLine='';
  if(s.status==='waiting'&&s.perm){
    permLine='<div class="perm" style="color:var(--wait)">'+PAUSE+'<div class="body"><div class="plabel">'+
      esc(s.perm.tool)+' çalıştırmak için onay istiyor · '+dur(now-s.perm.t)+'</div>'+
      (s.perm.detail?'<div class="pcmd">'+esc(s.perm.detail)+'</div>':'')+'</div></div>';
  }else if(s.status==='waiting'){
    permLine='<div class="perm" style="color:var(--wait)">'+PAUSE+'<div class="body"><div class="plabel">bekliyor: '+esc(s.waiting||'onay/girdi')+'</div></div></div>';
  }
  var nowLine='';
  var chips=(s.recent||[]).length?'<span class="recent"><span class="rl">son</span>'+
    s.recent.map(function(r,i){var last=i===s.recent.length-1&&s.current&&s.current.tool===r.tool;
      return '<span class="chip'+(last?' cur':'')+'">'+esc(r.tool)+'</span>';}).join('')+'</span>':'';
  if(s.current){
    nowLine='<div class="now">⚙ <span class="tname">'+esc(s.current.tool)+'</span>'+
      (s.current.detail?'<span class="detail">— '+esc(s.current.detail)+'</span>':'')+
      '<span>· '+dur(now-s.current.t)+'</span>'+chips+'</div>';
  }else if(s.status==='working'){
    nowLine='<div class="now dimline">✍ yanıt hazırlanıyor…'+chips+'</div>';
  }else if(chips){
    nowLine='<div class="now dimline">'+chips+'</div>';
  }
  var cols=s.todos.length?'cols':'cols one';
  return '<section class="card '+s.status+'"><div class="chead">'+
    '<span class="dot '+s.status+'"></span>'+
    '<span class="cwd">'+esc(base(s.cwd))+'</span>'+
    '<span class="sid">'+esc(s.sid.slice(0,8))+'</span>'+
    '<span class="state">'+stateText(s,running)+'</span>'+
    '<span class="meta"><span>'+ago(s.lastActivity)+'</span></span></div>'+
    (s.label?'<div class="prompt'+(openPrompts[s.sid]?' open':'')+'" data-sid="'+esc(s.sid)+
      '" title="tıkla: tam metni aç/kapat">› '+esc(s.label)+'</div>':'')+
    permLine+nowLine+
    '<div class="'+cols+'"><div class="col"><h2 class="ctitle">Subagent &amp; arka plan'+
    '<span>'+s.agents.length+(running?' · '+running+' aktif':'')+'</span></h2><ul>'+agentsHtml(s,now)+'</ul></div>'+
    (s.todos.length?'<div class="col"><h2 class="ctitle">Görevler<span>'+open+' açık / '+s.todos.length+'</span></h2><ul>'+tHtml+'</ul></div>':'')+
    '</div></section>';}

function strip(s){
  return '<div class="strip" data-strip="'+esc(s.sid)+'" title="tıkla: kartı aç">'+
    '<span class="dot '+s.status+'"></span><span class="cwd">'+esc(base(s.cwd))+'</span>'+
    '<span class="sid">'+esc(s.sid.slice(0,8))+'</span>'+
    '<span class="lbl">'+(s.label?'› '+esc(s.label):'')+'</span>'+
    '<span class="ago">'+(s.status==='ended'?'bitti · ':'')+ago(s.lastActivity)+'</span></div>';}

function notify(s){
  if(!('Notification' in window)||Notification.permission!=='granted')return;
  var key=s.sid+'|'+(s.perm?s.perm.t:s.waiting);
  if(notified[key])return; notified[key]=1;
  try{ new Notification('claude-dash · '+base(s.cwd),{body:s.waiting||'onay/girdi bekliyor',tag:s.sid}); }catch(e){}
}

function render(){
  var now=Date.now()+skew, root=document.getElementById('root');
  var sess=(snap.sessions||[]).filter(function(s){return showEnded||s.status!=='ended';});
  var nRun=0,nWait=0;
  sess.forEach(function(s){ s.agents.forEach(function(a){if(isActive(a))nRun++;}); if(s.status==='waiting'){nWait++; notify(s);} });
  document.getElementById('kRun').textContent=nRun;
  var kw=document.getElementById('kWait'); kw.style.display=nWait?'':'none'; kw.textContent=nWait+' seni bekliyor';
  document.title=(nWait?'('+nWait+') ':'')+'claude-dash';
  var nb=document.getElementById('notif');
  nb.style.display=('Notification' in window&&Notification.permission==='default')?'':'none';

  if(!sess.length){
    root.innerHTML='<div class="hint">Henüz olay yok.<br><br>'+
      'Bir Claude Code oturumu başlatın; hook kurulu ise<br>'+
      'subagent ve görev hareketleri burada anlık görünür.<br><br>'+
      '<code>node claude-dash.js install</code> ile hook ekleyebilirsiniz.</div>';
    return;
  }
  var full=[], quiet=[];
  sess.forEach(function(s){
    var busy=s.status==='waiting'||s.status==='working'||s.agents.some(isActive);
    if(busy||openStrips[s.sid]) full.push(s); else quiet.push(s);
  });
  var html=full.map(function(s){return card(s,now);}).join('');
  if(quiet.length){
    html+='<div class="gtitle">Boşta · '+quiet.length+'</div>'+quiet.map(strip).join('');
  }
  root.innerHTML=html;
}

document.getElementById('showEnded').addEventListener('change',function(e){
  showEnded=e.target.checked; render();});
document.getElementById('notif').addEventListener('click',function(){
  if('Notification' in window) Notification.requestPermission().then(render);});

document.getElementById('root').addEventListener('click',function(ev){
  var el=ev.target;
  while(el&&el.classList&&!el.classList.contains('prompt')&&!el.classList.contains('strip')&&!el.classList.contains('card'))el=el.parentNode;
  if(!el||!el.classList)return;
  if(el.classList.contains('prompt')){ var sid=el.getAttribute('data-sid'); openPrompts[sid]=!openPrompts[sid]; render(); return; }
  if(el.classList.contains('strip')){ openStrips[el.getAttribute('data-strip')]=true; render(); return; }
  if(el.classList.contains('card')&&ev.target.classList.contains('chead')){ /* başlığa tıkla: açık şeridi kapat */
    var c=ev.target.parentNode; var s2=(snap.sessions||[]).filter(function(x){return openStrips[x.sid];});
    s2.forEach(function(x){ if(c.innerHTML.indexOf(x.sid.slice(0,8))>=0) delete openStrips[x.sid]; }); render(); }
});

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
  ['SubagentStart', null],
  ['PermissionRequest', null],
  ['TaskCreated', null],
  ['TaskCompleted', null],
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
