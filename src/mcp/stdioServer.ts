import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createCBrowseServer } from "./createServer.js";

async function main(): Promise<void> {
  const { server } = await createCBrowseServer({
    host: process.env.CBROWSE_HOST ?? "127.0.0.1",
    port: Number(process.env.CBROWSE_PORT ?? "8787"),
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("[cbrowse] stdio MCP server failed", error);
  process.exitCode = 1;
});
