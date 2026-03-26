import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import {
  type AgentIdentity,
  BridgeToExtensionSchema,
  type BrowserAction,
  type BrowserArtifact,
  type ExtensionToBridgeMessage,
  ExtensionToBridgeSchema,
  type SessionState,
} from "../protocol/types.js";

export type ExtensionBridgeOptions = {
  host?: string;
  port?: number;
  requestTimeoutMs?: number;
};

export type ExecuteOptions = {
  sessionId?: string;
  taskName?: string;
  targetTabId?: number;
  agent?: AgentIdentity;
  pairingKey?: string;
};

type PendingRequest = {
  pairingKey: string;
  resolve: (artifact: BrowserArtifact | undefined) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type BridgeConnection = {
  socket: WebSocket | null;
  currentSession: SessionState | null;
  lastHello: Extract<ExtensionToBridgeMessage, { type: "extension.hello" }> | null;
};

function sanitizePairingKey(rawValue: string | undefined): string | null {
  if (!rawValue) {
    return null;
  }

  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/[^a-zA-Z0-9._~-]/g, "");
  if (!normalized) {
    return null;
  }

  return normalized;
}

export class ExtensionBridge extends EventEmitter {
  private readonly host: string;
  private readonly port: number;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly connections = new Map<string, BridgeConnection>();
  private server: WebSocketServer | null = null;

  constructor(options: ExtensionBridgeOptions = {}) {
    super();
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 8787;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = new WebSocketServer({ host: this.host, port: this.port });

    this.server.on("connection", (socket, request) => {
      const pairingKey = this.resolvePairingKey(request);
      if (!pairingKey) {
        socket.close(1008, "Pairing key required.");
        return;
      }

      const existing = this.connections.get(pairingKey);
      if (existing?.socket && existing.socket !== socket) {
        existing.socket.close(1012, "Superseded by a newer extension connection.");
      }

      const connection: BridgeConnection = {
        socket,
        currentSession: existing?.currentSession ?? null,
        lastHello: existing?.lastHello ?? null,
      };
      this.connections.set(pairingKey, connection);
      this.emit("extension_connected", { pairingKey });

      socket.on("message", (buffer) => {
        this.handleIncomingMessage(pairingKey, buffer.toString("utf8"));
      });

      socket.on("close", () => {
        const active = this.connections.get(pairingKey);
        if (active?.socket === socket) {
          this.connections.set(pairingKey, {
            ...active,
            socket: null,
          });
          this.emit("extension_disconnected", { pairingKey });
        }
      });

      socket.on("error", (error) => {
        this.emit("error", new Error(`[${pairingKey}] ${String(error)}`));
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.once("listening", () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    for (const [requestId, pendingRequest] of this.pending.entries()) {
      clearTimeout(pendingRequest.timeout);
      pendingRequest.reject(new Error(`Bridge stopped before request ${requestId} completed.`));
      this.pending.delete(requestId);
    }

    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    this.server = null;
    this.connections.clear();
  }

  isExtensionConnected(pairingKey?: string): boolean {
    if (pairingKey) {
      return Boolean(this.connections.get(pairingKey)?.socket);
    }

    return Array.from(this.connections.values()).some((connection) => connection.socket !== null);
  }

  getCurrentSession(pairingKey?: string): SessionState | null {
    if (pairingKey) {
      return this.connections.get(pairingKey)?.currentSession ?? null;
    }

    const firstConnected = Array.from(this.connections.values()).find((connection) => connection.socket);
    return firstConnected?.currentSession ?? null;
  }

  getLastHello(pairingKey?: string): Extract<ExtensionToBridgeMessage, { type: "extension.hello" }> | null {
    if (pairingKey) {
      return this.connections.get(pairingKey)?.lastHello ?? null;
    }

    const firstConnected = Array.from(this.connections.values()).find((connection) => connection.socket);
    return firstConnected?.lastHello ?? null;
  }

  getConnectedPairingsCount(): number {
    return Array.from(this.connections.values()).filter((connection) => connection.socket !== null).length;
  }

  async execute(
    action: BrowserAction,
    options: ExecuteOptions = {},
  ): Promise<BrowserArtifact | undefined> {
    const pairingKey = this.resolveRequestedPairingKey(options.pairingKey);
    const socket = this.connections.get(pairingKey)?.socket ?? null;
    if (!socket) {
      throw new Error("No extension is connected to the local bridge.");
    }

    const requestId = randomUUID();
    const payload = BridgeToExtensionSchema.parse({
      type: "bridge.execute",
      requestId,
      sessionId: options.sessionId,
      taskName: options.taskName,
      targetTabId: options.targetTabId,
      agent: options.agent,
      action,
    });

    return await new Promise<BrowserArtifact | undefined>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timed out waiting for extension response to request ${requestId}.`));
      }, this.requestTimeoutMs);

      this.pending.set(requestId, { pairingKey, resolve, reject, timeout });
      socket.send(JSON.stringify(payload));
    });
  }

  private handleIncomingMessage(pairingKey: string, raw: string): void {
    let parsed: ExtensionToBridgeMessage;

    try {
      parsed = ExtensionToBridgeSchema.parse(JSON.parse(raw));
    } catch (error) {
      this.emit("error", new Error(`Invalid extension message: ${String(error)}`));
      return;
    }

    switch (parsed.type) {
      case "extension.hello":
        this.updateConnection(pairingKey, {
          lastHello: parsed,
        });
        this.emit("extension_hello", { pairingKey, hello: parsed });
        break;
      case "extension.session_update":
        this.updateConnection(pairingKey, {
          currentSession: parsed.session,
        });
        this.emit("session_update", { pairingKey, session: parsed.session });
        break;
      case "extension.action_result":
        this.resolvePending(pairingKey, parsed.requestId, parsed.ok, parsed.artifact, parsed.error);
        break;
    }
  }

  private resolvePending(
    pairingKey: string,
    requestId: string,
    ok: boolean,
    artifact?: BrowserArtifact,
    error?: string,
  ): void {
    const pendingRequest = this.pending.get(requestId);
    if (!pendingRequest) {
      return;
    }

    clearTimeout(pendingRequest.timeout);
    this.pending.delete(requestId);

    if (pendingRequest.pairingKey !== pairingKey) {
      pendingRequest.reject(new Error(`Request ${requestId} resolved from an unexpected browser pairing.`));
      return;
    }

    if (!ok) {
      pendingRequest.reject(new Error(error ?? `Request ${requestId} failed.`));
      return;
    }

    pendingRequest.resolve(artifact);
  }

  private updateConnection(pairingKey: string, patch: Partial<BridgeConnection>): void {
    const current = this.connections.get(pairingKey) ?? {
      socket: null,
      currentSession: null,
      lastHello: null,
    };

    this.connections.set(pairingKey, {
      ...current,
      ...patch,
    });
  }

  private resolveRequestedPairingKey(rawPairingKey: string | undefined): string {
    const pairingKey = sanitizePairingKey(rawPairingKey);
    if (pairingKey) {
      return pairingKey;
    }
    throw new Error("A browser pairing key is required.");
  }

  private resolvePairingKey(request: IncomingMessage): string | null {
    const url = new URL(request.url ?? "/", `ws://${this.host}:${this.port}`);
    const queryPairingKey = sanitizePairingKey(url.searchParams.get("pairingKey") ?? undefined);
    if (queryPairingKey) {
      return queryPairingKey;
    }

    const pathSegments = url.pathname.split("/").filter(Boolean);
    if (pathSegments.length === 0) {
      return null;
    }

    if (pathSegments[0] === "bridge" && pathSegments.length > 1) {
      return sanitizePairingKey(pathSegments[1]);
    }

    if (pathSegments[0] !== "bridge" && pathSegments.length === 1) {
      return sanitizePairingKey(pathSegments[0]);
    }

    return null;
  }
}
