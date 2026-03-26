const origin = window.location.origin;
const params = new URLSearchParams(window.location.search);
const pairingKey = params.get("pairingKey")?.trim() || "";
const hasPairingKey = pairingKey.length > 0;
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const mobileMenu = document.getElementById("mobile-menu");
const mobileMenuToggle = document.getElementById("mobile-menu-toggle");
const mobileMenuLabel = mobileMenuToggle?.querySelector(".menu-label");
const mobileMediaQuery = window.matchMedia("(max-width: 860px)");

const mcpUrl = hasPairingKey
  ? `${origin}/mcp/${encodeURIComponent(pairingKey)}`
  : `${origin}/mcp/<your-browser-key>`;
const skillUrl = `${origin}/cbrowse-skill.md`;
const llmsUrl = `${origin}/llms.txt`;
const codexCommand = hasPairingKey
  ? `codex mcp add cbrowse --url ${mcpUrl}`
  : "Open the extension first to generate the MCP route for this browser profile.";
const setupPrompt = hasPairingKey
  ? `Connect cBrowse at "${mcpUrl}". If your client supports extra instructions, use the cBrowse skill at "${skillUrl}". Reuse the cookies, auth, and page state already present in the browser that issued this route. Claim a tab before destructive actions.`
  : "Open this page from the extension to get the browser-bound MCP route for the browser profile you want the agent to use.";

const values = {
  "hero-mcp-endpoint": mcpUrl,
  "mcp-endpoint": mcpUrl,
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

function shortPairingKey(value) {
  if (!value) {
    return "Awaiting browser key";
  }

  return value.length > 22 ? `${value.slice(0, 12)}...${value.slice(-6)}` : value;
}

function syncPairingState() {
  const pairingChip = document.getElementById("pairing-chip");
  const pairingNote = document.getElementById("pairing-note");
  const routeNote = document.getElementById("route-note");

  if (pairingChip) {
    pairingChip.textContent = shortPairingKey(pairingKey);
  }

  if (pairingNote) {
    pairingNote.textContent = hasPairingKey
      ? "This route belongs to the browser that generated it and reuses its current session state."
      : "Open the extension to create a browser-bound route.";
  }

  if (routeNote) {
    routeNote.textContent = hasPairingKey
      ? "Use this route only with the browser profile that issued it."
      : "Open this page from the extension to get the route for this browser profile.";
  }

  for (const button of document.querySelectorAll("[data-requires-pairing]")) {
    if (!button.dataset.defaultLabel) {
      button.dataset.defaultLabel = button.textContent?.trim() || "Copy";
    }

    button.disabled = !hasPairingKey;
    button.textContent = hasPairingKey ? button.dataset.defaultLabel : "Open extension first";
  }
}

syncPairingState();

function closeMobileMenu() {
  if (!mobileMenu || !mobileMenuToggle) {
    return;
  }

  mobileMenu.hidden = true;
  delete mobileMenu.dataset.open;
  mobileMenuToggle.setAttribute("aria-expanded", "false");
  mobileMenuToggle.setAttribute("aria-label", "Open navigation menu");
  if (mobileMenuLabel) {
    mobileMenuLabel.textContent = "Menu";
  }
}

function openMobileMenu() {
  if (!mobileMenu || !mobileMenuToggle) {
    return;
  }

  mobileMenu.hidden = false;
  mobileMenu.dataset.open = "true";
  mobileMenuToggle.setAttribute("aria-expanded", "true");
  mobileMenuToggle.setAttribute("aria-label", "Close navigation menu");
  if (mobileMenuLabel) {
    mobileMenuLabel.textContent = "Close";
  }
}

function syncMobileMenu() {
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
  link.addEventListener("click", closeMobileMenu);
}

document.addEventListener("click", (event) => {
  if (!mobileMediaQuery.matches || mobileMenu?.dataset.open !== "true") {
    return;
  }

  if (!mobileMenu.contains(event.target) && !mobileMenuToggle?.contains(event.target)) {
    closeMobileMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMobileMenu();
  }
});

mobileMediaQuery.addEventListener("change", syncMobileMenu);
syncMobileMenu();

async function copyText(button, text) {
  if (!text || button.disabled) {
    return;
  }

  const previous = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Failed";
  }

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

    await copyText(button, target.textContent?.trim() || "");
  });
}

document.getElementById("copy-skill-text")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const response = await fetch(skillUrl, { cache: "no-store" });
  if (!response.ok) {
    await copyText(button, "");
    return;
  }

  const text = await response.text();
  await copyText(button, text);
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

  if (!hasPairingKey) {
    statusText.textContent = "Waiting for browser key";
    statusMeta.textContent = "Open this page from the extension to unlock a browser-bound MCP route.";
    statusSession.textContent = "No browser route on this page yet.";
    return;
  }

  statusText.textContent = connected ? "Browser linked" : "Waiting for extension";
  statusMeta.textContent = connected
    ? `${actor} via ${transport}${payload?.bridge?.extensionVersion ? ` · extension ${payload.bridge.extensionVersion}` : ""}`
    : "This route is reserved for one signed-in browser profile.";

  if (session) {
    statusSession.textContent = `${session.taskName || "cBrowse task"} · ${session.status}`;
  } else if (connected) {
    statusSession.textContent = "Ready for the next session-aware task.";
  } else {
    statusSession.textContent = "No active agent task yet.";
  }
}

async function refreshStatus() {
  const statusPath = hasPairingKey
    ? `/api/status?pairingKey=${encodeURIComponent(pairingKey)}`
    : "/api/status";

  try {
    const response = await fetch(statusPath, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Unexpected status response: ${response.status}`);
    }

    renderStatus(await response.json());
  } catch {
    statusDot.dataset.state = "disconnected";
    statusText.textContent = hasPairingKey ? "Status unavailable" : "Waiting for browser key";
    statusMeta.textContent = hasPairingKey
      ? "The cBrowse bridge did not answer cleanly."
      : "Open this page from the extension to unlock a browser-bound MCP route.";
    statusSession.textContent = hasPairingKey ? "Retry in a moment." : "No browser route on this page yet.";
  }
}

function initReveals() {
  const revealTargets = document.querySelectorAll("[data-reveal]");
  if (prefersReducedMotion.matches) {
    for (const target of revealTargets) {
      target.dataset.revealed = "true";
    }
    return;
  }

  const observer = new IntersectionObserver(
    (entries, currentObserver) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }

        entry.target.dataset.revealed = "true";
        currentObserver.unobserve(entry.target);
      }
    },
    {
      threshold: 0.16,
      rootMargin: "0px 0px -6% 0px",
    }
  );

  for (const target of revealTargets) {
    observer.observe(target);
  }
}

function initParallax() {
  const frame = document.querySelector("[data-parallax]");
  const hero = document.querySelector(".hero");
  const disableParallax =
    prefersReducedMotion.matches ||
    window.matchMedia("(max-width: 960px)").matches ||
    window.matchMedia("(pointer: coarse)").matches;

  if (!frame || !hero || disableParallax) {
    return;
  }

  let ticking = false;

  const updateParallax = () => {
    const rect = hero.getBoundingClientRect();
    const progress = Math.min(Math.max((0 - rect.top) * 0.08, 0), 36);
    frame.style.setProperty("--parallax-shift", `${progress}px`);
    ticking = false;
  };

  const requestUpdate = () => {
    if (ticking) {
      return;
    }

    ticking = true;
    window.requestAnimationFrame(updateParallax);
  };

  updateParallax();
  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", requestUpdate);
}

initReveals();
initParallax();
void refreshStatus();
window.setInterval(refreshStatus, 12000);
