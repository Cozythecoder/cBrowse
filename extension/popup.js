const bridgeBadgeEl = document.getElementById("bridge-badge");
const bridgeLabelEl = document.getElementById("bridge-label");
const summaryEl = document.getElementById("summary");
const hintEl = document.getElementById("hint");
const outputEl = document.getElementById("output");

let latestState = null;
let inspectVisible = false;

function bridgeLabel(status) {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "waiting_for_bridge":
      return "Waiting";
    case "error":
      return "Error";
    case "disconnected":
      return "Offline";
    default:
      return "Idle";
  }
}

function buildSummary(state) {
  const session = state.currentSession;
  if (session) {
    const taskName = session.taskName?.trim() || "cBrowse task";
    return `${taskName} · ${session.status}`;
  }

  if (state.bridgeStatus === "connected") {
    return "Your browser is linked.";
  }

  if (state.bridgeStatus === "connecting" || state.bridgeStatus === "waiting_for_bridge") {
    return "Trying to reach your browser.";
  }

  if (state.bridgeStatus === "error" || state.bridgeStatus === "disconnected") {
    return "Browser not connected.";
  }

    return "Preparing cBrowse link.";
}

function buildHint(state) {
  if (state.bridgeStatus === "connected") {
    return "Copy MCP or open setup.";
  }

  return "Reload the extension tab if the bridge stays offline.";
}

function renderState(state) {
  latestState = state;
  bridgeBadgeEl.dataset.status = state.bridgeStatus;
  bridgeLabelEl.textContent = bridgeLabel(state.bridgeStatus);
  summaryEl.textContent = buildSummary(state);
  hintEl.textContent = buildHint(state);
}

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: "ui/get-state" });
  renderState(response);
}

async function copyText(button, text) {
  await navigator.clipboard.writeText(text);
  const previous = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = previous;
  }, 1200);
}

document.getElementById("open-setup-page").addEventListener("click", async () => {
  if (!latestState?.landingUrl) {
    return;
  }

  await chrome.tabs.create({ url: latestState.landingUrl });
});

document.getElementById("copy-mcp-line").addEventListener("click", async (event) => {
  await copyText(event.currentTarget, latestState?.mcpUrl ?? "");
});

document.getElementById("reconnect-bridge").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "ui/connect-bridge" });
  renderState(response.state ?? latestState);
});

document.getElementById("toggle-inspect").addEventListener("click", async (event) => {
  inspectVisible = !inspectVisible;
  outputEl.classList.toggle("hidden", !inspectVisible);
  event.currentTarget.textContent = inspectVisible ? "Hide inspect" : "Inspect";

  if (!inspectVisible) {
    return;
  }

  const response = await chrome.runtime.sendMessage({ type: "ui/inspect-page" });
  outputEl.textContent = JSON.stringify(response.artifact ?? response, null, 2);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.cbrowseState?.newValue) {
    return;
  }

  renderState(changes.cbrowseState.newValue);
});

void loadState();
