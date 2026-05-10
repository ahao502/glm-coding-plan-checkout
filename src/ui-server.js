#!/usr/bin/env node

import http from 'node:http';
import { DEFAULT_RETRY_INTERVAL_MS } from './scheduler.js';
import { CheckoutTaskManager, defaultStartAt } from './task-manager.js';

const HOST = process.env.GLM_UI_HOST || '127.0.0.1';
const PORT = Number(process.env.GLM_UI_PORT || 3000);
const manager = new CheckoutTaskManager();

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function toLocalInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function html() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GLM Coding Checkout</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --panel: #ffffff;
      --text: #172033;
      --muted: #667085;
      --line: #d9dee8;
      --primary: #175cff;
      --primary-dark: #0f45c7;
      --danger: #c92a2a;
      --success: #087f5b;
      --warning: #b36b00;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    main {
      width: min(980px, calc(100vw - 32px));
      margin: 32px auto;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 20px;
    }

    h1 {
      margin: 0;
      font-size: 28px;
      line-height: 1.2;
      font-weight: 700;
    }

    .status-pill {
      min-width: 96px;
      padding: 7px 12px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      color: var(--muted);
      text-align: center;
      font-size: 14px;
      font-weight: 650;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 300px;
      gap: 16px;
      align-items: start;
    }

    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      box-shadow: 0 12px 30px rgba(16, 24, 40, 0.06);
    }

    .panel-title {
      margin: 0 0 14px;
      font-size: 16px;
      font-weight: 700;
    }

    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }

    label {
      display: block;
      margin-bottom: 7px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }

    input {
      width: 100%;
      height: 42px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 10px;
      color: var(--text);
      background: #fff;
      font-size: 15px;
    }

    input:focus {
      outline: 2px solid rgba(23, 92, 255, 0.18);
      border-color: var(--primary);
    }

    .actions {
      display: flex;
      gap: 10px;
      margin-top: 16px;
    }

    button {
      height: 42px;
      border: 0;
      border-radius: 6px;
      padding: 0 16px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    .primary { background: var(--primary); color: #fff; }
    .primary:hover:not(:disabled) { background: var(--primary-dark); }
    .danger { background: #fff1f1; color: var(--danger); border: 1px solid #ffc9c9; }
    .danger:hover:not(:disabled) { background: #ffe3e3; }

    .countdown {
      font-size: clamp(36px, 8vw, 68px);
      line-height: 1;
      font-weight: 760;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0;
      margin: 12px 0 18px;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }

    .metric {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 12px;
      min-height: 76px;
    }

    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 8px;
    }

    .metric strong {
      display: block;
      font-size: 18px;
      font-weight: 750;
      overflow-wrap: anywhere;
    }

    pre {
      min-height: 220px;
      max-height: 360px;
      overflow: auto;
      margin: 0;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 12px;
      background: #101828;
      color: #e6edf7;
      font-size: 13px;
      line-height: 1.5;
      white-space: pre-wrap;
    }

    .muted { color: var(--muted); }
    .success { color: var(--success); }
    .failed, .login_required, .contract_changed { color: var(--danger); }
    .attempting, .countdown-state { color: var(--warning); }

    .log-panel {
      margin-top: 16px;
    }

    .log-list {
      min-height: 120px;
      max-height: 360px;
      overflow: auto;
      margin: 0;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px 12px;
      background: #101828;
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .log-entry {
      padding: 1px 0;
    }

    .log-entry.info { color: #c0caf5; }
    .log-entry.warn { color: #e0af68; }
    .log-entry.error { color: #f7768e; }
    .log-empty { color: #565f89; }

    @media (max-width: 760px) {
      header, .actions { flex-direction: column; align-items: stretch; }
      .layout, .form-grid, .metrics { grid-template-columns: 1fr; }
      main { width: min(100vw - 24px, 980px); margin: 20px auto; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>GLM Coding Checkout</h1>
        <div class="muted">本地控制台，按计划启动官方页面 checkout 流程</div>
      </div>
      <div id="statusPill" class="status-pill">未启动</div>
    </header>

    <div class="layout">
      <div>
        <section>
          <h2 class="panel-title">任务设置</h2>
          <div class="form-grid">
            <div>
              <label for="startAt">下一次执行时间</label>
              <input id="startAt" type="datetime-local">
            </div>
            <div>
              <label for="retryIntervalMs">重试间隔（毫秒）</label>
              <input id="retryIntervalMs" type="number" min="100" step="50" value="500">
            </div>
          </div>
          <div class="actions">
            <button id="startBtn" class="primary">启动</button>
            <button id="stopBtn" class="danger" disabled>停止</button>
          </div>
        </section>

        <section style="margin-top: 16px;">
          <h2 class="panel-title">执行状态</h2>
          <div id="countdown" class="countdown">--h --m --s</div>
          <div class="metrics">
            <div class="metric"><span>尝试次数</span><strong id="attempts">0</strong></div>
            <div class="metric"><span>开始时间</span><strong id="startAtText">-</strong></div>
            <div class="metric"><span>截止时间</span><strong id="stopAtText">-</strong></div>
          </div>
        </section>
      </div>

      <section>
        <h2 class="panel-title">结果</h2>
        <pre id="result">{}</pre>
      </section>
    </div>

    <section class="log-panel">
      <h2 class="panel-title">请求日志</h2>
      <div id="logList" class="log-list"><span class="log-empty">等待任务启动...</span></div>
    </section>
  </main>

  <script>
    const startAt = document.querySelector('#startAt');
    const retryIntervalMs = document.querySelector('#retryIntervalMs');
    const startBtn = document.querySelector('#startBtn');
    const stopBtn = document.querySelector('#stopBtn');
    const statusPill = document.querySelector('#statusPill');
    const countdown = document.querySelector('#countdown');
    const attempts = document.querySelector('#attempts');
    const startAtText = document.querySelector('#startAtText');
    const stopAtText = document.querySelector('#stopAtText');
    const result = document.querySelector('#result');
    const logList = document.querySelector('#logList');

    function duration(ms) {
      const total = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
      const h = Math.floor(total / 3600);
      const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
      const s = String(total % 60).padStart(2, '0');
      return h + 'h ' + m + 'm ' + s + 's';
    }

    function label(status) {
      return {
        idle: '未启动',
        preparing: '预热中',
        countdown: '倒计时',
        attempting: '尝试中',
        success: '成功',
        stopped: '已停止',
        checkout_not_created: '未生成',
        button_never_enabled: '按钮未开放',
        login_required: '需登录',
        contract_changed: '异常'
      }[status] || status || '未知';
    }

    function fmt(value) {
      return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
    }

    async function api(path, options) {
      const response = await fetch(path, options);
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || 'Request failed');
      return body;
    }

    async function loadDefaults() {
      const defaults = await api('/api/defaults');
      startAt.value = defaults.startAtLocal;
      retryIntervalMs.value = defaults.retryIntervalMs;
    }

    function render(status) {
      statusPill.textContent = label(status.status);
      statusPill.className = 'status-pill ' + (status.status === 'countdown' ? 'countdown-state' : status.status || '');
      countdown.textContent = duration(status.timeRemainingMs);
      attempts.textContent = String(status.attempts || 0);
      startAtText.textContent = fmt(status.startAt);
      stopAtText.textContent = fmt(status.stopAt);
      startBtn.disabled = Boolean(status.running);
      stopBtn.disabled = !status.running;
      result.textContent = JSON.stringify(status.lastResult || {}, null, 2);
    }

    let lastLogCount = 0;

    function renderLogs(status) {
      const logs = status.logs || [];
      if (logs.length === 0) {
        logList.innerHTML = '<span class="log-empty">等待任务启动...</span>';
        lastLogCount = 0;
        return;
      }

      if (logs.length === lastLogCount) return;
      lastLogCount = logs.length;

      const isAtBottom = logList.scrollHeight - logList.scrollTop - logList.clientHeight < 40;
      logList.innerHTML = logs.map(l => {
        const time = l.time ? new Date(l.time).toLocaleTimeString('zh-CN', { hour12: false }) : '';
        return '<div class="log-entry ' + l.level + '">[' + time + '] ' + l.message + '</div>';
      }).join('');
      if (isAtBottom) logList.scrollTop = logList.scrollHeight;
    }

    async function refresh() {
      try {
        const status = await api('/api/status');
        render(status);
        renderLogs(status);
      } catch (error) {
        result.textContent = JSON.stringify({ error: error.message }, null, 2);
      }
    }

    startBtn.addEventListener('click', async () => {
      try {
        await api('/api/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            startAt: startAt.value,
            retryIntervalMs: Number(retryIntervalMs.value)
          })
        });
        await refresh();
      } catch (error) {
        result.textContent = JSON.stringify({ error: error.message }, null, 2);
      }
    });

    stopBtn.addEventListener('click', async () => {
      await api('/api/stop', { method: 'POST' });
      await refresh();
    });

    loadDefaults().then(refresh);
    setInterval(refresh, 1000);
  </script>
</body>
</html>`;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/defaults') {
    json(res, 200, {
      startAt: defaultStartAt().toISOString(),
      startAtLocal: toLocalInputValue(defaultStartAt()),
      retryIntervalMs: DEFAULT_RETRY_INTERVAL_MS
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    json(res, 200, manager.getStatus());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/start') {
    try {
      const body = await readJson(req);
      manager.start({
        startAt: body.startAt,
        retryIntervalMs: body.retryIntervalMs
      });
      json(res, 202, manager.getStatus());
    } catch (error) {
      json(res, error.code === 'TASK_ALREADY_RUNNING' ? 409 : 400, {
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    json(res, 200, { stopped: manager.stop(), status: manager.getStatus() });
    return;
  }

  json(res, 404, { message: 'Not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    json(res, 500, {
      message: error instanceof Error ? error.message : String(error)
    });
  });
});

server.listen(PORT, HOST, () => {
  process.stderr.write(`GLM checkout UI running at http://${HOST}:${PORT}\n`);
});
