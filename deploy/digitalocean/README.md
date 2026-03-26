# DigitalOcean Deployment

This deployment turns `cBrowse` into a remotely hosted relay:

- browser extension bridge over `wss://<domain>/bridge`
- hosted HTTP MCP endpoint over `https://<domain>/mcp`

That lets AI agents connect to the hosted MCP URL while your browser extension connects to the hosted bridge URL. You do not need to keep a local stdio MCP process open just to expose the relay.

## Prerequisites

1. A DigitalOcean account and API token.
2. At least one SSH key already added to your DigitalOcean account.
3. A domain or subdomain you can point at the Droplet IP.
4. Either an existing Ubuntu 24.04 Droplet or permission to create a new one.

## Provision

```bash
export DIGITALOCEAN_ACCESS_TOKEN=...
doctl auth init -t "$DIGITALOCEAN_ACCESS_TOKEN"
SSH_KEYS=123456,aa:bb:cc:dd:... REGION=sgp1 ./deploy/digitalocean/create-droplet.sh
```

The script defaults to:

- name: `cbrowse`
- image: `ubuntu-24-04-x64`
- size: `s-1vcpu-1gb`
- region: `sgp1`

## Deploy

```bash
DOMAINS='cbrowse.example.com, backup.example.com' ./deploy/digitalocean/deploy.sh root@<droplet-ip>
```

For a non-root SSH user with sudo, either pass a writable remote directory or let the script default to `~/cBrowse`.

## Verify

```bash
docker compose ps
curl -I https://<domain>/mcp
```

`GET /mcp` should return `405 Method Not Allowed`, which confirms the MCP route is live and waiting for MCP `POST` requests.

## Agent Setup

For HTTP-capable MCP clients, use:

```text
https://<domain>/mcp
```

For Codex CLI specifically:

```bash
codex mcp add cbrowse_remote --url https://<domain>/mcp
```
