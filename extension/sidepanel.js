const summaryEl = document.getElementById("summary");
const locksEl = document.getElementById("locks");
const logsEl = document.getElementById("logs");

async function loadState() {
  const { cbrowseState } = await chrome.storage.local.get("cbrowseState");
  render(cbrowseState ?? null);
}

function render(state) {
  if (!state) {
    summaryEl.textContent = "No cBrowse state yet.";
    logsEl.innerHTML = "";
    return;
  }

  const session = state.currentSession;
  const lastActiveAgent = state.lastActiveAgent;
  summaryEl.textContent = [
    `Bridge: ${state.bridgeStatus}`,
    `Browser key: ${state.pairingKey ?? "Preparing…"}`,
    `Bridge URL: ${state.bridgeUrl}`,
    `MCP URL: ${state.mcpUrl}`,
    lastActiveAgent
      ? `Last active agent: ${lastActiveAgent.name} via ${lastActiveAgent.via}`
      : "Last active agent: none yet",
    session ? `Last session: ${session.sessionId} (${session.status})` : "Last session: idle",
    `Raw skill: ${state.skillUrl ?? "Unavailable"}`,
  ].join("\n");

  locksEl.innerHTML = "";
  for (const lock of state.tabLocks ?? []) {
    const item = document.createElement("div");
    item.className = "lock";
    item.innerHTML = `
      <div>Tab ${lock.tabId}</div>
      <div>${lock.agentName} via ${lock.via}</div>
      <div>${lock.integration}</div>
      <div>Session ${lock.sessionId}</div>
    `;
    locksEl.appendChild(item);
  }

  if ((state.tabLocks ?? []).length === 0) {
    locksEl.innerHTML = `<div class="lock">No tab locks. Agents can claim tabs as they start acting.</div>`;
  }

  logsEl.innerHTML = "";
  for (const log of [...(state.logs ?? [])].reverse()) {
    const item = document.createElement("div");
    item.className = "log";
    item.innerHTML = `
      <div class="time">${log.timestamp}</div>
      <div><span class="level">${log.level}</span>${log.message}</div>
      <pre>${log.data ? JSON.stringify(log.data, null, 2) : ""}</pre>
    `;
    logsEl.appendChild(item);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.cbrowseState) {
    return;
  }
  render(changes.cbrowseState.newValue);
});

void loadState();
