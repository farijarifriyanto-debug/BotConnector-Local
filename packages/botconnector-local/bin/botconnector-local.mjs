#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const runtimeDir = path.join(root, 'runtime', 'win32-x64-vulkan');
const workerExe = path.join(runtimeDir, 'jan-llama-worker.exe');
const uiFile = path.join(root, 'ui', 'index.html');
const defaultHome = path.join(process.env.LOCALAPPDATA || os.homedir(), 'BotConnector', 'Local');

function parseArgs(argv) {
  const out = { models: [], port: 18764, open: true, home: defaultHome, runtimeCheck: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') out.models.push(argv[++i]);
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--home') out.home = path.resolve(argv[++i]);
    else if (a === '--no-open') out.open = false;
    else if (a === '--runtime-check') out.runtimeCheck = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

function usage() {
  console.log(`BotConnector Local

Usage:
  npx @botconnector/local
  npx @botconnector/local --model "C:\\path\\model.gguf"
  botconnector-local --no-open

Options:
  --model PATH   Add a GGUF model path (repeatable)
  --home PATH    Override BotConnector Local data directory
  --port N       Local UI port (default 18764)
  --no-open      Do not open the browser automatically
`);
}

function runRuntimeCheck() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('This baseline runtime currently supports Windows x64 only.');
  }
  if (!fs.existsSync(workerExe)) throw new Error(`Missing runtime: ${workerExe}`);
  const r = spawnSync(workerExe, ['--version'], { cwd: runtimeDir, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(r.stderr || 'jan-llama-worker --version failed');
  console.log((r.stdout || '').trim());
}

function safeModelId(file, used) {
  let id = path.basename(file, path.extname(file)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
  const base = id;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

async function walkGguf(dir, out = []) {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walkGguf(p, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.gguf')) out.push(p);
  }
  return out;
}

async function resolveModels(extra, modelsDir) {
  const all = [...extra.filter(Boolean), ...(await walkGguf(modelsDir))];
  const seenPath = new Set();
  const used = new Set();
  const models = [];
  for (const input of all) {
    const p = path.resolve(input);
    const key = p.toLowerCase();
    if (seenPath.has(key) || !fs.existsSync(p) || !p.toLowerCase().endsWith('.gguf')) continue;
    seenPath.add(key);
    models.push({ id: safeModelId(p, used), path: p });
  }
  return models;
}

function iniPath(p) {
  return p.replace(/\\/g, '/').replace(/[\r\n]+/g, ' ').trim();
}

async function writePreset(file, models) {
  const lines = ['[*]', 'fit = on', 'fit-target = 1024', 'parallel = 1', 'kv-unified = true', ''];
  for (const m of models) {
    lines.push(`[${m.id}]`, `model = ${iniPath(m.path)}`, 'load-on-startup = false', '');
  }
  await fsp.writeFile(file, lines.join('\n'), 'utf8');
}

function getDevices() {
  try {
    const r = spawnSync(workerExe, ['--list-devices'], { cwd: runtimeDir, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (r.status === 0 && r.stdout.trim()) return JSON.parse(r.stdout.trim());
  } catch {}
  return [];
}

function readLine(stream, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => cleanup(new Error('engine handshake timed out')), timeoutMs);
    const onData = chunk => {
      buf += chunk.toString();
      const i = buf.indexOf('\n');
      if (i >= 0) cleanup(null, buf.slice(0, i).trim());
    };
    const onEnd = () => cleanup(new Error('engine exited before handshake'));
    const cleanup = (err, value) => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      err ? reject(err) : resolve(value);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
  });
}

async function startWorker(preset) {
  const apiKey = crypto.randomBytes(32).toString('hex');
  const child = spawn(workerExe, ['--preset', preset, '--port', '0', '--models-max', '1', '--slot-cache-mib', '0'], {
    cwd: runtimeDir,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, JAN_LLAMA_API_KEY: apiKey },
  });
  child.stderr.on('data', b => process.stderr.write(`[engine] ${b}`));
  child.on('exit', code => {
    if (!shuttingDown && code !== 0) console.error(`BotConnector Local engine exited with code ${code}`);
  });
  const line = await readLine(child.stdout);
  const hello = JSON.parse(line);
  return { child, apiKey, port: hello.port, models: hello.models || [] };
}

async function bodyOf(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function proxy(worker, req, res, targetPath, body) {
  const headers = { authorization: `Bearer ${worker.apiKey}` };
  const ct = req.headers['content-type'];
  if (ct) headers['content-type'] = ct;
  const upstream = await fetch(`http://127.0.0.1:${worker.port}${targetPath}`, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  });
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') || 'application/json',
    'cache-control': 'no-store',
  });
  if (upstream.body) {
    for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
  }
  res.end();
}

function openBrowser(url) {
  if (process.platform !== 'win32') return;
  const p = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
  p.unref();
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { usage(); process.exit(0); }
if (args.runtimeCheck) { runRuntimeCheck(); process.exit(0); }
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('BotConnector Local baseline currently supports Windows x64 only.');
if (!fs.existsSync(workerExe)) throw new Error(`BotConnector Local runtime is missing: ${workerExe}`);

const home = args.home;
const modelsDir = path.join(home, 'models');
const preset = path.join(home, 'router.preset.ini');
await fsp.mkdir(modelsDir, { recursive: true });
let models = await resolveModels(args.models, modelsDir);
await writePreset(preset, models);

let worker = await startWorker(preset);
let devices = getDevices();
const uiTemplate = await fsp.readFile(uiFile, 'utf8');
const sessionToken = crypto.randomBytes(24).toString('base64url');
let shuttingDown = false;

async function authorized(req, res) {
  if (req.headers['x-botconnector-token'] !== sessionToken) {
    json(res, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://127.0.0.1:${args.port}`);
    if (req.method === 'GET' && u.pathname === '/') {
      const html = uiTemplate.replaceAll('__BOTCONNECTOR_TOKEN__', sessionToken);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
      });
      return res.end(html);
    }
    if (!(await authorized(req, res))) return;

    if (req.method === 'GET' && u.pathname === '/api/status') {
      let listing = { data: [] };
      try {
        const r = await fetch(`http://127.0.0.1:${worker.port}/models`, { headers: { authorization: `Bearer ${worker.apiKey}` } });
        listing = await r.json();
      } catch {}
      return json(res, 200, {
        local: true,
        backend: 'Vulkan',
        modelsDir,
        models: listing.data || [],
        devices,
        cpu: os.cpus()[0]?.model || 'Unknown CPU',
        ramGiB: Math.round(os.totalmem() / 1024 / 1024 / 1024),
      });
    }

    if (req.method === 'POST' && u.pathname === '/api/refresh') {
      models = await resolveModels(args.models, modelsDir);
      await writePreset(preset, models);
      const r = await fetch(`http://127.0.0.1:${worker.port}/models/reload`, {
        method: 'POST',
        headers: { authorization: `Bearer ${worker.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ preset_path: preset, models_max: 1, slot_cache_mib: 0 }),
      });
      return json(res, r.status, await r.json());
    }

    if (req.method === 'POST' && u.pathname === '/api/open-models-folder') {
      const p = spawn('explorer.exe', [modelsDir], { detached: true, stdio: 'ignore', windowsHide: true });
      p.unref();
      return json(res, 200, { ok: true });
    }

    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await bodyOf(req);
    if (u.pathname.startsWith('/v1/') || u.pathname.startsWith('/models')) {
      return await proxy(worker, req, res, u.pathname + u.search, body);
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e?.message || String(e) });
  }
});

server.listen(args.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${args.port}`;
  console.log('BotConnector Local is running.');
  console.log(`Local UI: ${url}`);
  console.log(`Models:   ${modelsDir}`);
  console.log(`Backend:  Vulkan (${devices.length} offloadable device(s) detected)`);
  console.log('Close this PowerShell window or press Ctrl+C to stop.');
  if (args.open) openBrowser(url);
});

async function stop() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  try { worker.child.stdin.end(); } catch {}
  const timer = setTimeout(() => { try { worker.child.kill(); } catch {} }, 12000);
  worker.child.once('exit', () => { clearTimeout(timer); process.exit(0); });
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
