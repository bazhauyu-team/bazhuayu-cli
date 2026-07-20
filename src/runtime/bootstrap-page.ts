import { createServer, type Server } from 'node:http';

export type BootstrapPageMode = 'run' | 'detect';

export interface BootstrapPageServer {
  /** Base origin with trailing slash, e.g. http://127.0.0.1:54321/ */
  origin: string;
  close(): Promise<void>;
}

export interface StartBootstrapPageOptions {
  mode?: BootstrapPageMode;
  /** Optional task / page label shown on the splash screen. */
  label?: string;
}

/**
 * Local splash page used as the extension bootstrap URL (sessionId + wsUrl query).
 * Replaces the previous https://example.com handshake page with a friendly UI.
 */
export async function startBootstrapPageServer(
  options: StartBootstrapPageOptions = {}
): Promise<BootstrapPageServer> {
  const mode = options.mode ?? 'run';
  const label = options.label?.trim() || undefined;
  const html = renderBootstrapHtml({ mode, label });

  const server = createServer((req, res) => {
    // Health/probe requests from Chrome or extensions should always get the splash page.
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(html);
  });

  // Keep the process from staying alive solely for this server after close.
  server.unref?.();

  await listenLoopback(server);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Failed to bind bootstrap page server on 127.0.0.1');
  }

  const origin = `http://127.0.0.1:${address.port}/`;
  let closed = false;

  return {
    origin,
    async close() {
      if (closed) return;
      closed = true;
      await closeServer(server);
    }
  };
}

function listenLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Force-resolve if already closed / no connections.
    setTimeout(resolve, 250).unref?.();
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderBootstrapHtml(options: {
  mode: BootstrapPageMode;
  label?: string;
}): string {
  const isDetect = options.mode === 'detect';
  const title = isDetect ? 'Octopus · 页面检测' : 'Octopus · 本地采集';
  const heading = isDetect ? '正在准备页面检测' : '正在连接浏览器扩展';
  const subtitle = isDetect
    ? '扩展注册完成后将打开目标页面，请稍候…'
    : '扩展注册完成后将自动开始任务，请稍候…';
  const label = options.label ? escapeHtml(options.label) : '';
  const labelBlock = label
    ? `<p class="label"><span>任务</span>${label}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg0: #0b1220;
      --bg1: #132038;
      --card: rgba(255, 255, 255, 0.08);
      --border: rgba(255, 255, 255, 0.12);
      --text: #f4f7fb;
      --muted: #a8b3c7;
      --accent: #5b8cff;
      --accent2: #35d0ba;
      --shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
      font-family: "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB",
        "Microsoft YaHei", system-ui, -apple-system, sans-serif;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg0: #eef3ff;
        --bg1: #f8fbff;
        --card: rgba(255, 255, 255, 0.82);
        --border: rgba(20, 40, 80, 0.08);
        --text: #132038;
        --muted: #5b6b86;
        --shadow: 0 20px 60px rgba(40, 70, 140, 0.12);
      }
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      min-height: 100%;
      background:
        radial-gradient(1200px 600px at 10% -10%, rgba(91, 140, 255, 0.28), transparent 55%),
        radial-gradient(900px 500px at 100% 0%, rgba(53, 208, 186, 0.18), transparent 50%),
        linear-gradient(160deg, var(--bg0), var(--bg1));
      color: var(--text);
    }
    body {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px 20px;
    }
    .card {
      width: min(480px, 100%);
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 20px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(16px);
      padding: 36px 32px 28px;
      text-align: center;
    }
    .logo {
      width: 56px;
      height: 56px;
      margin: 0 auto 18px;
      border-radius: 16px;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      color: white;
      font-weight: 700;
      font-size: 22px;
      letter-spacing: -0.04em;
      box-shadow: 0 10px 28px rgba(91, 140, 255, 0.35);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 1.35rem;
      font-weight: 650;
      letter-spacing: -0.02em;
    }
    .subtitle {
      margin: 0;
      color: var(--muted);
      font-size: 0.95rem;
      line-height: 1.55;
    }
    .label {
      margin: 18px 0 0;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: 100%;
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(91, 140, 255, 0.12);
      color: var(--text);
      font-size: 0.85rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .label span {
      color: var(--muted);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .spinner {
      width: 28px;
      height: 28px;
      margin: 26px auto 8px;
      border-radius: 50%;
      border: 3px solid rgba(91, 140, 255, 0.2);
      border-top-color: var(--accent);
      animation: spin 0.85s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .hint {
      margin: 18px 0 0;
      color: var(--muted);
      font-size: 0.8rem;
      line-height: 1.5;
    }
    .dots::after {
      content: "";
      display: inline-block;
      width: 1.2em;
      text-align: left;
      animation: dots 1.4s steps(4, end) infinite;
    }
    @keyframes dots {
      0% { content: ""; }
      25% { content: "."; }
      50% { content: ".."; }
      75%, 100% { content: "..."; }
    }
  </style>
</head>
<body>
  <main class="card" role="status" aria-live="polite">
    <div class="logo" aria-hidden="true">O</div>
    <h1>${escapeHtml(heading)}<span class="dots" aria-hidden="true"></span></h1>
    <p class="subtitle">${escapeHtml(subtitle)}</p>
    ${labelBlock}
    <div class="spinner" aria-hidden="true"></div>
    <p class="hint">此页仅用于连接 Octopus 浏览器扩展，不是采集目标网站。</p>
  </main>
</body>
</html>
`;
}
