# cBrowse

cBrowse is a hosted browser bridge for AI agents.

It gives an agent one dedicated browser tab, exposes browser actions over MCP, and ships a Chrome extension plus a hosted setup page so users do not need to run a local relay manually.

## What It Includes

- A Chrome extension for page inspection and browser control.
- A local WebSocket bridge and hosted HTTP MCP server.
- A browser-specific pairing flow so each client targets its own browser route.
- A hosted landing page, `llms.txt`, and a raw Codex skill.
- Deployment scripts for a small DigitalOcean Droplet.

## How It Works

1. The user loads the cBrowse extension in Chrome.
2. The extension connects to the bridge and gets a browser-specific MCP route.
3. The agent connects to that MCP route.
4. The agent claims one dedicated tab and performs browser actions through MCP.

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Run the project locally

```bash
npm run build
npm run dev:relay
```

In another shell:

```bash
npm run dev:mcp:http
```

### 3. Load the extension

For local development, load the repo root in Chrome as an unpacked extension:

- `/Users/cozy/Documents/cBrowse`

For a packaged release, cBrowse builds from the standalone extension under:

- `extension/`

### 4. Connect your agent

Open the extension popup, copy the browser-specific MCP URL, and add it to your client.

For Codex:

```bash
codex mcp add cbrowse --url https://your-domain.example/mcp/<browser-key>
```

If your client supports a raw skill file, point it at:

```text
https://your-domain.example/cbrowse-skill.md
```

## Local Commands

- `npm run check`
- `npm run build`
- `npm run dev:relay`
- `npm run dev:mcp:stdio`
- `npm run dev:mcp:http`
- `npm run install:codex-skill`
- `npm run build:extension`
- `npm run release:local`

## Build Extension Releases

cBrowse can produce both a distributable `.zip` and a signed `.crx`.

```bash
npm run build:extension
```

Artifacts are written to:

- `release/cBrowse-extension-v<version>.zip`
- `release/cBrowse-extension-v<version>.crx`
- `release/SHA256SUMS.txt`

### Signing key behavior

- If `release/keys/cbrowse-extension.pem` already exists, it is reused.
- If no key exists, Chrome generates one during the first CRX build.
- Keep that `.pem` file safe and private.
- Do not commit the private key.
- If you lose the key, the extension ID will change the next time you package it.

You can also point at a custom key:

```bash
CBROWSE_EXTENSION_KEY=/absolute/path/to/key.pem npm run build:extension
```

You can override the Chrome binary too:

```bash
CHROME_BIN=/path/to/chrome npm run build:extension
```

## GitHub Release Workflow

This repo includes a GitHub Actions workflow that:

- installs dependencies
- runs type checks
- builds extension release artifacts
- uploads artifacts on manual runs
- publishes them to GitHub Releases on version tags

If you want CI-built CRX files with a stable extension ID, add this repository secret:

- `CBROWSE_EXTENSION_PEM`

Store it as base64-encoded contents of your `cbrowse-extension.pem`.

## Self-Hosting

The hosted relay stack is in:

- `deploy/digitalocean/`

That deployment exposes:

- `wss://<domain>/bridge`
- `https://<domain>/mcp`

See [deploy/digitalocean/README.md](/Users/cozy/Documents/cBrowse/deploy/digitalocean/README.md) for the Droplet flow.

## Project Structure

- `extension/` Chrome extension source
- `src/bridge/` bridge server logic
- `src/mcp/` MCP server and HTTP transport
- `public/` landing page and hosted setup assets
- `.agents/skills/cbrowse/` raw Codex skill
- `deploy/digitalocean/` hosted deployment scripts
- `scripts/` local helper and packaging scripts

## Security Notes

- The browser route is pairing-key scoped, not account-auth scoped.
- The extension should only connect to infrastructure you control.
- Treat the packaged extension key and hosted MCP routes as sensitive.

## License

MIT. See [LICENSE](/Users/cozy/Documents/cBrowse/LICENSE).
