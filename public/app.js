const origin = window.location.origin;
const params = new URLSearchParams(window.location.search);
const pairingKey = params.get("pairingKey")?.trim() || "";
const hasPairingKey = pairingKey.length > 0;
const requestedTheme = params.get("theme")?.trim().toLowerCase();
const themeToggles = document.querySelectorAll("[data-theme-toggle]");
const themeStorageKey = "cbrowse-theme";
const mobileMenu = document.getElementById("mobile-menu");
const mobileMenuToggle = document.getElementById("mobile-menu-toggle");
const mobileMediaQuery = window.matchMedia("(max-width: 720px)");

const mcpUrl = hasPairingKey ? `${origin}/mcp/${encodeURIComponent(pairingKey)}` : `${origin}/mcp/<your-browser-key>`;
const skillUrl = `${origin}/cbrowse-skill.md`;
const llmsUrl = `${origin}/llms.txt`;
const codexCommand = hasPairingKey
  ? `codex mcp add cbrowse --url ${mcpUrl}`
  : "Load the extension first to get your browser-specific MCP URL.";
const setupPrompt = hasPairingKey
  ? `Connect the hosted cbrowse MCP at "${mcpUrl}". If your client supports extra instructions, use the cBrowse skill at "${skillUrl}". Then claim a dedicated browser tab before acting.`
  : "Open this page from the extension to get your browser-specific MCP URL.";

const values = {
  "mcp-endpoint": mcpUrl,
  "hero-mcp-endpoint": mcpUrl,
  "skill-url": skillUrl,
  "llms-url": llmsUrl,
  "codex-command": codexCommand,
  "setup-prompt": setupPrompt,
};

for (const [id, text] of Object.entries(values)) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = text;
  }
}

function resolveInitialTheme() {
  if (requestedTheme === "light" || requestedTheme === "dark") {
    return requestedTheme;
  }

  const storedTheme = window.localStorage.getItem(themeStorageKey);
  return storedTheme === "light" || storedTheme === "dark" ? storedTheme : "dark";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;

  for (const themeToggle of themeToggles) {
    const nextTheme = theme === "dark" ? "light" : "dark";
    themeToggle.textContent = nextTheme === "light" ? "Light mode" : "Dark mode";
    themeToggle.setAttribute("aria-label", `Switch to ${nextTheme} mode`);
  }
}

const activeTheme = resolveInitialTheme();
applyTheme(activeTheme);

for (const themeToggle of themeToggles) {
  themeToggle.addEventListener("click", () => {
    const nextTheme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    window.localStorage.setItem(themeStorageKey, nextTheme);
    applyTheme(nextTheme);
  });
}

function closeMobileMenu() {
  if (!mobileMenu || !mobileMenuToggle) {
    return;
  }

  mobileMenu.hidden = true;
  delete mobileMenu.dataset.open;
  mobileMenuToggle.setAttribute("aria-expanded", "false");
  mobileMenuToggle.setAttribute("aria-label", "Open navigation menu");
}

function openMobileMenu() {
  if (!mobileMenu || !mobileMenuToggle) {
    return;
  }

  mobileMenu.hidden = false;
  mobileMenu.dataset.open = "true";
  mobileMenuToggle.setAttribute("aria-expanded", "true");
  mobileMenuToggle.setAttribute("aria-label", "Close navigation menu");
}

function syncMobileMenu() {
  if (!mobileMenu) {
    return;
  }

  if (!mobileMediaQuery.matches) {
    closeMobileMenu();
  }
}

mobileMenuToggle?.addEventListener("click", () => {
  const isOpen = mobileMenu?.dataset.open === "true";
  if (isOpen) {
    closeMobileMenu();
    return;
  }

  openMobileMenu();
});

for (const link of document.querySelectorAll(".mobile-nav a")) {
  link.addEventListener("click", () => {
    closeMobileMenu();
  });
}

mobileMediaQuery.addEventListener("change", syncMobileMenu);
syncMobileMenu();

async function copyText(button, text) {
  await navigator.clipboard.writeText(text);
  const previous = button.textContent;
  button.textContent = "Copied";
  window.setTimeout(() => {
    button.textContent = previous;
  }, 1200);
}

for (const button of document.querySelectorAll("[data-copy-target]")) {
  button.addEventListener("click", async () => {
    const targetId = button.getAttribute("data-copy-target");
    const target = targetId ? document.getElementById(targetId) : null;
    if (!target) {
      return;
    }

    await copyText(button, target.textContent ?? "");
  });
}

document.getElementById("copy-skill-text")?.addEventListener("click", async (event) => {
  const response = await fetch(skillUrl);
  const text = await response.text();
  await copyText(event.currentTarget, text);
});

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const statusMeta = document.getElementById("status-meta");
const statusSession = document.getElementById("status-session");

function renderStatus(payload) {
  const connected = Boolean(payload?.bridge?.connected);
  const session = payload?.session;
  const sessionAgent = session?.agent;
  const connectedAgent = payload?.bridge?.connectedAgent;
  const actor = sessionAgent?.name || connectedAgent?.name || "No agent yet";
  const transport = sessionAgent?.via || connectedAgent?.via || "mcp";

  statusDot.dataset.state = connected ? "connected" : "disconnected";
  statusText.textContent = connected ? "Bridge connected" : hasPairingKey ? "Waiting for your extension" : "Waiting for a browser key";
  statusMeta.textContent = connected
    ? `${actor} via ${transport}${payload?.bridge?.extensionVersion ? ` · extension ${payload.bridge.extensionVersion}` : ""}`
    : hasPairingKey
      ? "This route is reserved for one browser."
      : "Open this page from the extension to get your private route.";

  if (session) {
    statusSession.textContent = `${session.taskName || "cBrowse task"} · ${session.status}`;
  } else if (connected) {
    statusSession.textContent = "Ready for the next claimed tab.";
  } else {
    statusSession.textContent = hasPairingKey
      ? "No live browser session yet."
      : "No private browser key on this page.";
  }
}

async function refreshStatus() {
  const statusPath = hasPairingKey ? `/api/status?pairingKey=${encodeURIComponent(pairingKey)}` : "/api/status";

  try {
    const response = await fetch(statusPath, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Unexpected status response: ${response.status}`);
    }

    renderStatus(await response.json());
  } catch {
    statusDot.dataset.state = "disconnected";
    statusText.textContent = "Status unavailable";
    statusMeta.textContent = "The hosted relay is up, but the status endpoint did not answer cleanly.";
    statusSession.textContent = "Retry in a moment.";
  }
}

void refreshStatus();
window.setInterval(refreshStatus, 10000);
