import { ExtensionBridge } from "../bridge/extensionBridge.js";

async function main(): Promise<void> {
  const bridge = new ExtensionBridge({
    host: process.env.CBROWSE_HOST ?? "127.0.0.1",
    port: Number(process.env.CBROWSE_PORT ?? "8787"),
  });

  bridge.on("extension_connected", () => {
    console.log("[cbrowse] extension connected");
  });

  bridge.on("extension_disconnected", () => {
    console.log("[cbrowse] extension disconnected");
  });

  bridge.on("extension_hello", (payload) => {
    console.log("[cbrowse] extension hello", payload);
  });

  bridge.on("session_update", (session) => {
    console.log("[cbrowse] session update", session);
  });

  bridge.on("error", (error) => {
    console.error("[cbrowse] bridge error", error);
  });

  await bridge.start();
  console.log(
    `[cbrowse] bridge listening on ws://${process.env.CBROWSE_HOST ?? "127.0.0.1"}:${process.env.CBROWSE_PORT ?? "8787"}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
