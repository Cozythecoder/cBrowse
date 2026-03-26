import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ExtensionBridge, type ExtensionBridgeOptions } from "../bridge/extensionBridge.js";
import { invokeTool, toolCatalog, type ToolName } from "./toolCatalog.js";

type CBrowseServer = {
  bridge: ExtensionBridge;
  server: McpServer;
};

function renderText(result: unknown): string {
  return JSON.stringify(result, null, 2);
}

function inputShapeFor(toolName: ToolName) {
  const tool = toolCatalog.find((entry) => entry.name === toolName);
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  return tool.inputSchema.shape;
}

export function createMcpServerFromBridge(
  bridge: ExtensionBridge,
  options: {
    pairingKey?: string;
  } = {},
): McpServer {
  const server = new McpServer({
    name: "cbrowse",
    version: "0.1.0",
  });

  for (const tool of toolCatalog) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: inputShapeFor(tool.name),
      } as never,
      (async (args: unknown) => {
        const result = await invokeTool(bridge, tool.name, args, options.pairingKey);
        return {
          content: [
            {
              type: "text" as const,
              text: renderText(result),
            },
          ],
          structuredContent: result as Record<string, unknown>,
        };
      }) as never,
    );
  }

  return server;
}

export async function createCBrowseServer(
  bridgeOptions: ExtensionBridgeOptions = {},
): Promise<CBrowseServer> {
  const bridge = new ExtensionBridge(bridgeOptions);
  await bridge.start();

  return {
    bridge,
    server: createMcpServerFromBridge(bridge),
  };
}
