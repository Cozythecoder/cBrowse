import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { ExtensionBridge } from "../bridge/extensionBridge.js";
import { createMcpServerFromBridge } from "./createServer.js";

const host = process.env.CBROWSE_HTTP_HOST ?? "127.0.0.1";
const port = Number(process.env.CBROWSE_HTTP_PORT ?? "8788");
const mcpPath = process.env.CBROWSE_MCP_PATH ?? "/mcp";
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "../..");
const publicDir = path.join(projectRoot, "public");
const skillPath = path.join(projectRoot, ".agents", "skills", "cbrowse", "SKILL.md");
const mcpPathWithPairing = `${mcpPath}/:pairingKey`;

function sanitizePairingKey(rawValue: unknown): string | null {
  if (typeof rawValue !== "string") {
    return null;
  }

  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/[^a-zA-Z0-9._~-]/g, "");
  return normalized || null;
}

function pairingKeyFromRequest(req: express.Request): string | undefined {
  return sanitizePairingKey(req.params.pairingKey) ?? sanitizePairingKey(req.query.pairingKey) ?? undefined;
}

function sessionAgent(session: ReturnType<ExtensionBridge["getCurrentSession"]>) {
  const metadata = session?.metadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const name = typeof metadata.agentName === "string" ? metadata.agentName : null;
  if (!name) {
    return null;
  }

  return {
    id: typeof metadata.agentId === "string" ? metadata.agentId : "",
    name,
    via: typeof metadata.via === "string" ? metadata.via : "mcp",
    integration: typeof metadata.integration === "string" ? metadata.integration : "MCP",
    lastAction: typeof metadata.lastAction === "string" ? metadata.lastAction : "",
  };
}

async function main(): Promise<void> {
  const app = createMcpExpressApp({ host });
  const bridge = new ExtensionBridge({
    host: process.env.CBROWSE_HOST ?? "127.0.0.1",
    port: Number(process.env.CBROWSE_PORT ?? "8787"),
  });

  await bridge.start();

  async function handleMcpRequest(req: express.Request, res: express.Response): Promise<void> {
    const pairingKey = pairingKeyFromRequest(req);
    if (!pairingKey) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Pairing key required. Use the browser-specific MCP URL from the extension.",
        },
        id: null,
      });
      return;
    }

    const server = createMcpServerFromBridge(bridge, { pairingKey });

    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      console.error("[cbrowse] HTTP MCP request failed", error);

      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  }

  app.get("/api/status", (req, res) => {
    const pairingKey = pairingKeyFromRequest(req);
    const session = bridge.getCurrentSession(pairingKey);
    const hello = bridge.getLastHello(pairingKey);

    res.json({
      bridge: {
        connected: bridge.isExtensionConnected(pairingKey),
        connectedPairings: bridge.getConnectedPairingsCount(),
        extensionVersion: hello?.version ?? null,
        connectedAgent: hello?.connectedAgent ?? null,
        pairingKey: pairingKey ?? null,
      },
      session: session
        ? {
            sessionId: session.sessionId,
            status: session.status,
            taskName: session.taskName ?? "cBrowse task",
            agent: sessionAgent(session),
          }
        : null,
    });
  });

  app.get("/cbrowse-skill.md", (_req, res) => {
    res.type("text/markdown; charset=utf-8");
    res.sendFile(skillPath, { dotfiles: "allow" }, (error) => {
      if (error && !res.headersSent) {
        const errorWithStatus = error as Error & { statusCode?: number };
        const statusCode = typeof errorWithStatus.statusCode === "number" ? errorWithStatus.statusCode : 404;
        res.status(statusCode).send("cbrowse skill not found");
      }
    });
  });

  app.post([mcpPath, mcpPathWithPairing, "/"], handleMcpRequest);

  app.get([mcpPath, mcpPathWithPairing], (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    });
  });

  app.delete([mcpPath, mcpPathWithPairing], (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    });
  });

  app.use(express.static(publicDir, { index: "index.html" }));

  app.listen(port, host, () => {
    console.log(`[cbrowse] HTTP MCP server listening on http://${host}:${port}${mcpPath}`);
  });
}

main().catch((error) => {
  console.error("[cbrowse] HTTP MCP server failed", error);
  process.exitCode = 1;
});
