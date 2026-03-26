const HOSTED_ORIGIN = "https://gamehub.qzz.io";
const HOSTED_BRIDGE_ORIGIN = "wss://gamehub.qzz.io";
const PAIRING_KEY_PREFIX = "cbrowse_";
const DEFAULT_SKILL_URL = `${HOSTED_ORIGIN}/cbrowse-skill.md`;
const DEFAULT_LLMSTXT_URL = `${HOSTED_ORIGIN}/llms.txt`;
const STATE_KEY = "cbrowseState";
const CONTENT_RETRY_DELAY_MS = 250;
const CONTENT_RETRY_LIMIT = 20;
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const MAX_ANNOTATED_RECTS = 40;
const SESSION_TITLE_ANIMATION_INTERVAL_MS = 900;
const SESSION_TITLE_ANIMATION_SUFFIXES = ["", " ·", " ··", " ···"];
const GENERIC_TASK_NAME = "cBrowse task";
const GROUP_TITLE_ICON = "✋";
const TASK_NAME_MAX_LENGTH = 52;
const GROUP_TITLE_MAX_LENGTH = 38;
const TASK_QUERY_PARAM_KEYS = [
  "task",
  "taskName",
  "q",
  "query",
  "search",
  "search_query",
  "keyword",
];

const CAPABILITIES = [
  "browser_navigate",
  "browser_click",
  "browser_input",
  "browser_press_key",
  "browser_scroll",
  "browser_move_mouse",
  "browser_find_keyword",
  "browser_view",
];

const TASK_STATUS_PREFIX = {
  idle: "WAIT",
  running: "RUN",
  completed: "DONE",
  stopped: "STOP",
  takeover: "TAKE",
  error: "ERR",
};

const TASK_STATUS_COLOR = {
  idle: "grey",
  running: "blue",
  completed: "green",
  stopped: "grey",
  takeover: "yellow",
  error: "red",
};

const AGENT_PROFILES = [
  {
    key: "hosted_mcp",
    name: "Hosted MCP",
    integration: "Cloud relay",
    liveTransport: "mcp",
    description: "Hosted cBrowse relay for any MCP-capable agent.",
  },
];

const DEFAULT_AGENT_KEY = AGENT_PROFILES[0].key;

const state = {
  pairingKey: null,
  bridgeStatus: "idle",
  bridgeUrl: "",
  mcpUrl: "",
  selectedAgentKey: DEFAULT_AGENT_KEY,
  connectedAgentKey: null,
  currentSession: null,
  sessions: {},
  tabLocks: {},
  logs: [],
};

let bridgeSocket = null;
let bridgeGeneration = 0;
let reconnectTimer = null;
let reconnectDelayMs = 15000;
let connectPromise = null;
let tabGroupsSupported = null;
const sessionTitleAnimationTimers = new Map();
const debuggerSessions = new Map();

function randomHex(length) {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

function generatePairingKey() {
  return `${PAIRING_KEY_PREFIX}${randomHex(24)}`;
}

function buildBridgeUrl(pairingKey) {
  return `${HOSTED_BRIDGE_ORIGIN}/bridge/${encodeURIComponent(pairingKey)}`;
}

function buildMcpUrl(pairingKey) {
  return `${HOSTED_ORIGIN}/mcp/${encodeURIComponent(pairingKey)}`;
}

function buildLandingUrl(pairingKey) {
  return `${HOSTED_ORIGIN}/?pairingKey=${encodeURIComponent(pairingKey)}`;
}

function buildStatusUrl(pairingKey) {
  return `${HOSTED_ORIGIN}/api/status?pairingKey=${encodeURIComponent(pairingKey)}`;
}

function applyHostedConfig(pairingKey) {
  state.pairingKey = pairingKey;
  state.bridgeUrl = buildBridgeUrl(pairingKey);
  state.mcpUrl = buildMcpUrl(pairingKey);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function resetReconnectDelay() {
  reconnectDelayMs = 15000;
}

function nextReconnectDelay() {
  const currentDelay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 300000);
  return currentDelay;
}

function supportsTabGroups() {
  if (tabGroupsSupported !== null) {
    return tabGroupsSupported;
  }

  tabGroupsSupported =
    typeof chrome.tabs?.group === "function" && typeof chrome.tabGroups !== "undefined";
  return tabGroupsSupported;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function debuggerTargetForTab(tabId) {
  return { tabId };
}

async function ensureDebuggerSession(tabId, sessionId = undefined) {
  const existing = debuggerSessions.get(tabId);
  if (existing) {
    if (sessionId) {
      existing.sessionIds.add(sessionId);
    }
    existing.lastUsedAt = new Date().toISOString();
    return debuggerTargetForTab(tabId);
  }

  const target = debuggerTargetForTab(tabId);
  try {
    await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION);
    try {
      await chrome.debugger.sendCommand(target, "Page.enable");
    } catch {
      // Ignore duplicate enable calls.
    }
  } catch (error) {
    const message = String(error);
    if (message.includes("Another debugger is already attached")) {
      throw new Error(`Another debugger is already attached to tab ${tabId}.`);
    }
    throw error;
  }

  debuggerSessions.set(tabId, {
    sessionIds: new Set(sessionId ? [sessionId] : []),
    attachedAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  });
  return target;
}

async function releaseDebuggerSession(tabId, sessionId = undefined, force = false) {
  const existing = debuggerSessions.get(tabId);
  if (!existing) {
    return;
  }

  if (sessionId) {
    existing.sessionIds.delete(sessionId);
  }

  if (!force && existing.sessionIds.size > 0) {
    existing.lastUsedAt = new Date().toISOString();
    return;
  }

  debuggerSessions.delete(tabId);
  try {
    await chrome.debugger.detach(debuggerTargetForTab(tabId));
  } catch {
    // Ignore detach races during tab/session teardown.
  }
}

async function releaseDebuggerSessionsForSession(sessionId) {
  const releases = [];
  for (const [tabId, debuggerSession] of debuggerSessions.entries()) {
    if (!debuggerSession.sessionIds.has(sessionId)) {
      continue;
    }
    releases.push(releaseDebuggerSession(tabId, sessionId, true));
  }
  await Promise.allSettled(releases);
}

function sessionMaskState(session) {
  const explicitMaskState = session?.metadata?.maskState;
  if (
    explicitMaskState === "idle" ||
    explicitMaskState === "ongoing" ||
    explicitMaskState === "takeover" ||
    explicitMaskState === "hidden"
  ) {
    return explicitMaskState;
  }

  if (session?.metadata?.maskState === "hidden") {
    return "hidden";
  }
  if (session?.status === "takeover") {
    return "takeover";
  }
  if (session?.status === "running") {
    return "ongoing";
  }
  return null;
}

function sessionMaskStatus(session) {
  return typeof session?.metadata?.maskStatus === "string" ? session.metadata.maskStatus : "";
}

async function captureWithDebugger(tabId, sessionId, callback) {
  const target = await ensureDebuggerSession(tabId, sessionId);
  return await callback(target);
}

async function captureTabScreenshot(tabId, sessionId) {
  const data = await captureWithDebugger(tabId, sessionId, async (target) => {
    const response = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 65,
      fromSurface: true,
      optimizeForSpeed: true,
    });
    return response.data;
  });

  return data ? `data:image/jpeg;base64,${data}` : null;
}

async function annotateScreenshot(cleanScreenshotDataUrl, artifact) {
  if (
    !cleanScreenshotDataUrl ||
    !artifact ||
    !Array.isArray(artifact.elementRects) ||
    artifact.elementRects.length === 0 ||
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap !== "function"
  ) {
    return cleanScreenshotDataUrl;
  }

  const sourceWidth =
    typeof artifact.viewportWidth === "number" && artifact.viewportWidth > 0
      ? artifact.viewportWidth
      : null;
  const sourceHeight =
    typeof artifact.viewportHeight === "number" && artifact.viewportHeight > 0
      ? artifact.viewportHeight
      : null;

  const response = await fetch(cleanScreenshotDataUrl);
  const sourceBlob = await response.blob();
  const bitmap = await createImageBitmap(sourceBlob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) {
      return cleanScreenshotDataUrl;
    }

    context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);
    const scaleX = sourceWidth ? bitmap.width / sourceWidth : 1;
    const scaleY = sourceHeight ? bitmap.height / sourceHeight : 1;

    context.lineWidth = 2;
    context.font = "600 12px ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    context.textBaseline = "top";

    for (const rect of artifact.elementRects.slice(0, MAX_ANNOTATED_RECTS)) {
      const width = Math.max(Math.round(rect.width * scaleX), 2);
      const height = Math.max(Math.round(rect.height * scaleY), 2);
      const x = Math.round(rect.x * scaleX);
      const y = Math.round(rect.y * scaleY);
      const label = String(rect.index);
      const labelWidth = Math.max(Math.ceil(context.measureText(label).width) + 10, 20);
      const labelHeight = 18;

      context.strokeStyle = "rgba(59, 130, 246, 0.96)";
      context.fillStyle = "rgba(59, 130, 246, 0.16)";
      context.strokeRect(x, y, width, height);
      context.fillRect(x, y, width, height);

      context.fillStyle = "rgba(37, 99, 235, 0.98)";
      context.fillRect(x, Math.max(y - labelHeight, 0), labelWidth, labelHeight);
      context.fillStyle = "#ffffff";
      context.fillText(label, x + 5, Math.max(y - labelHeight, 0) + 3);
    }

    const outputBlob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: 0.72,
    });
    return `data:image/jpeg;base64,${arrayBufferToBase64(await outputBlob.arrayBuffer())}`;
  } finally {
    if (typeof bitmap.close === "function") {
      bitmap.close();
    }
  }
}

async function captureArtifactScreenshots(tabId, artifact, sessionId) {
  const cleanScreenshotDataUrl = await captureTabScreenshot(tabId, sessionId);
  if (!cleanScreenshotDataUrl) {
    return {};
  }

  const screenshotDataUrl = await annotateScreenshot(cleanScreenshotDataUrl, artifact).catch(
    () => cleanScreenshotDataUrl,
  );

  return {
    screenshotUploaded: Boolean(screenshotDataUrl),
    cleanScreenshotUploaded: true,
    screenshotDataUrl,
    cleanScreenshotDataUrl,
  };
}

function getAgentProfile(agentKey) {
  return AGENT_PROFILES.find((profile) => profile.key === agentKey) ?? AGENT_PROFILES[0];
}

function selectedAgentProfile() {
  return getAgentProfile(state.selectedAgentKey);
}

function connectedAgentProfile() {
  return state.connectedAgentKey ? getAgentProfile(state.connectedAgentKey) : null;
}

function sessionAgentDetails(session) {
  const metadata = session?.metadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const agentName = typeof metadata.agentName === "string" ? metadata.agentName : null;
  if (!agentName) {
    return null;
  }

  return {
    id: typeof metadata.agentId === "string" ? metadata.agentId : "",
    name: agentName,
    via: typeof metadata.via === "string" ? metadata.via : "mcp",
    integration: typeof metadata.integration === "string" ? metadata.integration : "MCP",
    lastAction: typeof metadata.lastAction === "string" ? metadata.lastAction : "",
  };
}

function buildSetupPrompt() {
  if (!state.pairingKey) {
    return "Preparing private browser pairing…";
  }

  return `Connect the hosted cbrowse MCP at "${state.mcpUrl}". If your client supports extra instructions, use the cBrowse skill at "${DEFAULT_SKILL_URL}". Then claim a dedicated browser tab before acting.`;
}

function serializableState() {
  const activeAgent = sessionAgentDetails(state.currentSession);
  const landingUrl = state.pairingKey ? buildLandingUrl(state.pairingKey) : HOSTED_ORIGIN;
  const statusUrl = state.pairingKey ? buildStatusUrl(state.pairingKey) : `${HOSTED_ORIGIN}/api/status`;

  return {
    pairingKey: state.pairingKey,
    bridgeStatus: state.bridgeStatus,
    bridgeUrl: state.bridgeUrl,
    mcpUrl: state.mcpUrl,
    skillUrl: DEFAULT_SKILL_URL,
    llmsUrl: DEFAULT_LLMSTXT_URL,
    landingUrl,
    statusUrl,
    setupPrompt: buildSetupPrompt(),
    codexSetupCommand: `codex mcp add cbrowse --url ${state.mcpUrl}`,
    selectedAgentKey: state.selectedAgentKey,
    connectedAgentKey: state.connectedAgentKey,
    selectedAgent: selectedAgentProfile(),
    connectedAgent: connectedAgentProfile(),
    lastActiveAgent: activeAgent,
    agentProfiles: AGENT_PROFILES,
    currentSession: state.currentSession,
    sessions: Object.values(state.sessions),
    tabLocks: Object.values(state.tabLocks),
    logs: state.logs.slice(-100),
  };
}

async function persistState() {
  await chrome.storage.local.set({ [STATE_KEY]: serializableState() });
  try {
    await chrome.runtime.sendMessage({
      type: "operator/state-updated",
      state: serializableState(),
    });
  } catch {
    // Popup or sidepanel may not be open.
  }
}

async function appendLog(level, message, data = undefined) {
  state.logs.push({
    level,
    message,
    data,
    timestamp: new Date().toISOString(),
  });
  state.logs = state.logs.slice(-100);
  await persistState();
}

async function setBridgeStatus(status) {
  state.bridgeStatus = status;
  await persistState();
}

async function selectAgent(agentKey) {
  state.selectedAgentKey = getAgentProfile(agentKey).key;
  await persistState();
}

async function setConnectedAgent(agentKeyOrNull) {
  state.connectedAgentKey = agentKeyOrNull;
  await persistState();
}

function normalizeConfiguredUrl(rawValue, allowedProtocols, label) {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }

  let parsed;
  try {
    parsed = new URL(rawValue.trim());
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }

  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new Error(`${label} must use one of: ${allowedProtocols.join(", ")}`);
  }

  return parsed.toString();
}

function normalizeBridgeUrl(rawValue) {
  return normalizeConfiguredUrl(rawValue, ["ws:", "wss:"], "Bridge URL");
}

function normalizeMcpUrl(rawValue) {
  return normalizeConfiguredUrl(rawValue, ["http:", "https:"], "MCP URL");
}

async function ensurePairingKey() {
  if (state.pairingKey) {
    applyHostedConfig(state.pairingKey);
    return state.pairingKey;
  }

  const nextPairingKey = generatePairingKey();
  applyHostedConfig(nextPairingKey);
  return nextPairingKey;
}

async function hydrateState() {
  const stored = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
  if (stored && typeof stored === "object") {
    if (typeof stored.selectedAgentKey === "string") {
      state.selectedAgentKey = getAgentProfile(stored.selectedAgentKey).key;
    }

    if (typeof stored.pairingKey === "string" && stored.pairingKey.trim().length > 0) {
      state.pairingKey = stored.pairingKey.trim();
    }
  }

  await ensurePairingKey();
}

async function setConnectionConfig({ bridgeUrl, mcpUrl }) {
  const requestedBridgeUrl =
    typeof bridgeUrl === "string" ? normalizeBridgeUrl(bridgeUrl) : state.bridgeUrl;
  const requestedMcpUrl =
    typeof mcpUrl === "string" ? normalizeMcpUrl(mcpUrl) : state.mcpUrl;
  const bridgeChanged = requestedBridgeUrl !== state.bridgeUrl;
  const mcpChanged = requestedMcpUrl !== state.mcpUrl;

  await ensurePairingKey();
  await persistState();

  return { bridgeChanged, mcpChanged };
}

function buildSessionRecord(session) {
  return {
    ...session,
    updatedAt: new Date().toISOString(),
  };
}

function collapseWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateLabel(value, maxLength = TASK_NAME_MAX_LENGTH) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(maxLength - 1, 1)).trimEnd()}…`;
}

function humanizeTaskLabel(rawValue, maxLength = TASK_NAME_MAX_LENGTH) {
  if (typeof rawValue !== "string") {
    return "";
  }

  let label = collapseWhitespace(rawValue);
  if (!label) {
    return "";
  }

  label = label.replace(/[_-]+/g, " ");
  label = collapseWhitespace(label);
  if (!label) {
    return "";
  }

  if (/^[a-z0-9 ]+$/.test(label)) {
    label = label.replace(/\b\w/g, (character) => character.toUpperCase());
  }

  return truncateLabel(label, maxLength);
}

function meaningfulTaskLabel(rawValue, maxLength = TASK_NAME_MAX_LENGTH) {
  const label = humanizeTaskLabel(rawValue, maxLength);
  if (!label || label.toLowerCase() === GENERIC_TASK_NAME.toLowerCase()) {
    return "";
  }

  return label;
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function taskNameFromSessionId(sessionId) {
  if (typeof sessionId !== "string" || !sessionId.trim() || isUuidLike(sessionId.trim())) {
    return "";
  }

  return meaningfulTaskLabel(sessionId);
}

function taskNameFromUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return "";
  }

  try {
    const parsed = new URL(rawUrl);
    for (const key of TASK_QUERY_PARAM_KEYS) {
      const candidate = meaningfulTaskLabel(parsed.searchParams.get(key));
      if (candidate) {
        return candidate;
      }
    }

    const lastSegment = parsed.pathname
      .split("/")
      .filter(Boolean)
      .pop();

    return meaningfulTaskLabel(lastSegment || parsed.hostname.replace(/^www\./, ""));
  } catch {
    return "";
  }
}

function taskNameFromTab(tab) {
  if (!tab || typeof tab !== "object") {
    return "";
  }

  return meaningfulTaskLabel(tab.title) || taskNameFromUrl(tab.url ?? "");
}

function resolveSessionTaskName({
  requestedTaskName,
  existingTaskName,
  sessionId,
  action,
  tab,
}) {
  const candidates = [
    meaningfulTaskLabel(requestedTaskName),
    meaningfulTaskLabel(existingTaskName),
    taskNameFromSessionId(sessionId),
    action?.type === "browser_navigate" ? taskNameFromUrl(action.url) : "",
    taskNameFromTab(tab),
  ];

  return candidates.find(Boolean) || undefined;
}

function taskNameForSession(session) {
  return (
    meaningfulTaskLabel(session?.taskName) ||
    taskNameFromSessionId(session?.sessionId) ||
    GENERIC_TASK_NAME
  );
}

function animatedTaskTitleForSession(session, frameIndex = 0) {
  const suffix =
    session.status === "running"
      ? SESSION_TITLE_ANIMATION_SUFFIXES[frameIndex % SESSION_TITLE_ANIMATION_SUFFIXES.length]
      : "";
  return `${GROUP_TITLE_ICON} ${truncateLabel(taskNameForSession(session), GROUP_TITLE_MAX_LENGTH)}${suffix}`;
}

function sessionAgentIdentity(session) {
  const metadata = session.metadata ?? {};
  const fallback = selectedAgentProfile();

  return {
    id: String(metadata.agentId ?? fallback.key),
    name: String(metadata.agentName ?? fallback.name),
    via: String(metadata.via ?? fallback.liveTransport),
    integration: String(metadata.integration ?? fallback.integration),
  };
}

function stopSessionTitleAnimation(sessionId) {
  const timerId = sessionTitleAnimationTimers.get(sessionId);
  if (!timerId) {
    return;
  }
  clearInterval(timerId);
  sessionTitleAnimationTimers.delete(sessionId);
}

async function setSessionGroupPresentation(session, frameIndex = 0) {
  try {
    await chrome.tabGroups.update(session.groupId, {
      title: animatedTaskTitleForSession(session, frameIndex),
      collapsed: false,
      color: TASK_STATUS_COLOR[session.status] ?? "blue",
    });
  } catch (error) {
    await appendLog("warn", "Failed to update session tab group", {
      sessionId: session.sessionId,
      groupId: session.groupId,
      error: String(error),
    });
  }
}

function startSessionTitleAnimation(session) {
  if (sessionTitleAnimationTimers.has(session.sessionId)) {
    return;
  }

  let frameIndex = 0;
  const timerId = setInterval(() => {
    const latest = state.sessions[session.sessionId];
    if (
      !latest ||
      latest.status !== "running" ||
      !supportsTabGroups() ||
      !Number.isInteger(latest.groupId) ||
      latest.groupId < 0
    ) {
      stopSessionTitleAnimation(session.sessionId);
      return;
    }

    frameIndex = (frameIndex + 1) % SESSION_TITLE_ANIMATION_SUFFIXES.length;
    void setSessionGroupPresentation(latest, frameIndex);
  }, SESSION_TITLE_ANIMATION_INTERVAL_MS);

  sessionTitleAnimationTimers.set(session.sessionId, timerId);
}

async function updateSessionPresentation(session) {
  if (!supportsTabGroups() || !Number.isInteger(session.groupId) || session.groupId < 0) {
    stopSessionTitleAnimation(session.sessionId);
    return;
  }

  if (session.status === "running") {
    await setSessionGroupPresentation(session, 0);
    startSessionTitleAnimation(session);
    return;
  }

  stopSessionTitleAnimation(session.sessionId);
  await setSessionGroupPresentation(session, 0);
}

async function setSession(session) {
  const nextSession = buildSessionRecord(session);
  state.sessions[nextSession.sessionId] = nextSession;
  state.currentSession = nextSession;
  await updateSessionPresentation(nextSession);
  await persistState();
  await sendBridgeMessage({
    type: "extension.session_update",
    session: nextSession,
  });
  return nextSession;
}

async function updateSession(sessionId, patch) {
  const current = state.sessions[sessionId];
  if (!current) {
    return null;
  }

  return await setSession({
    ...current,
    ...patch,
    metadata: {
      ...(current.metadata ?? {}),
      ...(patch.metadata ?? {}),
    },
  });
}

async function releaseTabLock(tabId, persist = true) {
  delete state.tabLocks[String(tabId)];
  if (persist) {
    await persistState();
  }
}

async function releaseLocksForSession(sessionId) {
  let changed = false;
  for (const [tabId, lock] of Object.entries(state.tabLocks)) {
    if (lock.sessionId === sessionId) {
      delete state.tabLocks[tabId];
      changed = true;
    }
  }

  if (changed) {
    await persistState();
  }
}

async function releaseAllTabLocks() {
  state.tabLocks = {};
  await persistState();
}

async function endSession(sessionId, status, reason) {
  const session = state.sessions[sessionId];
  if (!session) {
    return;
  }

  const endedSession = await setSession({
    ...session,
    status,
    metadata: {
      ...(session.metadata ?? {}),
      endReason: reason,
      maskState: "idle",
      maskStatus: "",
    },
  });
  await broadcastSessionMaskState(endedSession, "idle", "");
  await releaseLocksForSession(sessionId);
  await releaseDebuggerSessionsForSession(sessionId);
}

function inferTabMode(tab, existingSession = null) {
  if (existingSession?.metadata?.tabMode === "grouped" || existingSession?.metadata?.tabMode === "ungrouped") {
    return existingSession.metadata.tabMode;
  }

  return typeof tab.groupId === "number" && tab.groupId >= 0 ? "grouped" : "ungrouped";
}

function buildAgentIdentity(message) {
  const fallbackProfile = connectedAgentProfile() ?? selectedAgentProfile();
  const rawAgent = message.agent ?? {};
  const agentId = rawAgent.id || fallbackProfile.key;
  const agentName = rawAgent.name || fallbackProfile.name;
  const via = rawAgent.via || fallbackProfile.liveTransport;

  return {
    id: agentId,
    name: agentName,
    via,
    integration: fallbackProfile.integration,
  };
}

function getTabLock(tabId) {
  return state.tabLocks[String(tabId)] ?? null;
}

function locksForAgent(agentId) {
  return Object.values(state.tabLocks).filter((lock) => lock.agentId === agentId);
}

async function acquireTabLock(tabId, sessionId, agent, groupId = undefined) {
  const existingLock = getTabLock(tabId);
  if (existingLock && existingLock.agentId !== agent.id) {
    throw new Error(
      `Tab ${tabId} is already controlled by ${existingLock.agentName} via ${existingLock.via}. Choose another tab.`,
    );
  }

  state.tabLocks[String(tabId)] = {
    tabId,
    sessionId,
    groupId,
    agentId: agent.id,
    agentName: agent.name,
    via: agent.via,
    integration: agent.integration,
    lockedAt: existingLock?.lockedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function syncSessionLocks(session) {
  const agent = sessionAgentIdentity(session);
  const tabs = await getSessionTabs(session);
  for (const tab of tabs) {
    if (typeof tab.id !== "number") {
      continue;
    }
    await acquireTabLock(tab.id, session.sessionId, agent, session.groupId);
  }
  await persistState();
}

async function disconnectBridge() {
  clearReconnectTimer();
  connectPromise = null;
  if (bridgeSocket) {
    bridgeSocket.__intentionalClose = true;
    bridgeSocket.close();
    bridgeSocket = null;
  }

  bridgeGeneration += 1;
  await setConnectedAgent(null);
  await setBridgeStatus("disconnected");
}

function scheduleReconnect(reason) {
  clearReconnectTimer();
  const retryInMs = nextReconnectDelay();

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBridge().catch((error) => {
      void appendLog("error", "Bridge reconnect failed", { error: String(error) });
    });
  }, retryInMs);

  void setBridgeStatus("waiting_for_bridge");
  void appendLog("warn", "Bridge unavailable, retry scheduled", {
    reason,
    bridgeUrl: state.bridgeUrl,
    retryInMs,
    selectedAgent: selectedAgentProfile().name,
  });
}

function extensionHelloPayload(selectedProfile) {
  return {
    type: "extension.hello",
    version: chrome.runtime.getManifest().version,
    capabilities: CAPABILITIES,
    connectedAgent: {
      id: selectedProfile.key,
      name: selectedProfile.name,
      via: selectedProfile.liveTransport,
      integration: selectedProfile.integration,
    },
  };
}

async function connectBridge(force = false) {
  if (connectPromise) {
    return await connectPromise;
  }

  await ensurePairingKey();
  const selectedProfile = selectedAgentProfile();

  if (bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN) {
    if (force) {
      await sendBridgeMessage(extensionHelloPayload(selectedProfile));
      await setConnectedAgent(selectedProfile.key);
      await persistState();
    }
    return;
  }

  if (bridgeSocket && bridgeSocket.readyState === WebSocket.CONNECTING) {
    return;
  }

  clearReconnectTimer();
  connectPromise = (async () => {
    const generation = ++bridgeGeneration;
    await setBridgeStatus("connecting");
    await setConnectedAgent(null);

    const socket = new WebSocket(state.bridgeUrl);
    socket.__intentionalClose = false;
    bridgeSocket = socket;

    socket.addEventListener("open", async () => {
      if (generation !== bridgeGeneration || bridgeSocket !== socket) {
        socket.__intentionalClose = true;
        socket.close();
        return;
      }

      resetReconnectDelay();
      await setConnectedAgent(selectedProfile.key);
      await setBridgeStatus("connected");
      await appendLog("info", "Connected to bridge", {
        bridgeUrl: state.bridgeUrl,
        agent: selectedProfile.name,
        liveTransport: selectedProfile.liveTransport,
        integration: selectedProfile.integration,
      });

      await sendBridgeMessage(extensionHelloPayload(selectedProfile));
    });

    socket.addEventListener("message", (event) => {
      void handleBridgeMessage(event.data);
    });

    socket.addEventListener("close", async () => {
      if (generation !== bridgeGeneration) {
        return;
      }

      if (bridgeSocket === socket) {
        bridgeSocket = null;
      }

      connectPromise = null;
      await setConnectedAgent(null);
      await setBridgeStatus("disconnected");

      if (!socket.__intentionalClose) {
        scheduleReconnect("socket closed");
      }
    });

    socket.addEventListener("error", async () => {
      if (generation !== bridgeGeneration) {
        return;
      }

      await setConnectedAgent(null);
      await setBridgeStatus("error");
    });
  })();

  try {
    await connectPromise;
  } finally {
    if (bridgeSocket?.readyState !== WebSocket.CONNECTING) {
      connectPromise = null;
    }
  }
}

async function sendBridgeMessage(message) {
  if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  bridgeSocket.send(JSON.stringify(message));
}

async function handleBridgeMessage(rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch (error) {
    await appendLog("error", "Invalid bridge payload", { rawMessage, error: String(error) });
    return;
  }

  if (message.type !== "bridge.execute") {
    await appendLog("warn", "Unsupported bridge message", message);
    return;
  }

  try {
    const artifact = await dispatchAction(message);
    await sendBridgeMessage({
      type: "extension.action_result",
      requestId: message.requestId,
      ok: true,
      artifact,
    });
  } catch (error) {
    await appendLog("error", "Action execution failed", {
      requestId: message.requestId,
      error: String(error),
    });

    await sendBridgeMessage({
      type: "extension.action_result",
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function getTabById(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab || typeof tab.id !== "number") {
    throw new Error(`Tab ${tabId} is not available.`);
  }
  return tab;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== "number") {
    throw new Error("No active tab available.");
  }
  return tab;
}

async function moveTabNearPinned(tabId, windowId) {
  try {
    const pinnedTabs = await chrome.tabs.query({ windowId, pinned: true });
    await chrome.tabs.move(tabId, { index: pinnedTabs.length });
  } catch (error) {
    await appendLog("warn", "Failed to move session tab near pinned tabs", {
      tabId,
      windowId,
      error: String(error),
    });
  }
}

async function createDedicatedSessionTab(sessionId, url, tabMode = "grouped") {
  const activeTab = await getActiveTab().catch(() => null);
  const createdTab = await chrome.tabs.create({
    url,
    active: false,
    pinned: false,
    windowId: activeTab?.windowId,
  });

  if (typeof createdTab.id !== "number") {
    throw new Error(`Failed to create session tab for ${sessionId}.`);
  }

  let tab = createdTab;
  let groupId = undefined;
  if (tabMode === "grouped" && supportsTabGroups()) {
    try {
      groupId = await chrome.tabs.group({
        tabIds: [createdTab.id],
        createProperties: { windowId: createdTab.windowId },
      });
      tab = await getTabById(createdTab.id);
    } catch (error) {
      await appendLog("warn", "Failed to group dedicated session tab", {
        sessionId,
        tabId: createdTab.id,
        tabMode,
        error: String(error),
      });
    }
  }

  await moveTabNearPinned(createdTab.id, createdTab.windowId);

  return {
    ...tab,
    groupId: Number.isInteger(groupId) ? groupId : tab.groupId,
  };
}

async function getSessionTabs(session) {
  if (
    supportsTabGroups() &&
    Number.isInteger(session.groupId) &&
    session.groupId >= 0
  ) {
    try {
      return await chrome.tabs.query({ groupId: session.groupId, windowId: session.windowId });
    } catch {
      return [];
    }
  }

  if (typeof session.tabId !== "number") {
    return [];
  }

  try {
    return [await getTabById(session.tabId)];
  } catch {
    return [];
  }
}

async function getOtherTabsInGroup(session, currentTabId) {
  const tabs = await getSessionTabs(session);
  return tabs
    .filter((tab) => typeof tab.id === "number" && tab.id !== currentTabId)
    .map((tab) => ({
      tabId: tab.id,
      url: tab.url ?? "",
      title: tab.title ?? "",
    }));
}

function getSessionByTabId(tabId) {
  const directMatch = Object.values(state.sessions).find((session) => session.tabId === tabId);
  if (directMatch) {
    return directMatch;
  }

  const lock = getTabLock(tabId);
  if (lock) {
    return state.sessions[lock.sessionId] ?? null;
  }

  return null;
}

async function chooseTargetTab(message, agent) {
  if (typeof message.targetTabId === "number") {
    return await getTabById(message.targetTabId);
  }

  const activeTab = await getActiveTab();
  const activeLock = getTabLock(activeTab.id);

  if (!activeLock || activeLock.agentId === agent.id) {
    return activeTab;
  }

  const agentLocks = locksForAgent(agent.id);
  if (agentLocks.length === 1) {
    return await getTabById(agentLocks[0].tabId);
  }

  if (agentLocks.length > 1) {
    throw new Error(
      `${agent.name} already controls multiple tabs. Specify a tabId to avoid ambiguity.`,
    );
  }

  throw new Error(
    `Active tab ${activeTab.id} is already controlled by ${activeLock.agentName}. Open or choose another tab.`,
  );
}

async function resolveSessionTab(session) {
  if (!session) {
    return null;
  }

  if (typeof session.tabId === "number") {
    try {
      return await getTabById(session.tabId);
    } catch {
      // Fall through to group recovery.
    }
  }

  const groupTabs = await getSessionTabs(session);
  const fallbackTab = groupTabs.find((candidate) => typeof candidate.id === "number") ?? null;
  if (!fallbackTab || typeof fallbackTab.id !== "number") {
    return null;
  }

  await setSession({
    ...session,
    tabId: fallbackTab.id,
    windowId: fallbackTab.windowId,
    groupId: fallbackTab.groupId,
  });
  return fallbackTab;
}

async function assignTabToSession(
  sessionId,
  tab,
  agent,
  lastAction,
  tabMode = undefined,
  requestedTaskName = undefined,
  action = undefined,
) {
  const existing = state.sessions[sessionId];
  const resolvedTabMode = tabMode ?? inferTabMode(tab, existing);
  const resolvedTaskName = resolveSessionTaskName({
    requestedTaskName,
    existingTaskName: existing?.taskName,
    sessionId,
    action,
    tab,
  });
  const nextSession = await setSession({
    sessionId,
    status: existing?.status === "takeover" ? "takeover" : "running",
    tabId: tab.id,
    windowId: tab.windowId,
    groupId:
      resolvedTabMode === "grouped" &&
      typeof tab.groupId === "number" &&
      tab.groupId >= 0
        ? tab.groupId
        : undefined,
    taskName: resolvedTaskName,
    metadata: {
      ...(existing?.metadata ?? {}),
      lastAction,
      tabMode: resolvedTabMode,
      agentId: agent.id,
      agentName: agent.name,
      via: agent.via,
      integration: agent.integration,
    },
  });

  await acquireTabLock(tab.id, sessionId, agent, nextSession.groupId);
  await syncSessionLocks(nextSession);
  return nextSession;
}

async function ensureSessionContext(message, agent) {
  const sessionId = message.sessionId || state.currentSession?.sessionId || crypto.randomUUID();
  let session = state.sessions[sessionId] ?? null;

  if (typeof message.targetTabId === "number") {
    const targetTab = await getTabById(message.targetTabId);
    session = await assignTabToSession(
      sessionId,
      targetTab,
      agent,
      message.action.type,
      undefined,
      message.taskName,
      message.action,
    );
    return { session, tab: targetTab };
  }

  const existingTab = await resolveSessionTab(session);
  if (existingTab) {
    session = await assignTabToSession(
      sessionId,
      existingTab,
      agent,
      message.action.type,
      undefined,
      message.taskName,
      message.action,
    );
    return { session, tab: existingTab };
  }

  if (message.action.type === "browser_navigate") {
    const requestedTabMode = message.action.tabMode === "ungrouped" ? "ungrouped" : "grouped";
    const dedicatedTab = await createDedicatedSessionTab(
      sessionId,
      message.action.url,
      requestedTabMode,
    );
    session = await assignTabToSession(
      sessionId,
      dedicatedTab,
      agent,
      message.action.type,
      requestedTabMode,
      message.taskName,
      message.action,
    );
    return { session, tab: dedicatedTab };
  }

  const chosenTab = await chooseTargetTab(message, agent);
  session = await assignTabToSession(
    sessionId,
    chosenTab,
    agent,
    message.action.type,
    undefined,
    message.taskName,
    message.action,
  );
  return { session, tab: chosenTab };
}

async function waitForTabComplete(tabId, timeoutMs = 20000) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") {
    return;
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for tab to finish loading."));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendToContentOnce(tabId, payload) {
  return await chrome.tabs.sendMessage(tabId, payload);
}

async function sendToContent(tabId, payload) {
  let lastError = null;
  for (let attempt = 0; attempt < CONTENT_RETRY_LIMIT; attempt += 1) {
    try {
      const response = await sendToContentOnce(tabId, payload);
      if (response && response.ok === false) {
        const error = new Error(response.error || "Content action failed.");
        error.fatalContentAction = true;
        throw error;
      }
      return response;
    } catch (error) {
      if (error?.fatalContentAction) {
        throw error;
      }
      lastError = error;
      await delay(CONTENT_RETRY_DELAY_MS);
    }
  }

  await appendLog("warn", "Content script message failed", {
    tabId,
    payload,
    error: String(lastError),
  });
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function setContentMaskState(tabId, maskState, status) {
  try {
    await sendToContent(tabId, {
      type: "operator:set-mask-state",
      state: maskState,
      status,
    });
  } catch (error) {
    await appendLog("debug", "Failed to push mask state to content", {
      tabId,
      maskState,
      error: String(error),
    });
  }
}

async function broadcastSessionMaskState(session, maskState, status) {
  const tabs = await getSessionTabs(session);
  await Promise.allSettled(
    tabs
      .filter((tab) => typeof tab.id === "number")
      .map((tab) => setContentMaskState(tab.id, maskState, status)),
  );
}

async function updateSessionMask(session, patch, maskState, maskStatus) {
  const updatedSession = await setSession({
    ...session,
    ...patch,
    metadata: {
      ...(session.metadata ?? {}),
      ...(patch.metadata ?? {}),
      maskState,
      maskStatus,
    },
  });
  await broadcastSessionMaskState(updatedSession, maskState, maskStatus);
  return updatedSession;
}

async function enrichArtifact(artifact, session, tabId, agent) {
  const newPages = await getOtherTabsInGroup(session, tabId);
  const screenshots = await captureArtifactScreenshots(tabId, artifact, session.sessionId).catch(
    async (error) => {
      await appendLog("debug", "Failed to capture screenshot artifact", {
        sessionId: session.sessionId,
        tabId,
        error: String(error),
      });
      return {};
    },
  );

  return {
    ...(artifact ?? {}),
    ...screenshots,
    sessionId: session.sessionId,
    tabId,
    groupId: session.groupId,
    controlledBy: {
      agentId: agent.id,
      agentName: agent.name,
      via: agent.via,
      integration: agent.integration,
    },
    newPages,
  };
}

async function dispatchAction(message) {
  const action = message.action;
  const agent = buildAgentIdentity(message);
  const { session, tab } = await ensureSessionContext(message, agent);
  const tabId = tab.id;
  const nextMaskState =
    session.metadata?.maskState === "hidden" || tab.active === false ? "hidden" : "ongoing";
  const maskStatus = `${agent.name} started ${taskNameForSession(session)}`;

  await updateSessionMask(
    session,
    {
      status: "running",
      metadata: {
        ...(session.metadata ?? {}),
        lastAction: action.type,
      },
    },
    nextMaskState,
    maskStatus,
  );

  let artifact;
  switch (action.type) {
    case "browser_navigate": {
      await chrome.tabs.update(tabId, { url: action.url, active: false });
      await waitForTabComplete(tabId);
      artifact = await sendToContent(tabId, { type: "operator:view" });
      break;
    }
    case "browser_view":
      artifact = await sendToContent(tabId, { type: "operator:view" });
      break;
    case "browser_click":
      artifact = await sendToContent(tabId, { type: "operator:click", action });
      break;
    case "browser_input":
      artifact = await sendToContent(tabId, { type: "operator:input", action });
      break;
    case "browser_press_key":
      artifact = await sendToContent(tabId, { type: "operator:press-key", action });
      break;
    case "browser_scroll":
      artifact = await sendToContent(tabId, { type: "operator:scroll", action });
      break;
    case "browser_move_mouse":
      artifact = await sendToContent(tabId, { type: "operator:move-mouse", action });
      break;
    case "browser_find_keyword":
      artifact = await sendToContent(tabId, { type: "operator:find-keyword", action });
      break;
    default:
      throw new Error(`Unsupported action type: ${action.type}`);
  }

  return await enrichArtifact(artifact, session, tabId, agent);
}

async function handleGroupedChildTab(tab) {
  if (typeof tab.id !== "number" || typeof tab.openerTabId !== "number") {
    return;
  }

  const openerLock = getTabLock(tab.openerTabId);
  if (!openerLock) {
    return;
  }

  const session = state.sessions[openerLock.sessionId];
  if (!session) {
    return;
  }

  const agent = sessionAgentIdentity(session);
  if (
    supportsTabGroups() &&
    Number.isInteger(session.groupId) &&
    session.groupId >= 0
  ) {
    try {
      await chrome.tabs.group({
        groupId: session.groupId,
        tabIds: [tab.id],
      });
    } catch (error) {
      await appendLog("warn", "Failed to group child tab into session", {
        sessionId: session.sessionId,
        openerTabId: tab.openerTabId,
        tabId: tab.id,
        groupId: session.groupId,
        error: String(error),
      });
    }
  }

  await acquireTabLock(tab.id, session.sessionId, agent, session.groupId);
  await persistState();
}

async function handleRemovedTab(tabId) {
  await releaseDebuggerSession(tabId, undefined, true);
  await releaseTabLock(tabId, false);
  let changed = false;

  for (const session of Object.values(state.sessions)) {
    if (session.tabId !== tabId) {
      continue;
    }

    const replacement = await resolveSessionTab(session);
    if (!replacement) {
      stopSessionTitleAnimation(session.sessionId);
      await releaseDebuggerSessionsForSession(session.sessionId);
      delete state.sessions[session.sessionId];
      if (state.currentSession?.sessionId === session.sessionId) {
        state.currentSession = null;
      }
      await releaseLocksForSession(session.sessionId);
      changed = true;
      continue;
    }

    state.sessions[session.sessionId] = buildSessionRecord({
      ...session,
      tabId: replacement.id,
      windowId: replacement.windowId,
      groupId: replacement.groupId,
    });
    if (state.currentSession?.sessionId === session.sessionId) {
      state.currentSession = state.sessions[session.sessionId];
    }
    changed = true;
  }

  if (changed) {
    await persistState();
  } else {
    await persistState();
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  void handleGroupedChildTab(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleRemovedTab(tabId);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (typeof source.tabId !== "number") {
    return;
  }

  debuggerSessions.delete(source.tabId);
  const session = getSessionByTabId(source.tabId);
  if (!session) {
    return;
  }

  void updateSession(session.sessionId, {
    metadata: {
      debuggerState: "detached",
      debuggerDetachReason: reason || "unknown",
    },
  });
});

chrome.runtime.onSuspend.addListener(() => {
  for (const tabId of debuggerSessions.keys()) {
    try {
      chrome.debugger.detach(debuggerTargetForTab(tabId));
    } catch {
      // Best-effort cleanup during service worker suspension.
    }
  }
  debuggerSessions.clear();
});

if (supportsTabGroups()) {
  chrome.tabGroups.onRemoved.addListener((group) => {
    void (async () => {
      for (const session of Object.values(state.sessions)) {
        if (session.groupId !== group.id) {
          continue;
        }
        await endSession(session.sessionId, "stopped", "tab_group_removed");
      }
    })();
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensurePairingKey();
  await appendLog("info", "Extension installed", {
    selectedAgent: selectedAgentProfile().name,
    mode: "auto connect",
    tabGroups: supportsTabGroups(),
    pairingKey: state.pairingKey,
  });
  await persistState();
  await connectBridge(true);

  if (details.reason === "install") {
    await chrome.tabs.create({ url: buildLandingUrl(state.pairingKey) });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensurePairingKey();
  await appendLog("info", "Extension ready", {
    selectedAgent: selectedAgentProfile().name,
    mode: "auto connect",
    tabGroups: supportsTabGroups(),
    pairingKey: state.pairingKey,
  });
  await persistState();
  await connectBridge(true);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const senderTabId = sender.tab?.id;

    switch (message.type) {
      case "ui/get-state":
        return serializableState();
      case "ui/select-agent":
        await selectAgent(message.agentKey);
        await appendLog("info", "Selected agent profile", {
          selectedAgent: selectedAgentProfile().name,
          integration: selectedAgentProfile().integration,
        });
        await connectBridge(true);
        return { ok: true, state: serializableState() };
      case "ui/set-connection-config": {
        const result = await setConnectionConfig({
          bridgeUrl: message.bridgeUrl,
          mcpUrl: message.mcpUrl,
        });
        await appendLog("info", "Connection settings updated", {
          bridgeUrl: state.bridgeUrl,
          mcpUrl: state.mcpUrl,
          bridgeChanged: result.bridgeChanged,
          mcpChanged: result.mcpChanged,
        });
        if (result.bridgeChanged) {
          await disconnectBridge();
          await connectBridge(true);
        }
        return { ok: true, state: serializableState() };
      }
      case "ui/connect-bridge":
        await appendLog("info", "Bridge reconnect requested", {
          selectedAgent: selectedAgentProfile().name,
        });
        await connectBridge(true);
        return { ok: true, state: serializableState() };
      case "ui/disconnect-bridge":
        await appendLog("info", "Manual bridge disconnect requested", {
          selectedAgent: selectedAgentProfile().name,
        });
        await disconnectBridge();
        return { ok: true, state: serializableState() };
      case "ui/reset-locks":
        await appendLog("warn", "All tab locks released by user");
        await releaseAllTabLocks();
        return { ok: true, state: serializableState() };
      case "ui/open-side-panel": {
        const tab = await getActiveTab();
        await chrome.sidePanel.open({ windowId: tab.windowId });
        return { ok: true };
      }
      case "ui/inspect-page": {
        const tab = await getActiveTab();
        const artifact = await sendToContent(tab.id, { type: "operator:view" });
        return { ok: true, artifact };
      }
      case "content/get-session-state": {
        if (typeof senderTabId !== "number") {
          return { ok: false, error: "No sender tab." };
        }
        const session = getSessionByTabId(senderTabId);
        return {
          ok: true,
          state: sessionMaskState(session),
          status: sessionMaskStatus(session),
          session,
        };
      }
      case "extension/stop-task": {
        if (typeof senderTabId !== "number") {
          return { ok: false, error: "No sender tab." };
        }
        const session = getSessionByTabId(senderTabId);
        if (!session) {
          return { ok: false, error: "Session not found." };
        }
        const updatedSession = await updateSessionMask(
          session,
          { status: "takeover" },
          "takeover",
          "User taking over control",
        );
        await appendLog("info", "Session moved to takeover", {
          sessionId: session.sessionId,
          tabId: senderTabId,
        });
        return {
          ok: true,
          state: sessionMaskState(updatedSession),
          status: sessionMaskStatus(updatedSession),
          session: updatedSession,
        };
      }
      case "extension/resume-task": {
        if (typeof senderTabId !== "number") {
          return { ok: false, error: "No sender tab." };
        }
        const session = getSessionByTabId(senderTabId);
        if (!session) {
          return { ok: false, error: "Session not found." };
        }
        const resumeStatus = `${sessionAgentIdentity(session).name} resumed ${taskNameForSession(session)}`;
        const updatedSession = await updateSessionMask(
          session,
          {
            status: "running",
            metadata: {
              resumeSummary: message.summary ?? "",
            },
          },
          "ongoing",
          resumeStatus,
        );
        await appendLog("info", "Session resumed after takeover", {
          sessionId: session.sessionId,
          tabId: senderTabId,
          hasSummary: Boolean(message.summary),
        });
        return {
          ok: true,
          state: sessionMaskState(updatedSession),
          status: sessionMaskStatus(updatedSession),
          session: updatedSession,
        };
      }
      case "extension/unauthorize-task": {
        if (typeof senderTabId !== "number") {
          return { ok: false, error: "No sender tab." };
        }
        const session = getSessionByTabId(senderTabId);
        if (!session) {
          return { ok: false, error: "Session not found." };
        }
        await endSession(session.sessionId, "stopped", "user_stopped");
        await appendLog("info", "Session stopped by user", {
          sessionId: session.sessionId,
          tabId: senderTabId,
        });
        return { ok: true, state: "idle", status: "", session: null };
      }
      case "extension/hide-task-controls": {
        if (typeof senderTabId !== "number") {
          return { ok: false, error: "No sender tab." };
        }
        const session = getSessionByTabId(senderTabId);
        if (!session) {
          return { ok: false, error: "Session not found." };
        }
        const updatedSession = await updateSessionMask(
          session,
          { metadata: {} },
          "hidden",
          sessionMaskStatus(session),
        );
        return {
          ok: true,
          state: sessionMaskState(updatedSession),
          status: sessionMaskStatus(updatedSession),
          session: updatedSession,
        };
      }
      case "extension/show-task-controls": {
        if (typeof senderTabId !== "number") {
          return { ok: false, error: "No sender tab." };
        }
        const session = getSessionByTabId(senderTabId);
        if (!session) {
          return { ok: false, error: "Session not found." };
        }
        const nextMaskState = session.status === "takeover" ? "takeover" : "ongoing";
        const updatedSession = await updateSessionMask(
          session,
          { metadata: {} },
          nextMaskState,
          sessionMaskStatus(session),
        );
        return {
          ok: true,
          state: sessionMaskState(updatedSession),
          status: sessionMaskStatus(updatedSession),
          session: updatedSession,
        };
      }
      default:
        return { ok: false, error: "Unknown UI message." };
    }
  })()
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});

void (async () => {
  await hydrateState();
  await persistState();
  await connectBridge();
})();
