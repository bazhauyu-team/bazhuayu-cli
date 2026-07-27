import { EventEmitter, on, once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { SessionExtensionBridge } from '@octopus/browser-runtime';
import type {
  Command,
  CommandResponse,
  ExtensionEvent,
  ExtensionRegistrationMessage,
  ExtensionRuntimeConfig
} from '@octopus/browser-runtime';

interface HubSessionEntry {
  bridge: SessionExtensionBridge;
  ws: WebSocket | null;
  connected: boolean;
  connectedAt?: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRegistrationMessage(message: unknown): message is ExtensionRegistrationMessage {
  return isObjectRecord(message) && message.type === 'register' && typeof message.sessionId === 'string';
}

export class BridgeHub extends EventEmitter {
  private readonly host = '127.0.0.1';
  private readonly sessions = new Map<string, HubSessionEntry>();
  private readonly wss: WebSocketServer;
  private readonly ready: Promise<string>;
  private closePromise: Promise<void> | null = null;
  private closed = false;

  constructor() {
    super();
    this.wss = new WebSocketServer({ host: this.host, port: 0 });
    this.ready = new Promise((resolve, reject) => {
      const handleReadyError = (error: Error) => {
        this.wss.off('listening', handleListening);
        this.emit('bridge.error', { message: error.message });
        reject(error);
      };
      const handleListening = () => {
        this.wss.off('error', handleReadyError);
        const wsUrl = this.getWsUrl();
        this.emit('bridge.listening', { wsUrl });
        resolve(wsUrl);
      };

      this.wss.once('listening', handleListening);
      this.wss.once('error', handleReadyError);
    });

    this.wss.on('connection', (ws) => this.handleConnection(ws));
    this.wss.on('error', (error) => {
      this.emit('bridge.error', { message: error.message });
    });
  }

  async createSessionBridge(runId: string): Promise<SessionExtensionBridge> {
    if (this.closed) throw new Error('Bridge hub is closed');
    const wsUrl = await this.ready;
    if (this.closed) throw new Error('Bridge hub is closed');
    const runtimeConfig: ExtensionRuntimeConfig = { sessionId: runId, wsUrl };
    const bridge = new SessionExtensionBridge({
      runtimeConfig,
      dispatchCommand: (sessionId: string, message: Command) => {
        this.dispatchCommand(sessionId, message);
      },
      onClose: (sessionId: string) => {
        this.removeSession(sessionId);
      }
    });
    this.sessions.set(runtimeConfig.sessionId, { bridge, ws: null, connected: false });
    this.emit('bridge.session.created', { sessionId: runtimeConfig.sessionId, wsUrl });
    return bridge;
  }

  isSessionConnected(sessionId: string): boolean {
    return Boolean(this.sessions.get(sessionId)?.connected);
  }

  async waitForSessionConnected(sessionId: string, timeoutMs: number): Promise<void> {
    if (this.closed) throw new Error('Bridge hub is closed');
    if (this.isSessionConnected(sessionId)) return;

    const controller = new AbortController();
    const handleClosed = () => controller.abort(new Error('Bridge hub closed before extension registration'));
    const timeout = setTimeout(
      () => controller.abort(new Error(`Extension did not register within ${timeoutMs}ms`)),
      timeoutMs
    );
    this.once('bridge.closed', handleClosed);
    try {
      for await (const [value] of on(this, 'bridge.registered', { signal: controller.signal })) {
        const event = value as { sessionId: string; success: boolean };
        if (event.sessionId !== sessionId) continue;
        if (!event.success) throw new Error('Extension registration failed');
        return;
      }
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timeout);
      this.off('bridge.closed', handleClosed);
      controller.abort();
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    this.emit('bridge.closed', {});
    for (const entry of [...this.sessions.values()]) {
      entry.bridge.handleHubDisconnected();
      entry.bridge.close();
    }
    this.sessions.clear();
    for (const socket of this.wss.clients) terminateWebSocket(socket);
    await closeWebSocketServer(this.wss);
  }

  private getWsUrl(): string {
    const address = this.wss.address();
    if (!address || typeof address === 'string') {
      throw new Error('failed to resolve bridge server address');
    }
    return `ws://${this.host}:${address.port}`;
  }

  private handleConnection(ws: WebSocket): void {
    let currentSessionId: string | null = null;
    this.emit('bridge.connection', {});

    ws.on('message', (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString()) as unknown;
      } catch {
        this.emit('bridge.message.invalid', {});
        return;
      }

      if (isRegistrationMessage(message)) {
        const entry = this.sessions.get(message.sessionId);
        if (!entry) {
          ws.send(JSON.stringify({
            type: 'registered',
            sessionId: message.sessionId,
            success: false,
            error: 'Unknown session'
          }));
          this.emit('bridge.registered', {
            sessionId: message.sessionId,
            success: false,
            error: 'Unknown session'
          });
          ws.close();
          return;
        }

        if (entry.ws && entry.ws !== ws) {
          terminateWebSocket(entry.ws);
        }

        entry.ws = ws;
        entry.connected = true;
        entry.connectedAt = new Date().toISOString();
        entry.bridge.handleHubConnected();
        currentSessionId = message.sessionId;
        ws.send(JSON.stringify({ type: 'registered', sessionId: message.sessionId, success: true }));
        this.emit('bridge.registered', { sessionId: message.sessionId, success: true });
        return;
      }

      if (!currentSessionId) return;
      const entry = this.sessions.get(currentSessionId);
      if (isObjectRecord(message) && typeof message.id === 'string') {
        this.emit('bridge.response', { sessionId: currentSessionId, id: message.id, success: message.success });
      } else if (isObjectRecord(message) && typeof message.type === 'string') {
        this.emit('bridge.event', { sessionId: currentSessionId, type: message.type });
      }
      entry?.bridge.handleHubMessage(message as CommandResponse | ExtensionEvent);
    });

    ws.on('close', () => {
      if (!currentSessionId) return;
      const entry = this.sessions.get(currentSessionId);
      if (!entry || entry.ws !== ws) return;
      entry.ws = null;
      entry.connected = false;
      entry.bridge.handleHubDisconnected();
      this.emit('bridge.disconnected', { sessionId: currentSessionId });
    });

    ws.on('error', (error) => {
      this.emit('bridge.error', { sessionId: currentSessionId, message: error.message });
    });
  }

  private dispatchCommand(sessionId: string, message: Command): void {
    const socket = this.sessions.get(sessionId)?.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('No extension connected for session');
    }
    this.emit('bridge.command', { sessionId, id: message.id, action: message.action });
    socket.send(JSON.stringify(message));
  }

  private removeSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.bridge.handleHubDisconnected();
    if (entry.ws) terminateWebSocket(entry.ws);
    this.sessions.delete(sessionId);
  }
}

function terminateWebSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.CLOSED) return;
  try {
    socket.terminate();
  } catch {
    // The socket may have closed between the readyState check and terminate().
  }
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  const closed = once(server, 'close');
  try {
    server.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') return;
    throw error;
  }
  await closed;
}
