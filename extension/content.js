const CID_ATTR = "data-cbrowse-cid";
const HOST_ID = "cbrowse-host";
const DEFAULT_STATUS_TEXT = "cBrowse ready";
const MAX_INTERACTIVE_ELEMENTS = 250;
const MAX_KEYWORD_MATCHES = 10;
const INTERACTIVE_SELECTOR = [
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='tab']",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");
const BLOCKED_EVENTS = [
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "contextmenu",
  "pointerdown",
  "pointermove",
  "pointerup",
  "dragstart",
  "drag",
  "dragend",
  "drop",
  "keydown",
  "keyup",
  "keypress",
  "wheel",
];

let currentMaskState = "idle";
let currentStatusText = DEFAULT_STATUS_TEXT;
let currentTaskLabel = "cBrowse task";
let ui = null;
let restoreRequested = false;
let restoreAttempts = 0;
let hiddenReturnState = "ongoing";
let operatorInteractionDepth = 0;
let lastHoveredElement = null;

const MAX_RESTORE_ATTEMPTS = 12;
const RESTORE_RETRY_DELAY_MS = 500;

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForAnimationFrames(count = 2) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
}

function withOperatorInteraction(callback) {
  operatorInteractionDepth += 1;
  try {
    return callback();
  } finally {
    operatorInteractionDepth = Math.max(operatorInteractionDepth - 1, 0);
  }
}

function maskBlocksUserInteraction() {
  return (
    currentMaskState === "ongoing" ||
    (currentMaskState === "hidden" && hiddenReturnState === "ongoing")
  );
}

function waitForDocumentReady(timeoutMs = 5000) {
  if (document.documentElement && document.body) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for document body."));
    }, timeoutMs);

    const done = () => {
      if (!document.documentElement || !document.body) {
        return;
      }
      cleanup();
      resolve();
    };

    const cleanup = () => {
      clearTimeout(timeout);
      document.removeEventListener("DOMContentLoaded", done);
      document.removeEventListener("readystatechange", done);
    };

    document.addEventListener("DOMContentLoaded", done);
    document.addEventListener("readystatechange", done);
    done();
  });
}

function normalizeText(value, limit = 160) {
  if (!value) {
    return "";
  }

  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function mainTextSource() {
  const selectors = ["main", "article", "[role='main']", "#main", ".main", "#content", ".content"];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element instanceof HTMLElement) {
      const text = normalizeText(element.innerText || element.textContent || "", 12000);
      if (text.length > 120) {
        return text;
      }
    }
  }

  return normalizeText(document.body?.innerText || "", 12000);
}

function isElementVisible(element) {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) {
    return false;
  }

  if (rect.bottom < 0 || rect.right < 0) {
    return false;
  }

  if (rect.top > window.innerHeight || rect.left > window.innerWidth) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === "none") {
    return false;
  }

  if (style.visibility === "hidden" || style.visibility === "collapse") {
    return false;
  }

  const opacity = Number.parseFloat(style.opacity || "1");
  if (!Number.isNaN(opacity) && opacity <= 0) {
    return false;
  }

  if (style.pointerEvents === "none") {
    return false;
  }

  return true;
}

function closestInteractiveElement(element) {
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  if (element instanceof HTMLLabelElement && element.control instanceof HTMLElement) {
    return element.control;
  }

  if (element.matches(INTERACTIVE_SELECTOR)) {
    return element;
  }

  const closest = element.closest(INTERACTIVE_SELECTOR);
  if (closest instanceof HTMLLabelElement && closest.control instanceof HTMLElement) {
    return closest.control;
  }

  return closest;
}

function isOperatorUiElement(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.id === HOST_ID || element.closest(`#${HOST_ID}`)) {
    return true;
  }

  const root = element.getRootNode?.();
  return Boolean(root instanceof ShadowRoot && root.host instanceof HTMLElement && root.host.id === HOST_ID);
}

function nextStableTargetIndex() {
  let maxIndex = -1;
  for (const element of document.querySelectorAll(`[${CID_ATTR}]`)) {
    const rawValue = Number.parseInt(element.getAttribute(CID_ATTR) || "", 10);
    if (Number.isInteger(rawValue)) {
      maxIndex = Math.max(maxIndex, rawValue);
    }
  }
  return maxIndex + 1;
}

function pointHitsElement(element, x, y) {
  const elementsAtPoint = document.elementsFromPoint(x, y).filter((candidate) => !isOperatorUiElement(candidate));
  return elementsAtPoint.some((candidate) => candidate === element || element.contains(candidate));
}

function targetVisibilityState(element, rect) {
  const controlState = elementControlState(element);
  if (controlState.disabled) {
    return {
      disabled: true,
      checked: controlState.checked,
      selected: controlState.selected,
      interactable: false,
      occluded: false,
      visibilityReason: "disabled",
    };
  }

  if (!rect) {
    return {
      disabled: controlState.disabled,
      checked: controlState.checked,
      selected: controlState.selected,
      interactable: false,
      occluded: false,
      visibilityReason: "offscreen",
    };
  }

  const centerX = Math.round(rect.x + rect.width / 2);
  const centerY = Math.round(rect.y + rect.height / 2);
  const occluded = !pointHitsElement(element, centerX, centerY);
  return {
    disabled: controlState.disabled,
    checked: controlState.checked,
    selected: controlState.selected,
    interactable: !occluded,
    occluded,
    visibilityReason: occluded ? "occluded" : "visible",
  };
}

function selectorHintForElement(element) {
  if (!(element instanceof HTMLElement)) {
    return "";
  }

  const id = normalizeText(element.id || "", 64);
  if (id) {
    return `#${id}`;
  }

  const name = normalizeText(element.getAttribute("name") || "", 48);
  if (name) {
    return `${element.tagName.toLowerCase()}[name="${name}"]`;
  }

  const testId = normalizeText(
    element.getAttribute("data-testid") ||
      element.getAttribute("data-test") ||
      element.getAttribute("data-qa") ||
      "",
    64,
  );
  if (testId) {
    return `${element.tagName.toLowerCase()}[data-testid="${testId}"]`;
  }

  const ariaLabel = normalizeText(element.getAttribute("aria-label") || "", 64);
  if (ariaLabel) {
    return `${element.tagName.toLowerCase()}[aria-label="${ariaLabel}"]`;
  }

  const role = normalizeText(element.getAttribute("role") || "", 32);
  if (role) {
    return `${element.tagName.toLowerCase()}[role="${role}"]`;
  }

  return element.tagName.toLowerCase();
}

function elementControlState(element) {
  const disabled =
    element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
      ? Boolean(element.disabled)
      : element.getAttribute("aria-disabled") === "true";

  const checked =
    element instanceof HTMLInputElement &&
    ["checkbox", "radio"].includes((element.type || "").toLowerCase())
      ? Boolean(element.checked)
      : element.getAttribute("aria-checked") === "true";

  const selected =
    element instanceof HTMLOptionElement
      ? Boolean(element.selected)
      : element.getAttribute("aria-selected") === "true";

  return { disabled, checked, selected };
}

function interactiveElements() {
  const elements = [];
  const seen = new Set();
  let nextIndex = nextStableTargetIndex();
  for (const candidate of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
    if (!(candidate instanceof HTMLElement)) {
      continue;
    }

    const interactiveCandidate = closestInteractiveElement(candidate);
    if (!(interactiveCandidate instanceof HTMLElement) || isOperatorUiElement(interactiveCandidate)) {
      continue;
    }

    if (seen.has(interactiveCandidate)) {
      continue;
    }

    if (!isElementVisible(interactiveCandidate)) {
      continue;
    }

    if (!interactiveCandidate.hasAttribute(CID_ATTR)) {
      interactiveCandidate.setAttribute(CID_ATTR, String(nextIndex));
      nextIndex += 1;
    }

    const rect = clipRectToViewport(interactiveCandidate.getBoundingClientRect());
    const visibilityState = targetVisibilityState(interactiveCandidate, rect);
    if (!visibilityState.interactable && visibilityState.visibilityReason === "occluded") {
      continue;
    }

    elements.push(interactiveCandidate);
    seen.add(interactiveCandidate);

    if (elements.length >= MAX_INTERACTIVE_ELEMENTS) {
      break;
    }
  }

  return elements;
}

function clipRectToViewport(rect) {
  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  const right = Math.min(rect.right, window.innerWidth);
  const bottom = Math.min(rect.bottom, window.innerHeight);
  const width = right - left;
  const height = bottom - top;

  if (width <= 1 || height <= 1) {
    return null;
  }

  return {
    x: left,
    y: top,
    width,
    height,
  };
}

function labelTextForElement(element) {
  const labelledBy = (element.getAttribute("aria-labelledby") || "")
    .split(/\s+/)
    .map((id) => document.getElementById(id))
    .filter((candidate) => candidate instanceof HTMLElement)
    .map((candidate) => normalizeText(candidate.innerText || candidate.textContent || "", 120))
    .filter(Boolean)
    .join(" ");
  if (labelledBy) {
    return labelledBy;
  }

  const ariaLabel = normalizeText(element.getAttribute("aria-label") || element.title || "", 120);
  if (ariaLabel) {
    return ariaLabel;
  }

  if ("labels" in element) {
    const labels = Array.from(element.labels || [])
      .map((label) => normalizeText(label.innerText || label.textContent || "", 120))
      .filter(Boolean)
      .join(" ");
    if (labels) {
      return labels;
    }
  }

  return normalizeText(
    element.getAttribute("placeholder") || element.getAttribute("name") || "",
    120,
  );
}

function targetTextForElement(element) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return normalizeText(element.value || element.placeholder || "", 120);
  }

  if (element instanceof HTMLSelectElement) {
    return Array.from(element.options)
      .slice(0, 5)
      .map((option, optionIndex) => `option#${optionIndex}:${normalizeText(option.textContent || "", 40)}`)
      .join(", ");
  }

  return normalizeText(element.innerText || element.textContent || "", 120);
}

function describeElement(element, index) {
  const tagName = element.tagName.toLowerCase();
  const inputType =
    element instanceof HTMLInputElement ? (element.getAttribute("type") || "text").toLowerCase() : undefined;
  const selectorHint = selectorHintForElement(element);
  const controlState = elementControlState(element);
  const label = labelTextForElement(element);
  const role = normalizeText(element.getAttribute("role") || "", 32) || undefined;
  const href = element instanceof HTMLAnchorElement ? element.href : undefined;
  const parts = [];

  if (element.id) {
    parts.push(`id:"${normalizeText(element.id, 48)}"`);
  }

  if (label) {
    parts.push(`label:"${label}"`);
  }

  const placeholder = normalizeText(element.getAttribute("placeholder") || "", 80);
  if (placeholder) {
    parts.push(`placeholder:"${placeholder}"`);
  }

  if (role) {
    parts.push(`role:"${role}"`);
  }

  if (inputType) {
    parts.push(`type:"${inputType}"`);
  }

  const text = targetTextForElement(element);

  const hintText = parts.length > 0 ? `{${parts.join(",")}}` : "{}";
  const description = text ? `${tagName} ${hintText} ${text}` : `${tagName} ${hintText}`;
  const rect = clipRectToViewport(element.getBoundingClientRect());
  const centerX = rect ? Math.round(rect.x + rect.width / 2) : undefined;
  const centerY = rect ? Math.round(rect.y + rect.height / 2) : undefined;
  const visibilityState = targetVisibilityState(element, rect);

  return {
    index,
    description,
    targetKey: element.getAttribute(CID_ATTR) || selectorHint,
    rect,
    tagName,
    role,
    label,
    text,
    inputType,
    selectorHint,
    href,
    centerX,
    centerY,
    disabled: visibilityState.disabled ?? controlState.disabled,
    checked: visibilityState.checked ?? controlState.checked,
    selected: visibilityState.selected ?? controlState.selected,
    interactable: visibilityState.interactable,
    visibilityReason: visibilityState.visibilityReason,
    occluded: visibilityState.occluded,
  };
}

function buildMarkdown(elements, pageText) {
  const title = normalizeText(document.title || "Untitled page", 200);
  return [
    `# ${title}`,
    "",
    `URL: ${location.href}`,
    "",
    "## Interactive elements",
    ...elements.map((element) => `- ${element.index}: ${element.description}`),
    "",
    "## Visible page text",
    pageText || "(no visible text found)",
  ].join("\n");
}

function collectPageState(result = "ok", overrides = {}) {
  const elements = interactiveElements()
    .map((element) => {
      const stableIndex = Number.parseInt(element.getAttribute(CID_ATTR) || "", 10);
      return describeElement(element, Number.isInteger(stableIndex) ? stableIndex : -1);
    })
    .filter((element) => element.index >= 0)
    .sort((left, right) => left.index - right.index);
  const elementRects = elements
    .filter((element) => element.rect)
    .map((element) => ({
      index: element.index,
      targetKey: element.targetKey,
      tagName: element.tagName,
      inputType: element.inputType,
      selectorHint: element.selectorHint,
      centerX: element.centerX,
      centerY: element.centerY,
      disabled: element.disabled,
      checked: element.checked,
      interactable: element.interactable,
      occluded: element.occluded,
      x: element.rect.x,
      y: element.rect.y,
      width: element.rect.width,
      height: element.rect.height,
    }));
  const pageText = mainTextSource();

  return {
    url: location.href,
    title: document.title,
    result,
    elements: elements.map(
      ({
        index,
        description,
        targetKey,
        tagName,
        role,
        label,
        text,
        selectorHint,
        href,
        centerX,
        centerY,
        disabled,
        checked,
        selected,
        interactable,
        visibilityReason,
      }) => ({
      index,
      description,
      targetKey,
      tagName,
      role,
      label,
      text,
      selectorHint,
      href,
      centerX,
      centerY,
      disabled,
      checked,
      selected,
      interactable,
      visibilityReason,
    }),
    ),
    elementRects,
    primaryTarget: overrides.primaryTarget,
    highlightCount: elementRects.length,
    markdown: buildMarkdown(elements, pageText),
    fullMarkdown: buildMarkdown(elements, normalizeText(document.body?.innerText || "", 24000)),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    pixelsAbove: window.scrollY,
    pixelsBelow: Math.max(
      document.documentElement.scrollHeight - window.scrollY - window.innerHeight,
      0,
    ),
    ...overrides,
  };
}

function describeActionTarget(element) {
  const stableIndex = Number.parseInt(element.getAttribute(CID_ATTR) || "", 10);
  return describeElement(element, Number.isInteger(stableIndex) ? stableIndex : -1);
}

function scaledCoordinate(value, fromSize, toSize) {
  if (
    typeof value !== "number" ||
    typeof fromSize !== "number" ||
    fromSize <= 0 ||
    typeof toSize !== "number" ||
    toSize <= 0
  ) {
    return value;
  }

  if (Math.abs(fromSize - toSize) < 1) {
    return value;
  }

  return (value / fromSize) * toSize;
}

function denormalizeCoordinates(x, y, viewportWidth, viewportHeight) {
  return {
    x: Math.round(scaledCoordinate(x, viewportWidth, window.innerWidth)),
    y: Math.round(scaledCoordinate(y, viewportHeight, window.innerHeight)),
  };
}

function actionableTargetFromElement(element) {
  let candidate = element instanceof HTMLElement ? element : null;
  while (candidate instanceof HTMLElement) {
    if (isOperatorUiElement(candidate)) {
      return null;
    }

    if (candidate instanceof HTMLLabelElement && candidate.control instanceof HTMLElement) {
      candidate = candidate.control;
      continue;
    }

    if (candidate.matches(INTERACTIVE_SELECTOR)) {
      return candidate;
    }

    if (candidate.parentElement instanceof HTMLElement) {
      candidate = candidate.parentElement;
      continue;
    }

    const root = candidate.getRootNode();
    if (root instanceof ShadowRoot && root.host instanceof HTMLElement && root.host !== candidate) {
      candidate = root.host;
      continue;
    }

    break;
  }

  return null;
}

function interactionPointForElement(element) {
  const rect = element.getBoundingClientRect();
  const clientX = Math.round(rect.left + Math.min(Math.max(rect.width / 2, 1), Math.max(rect.width - 1, 1)));
  const clientY = Math.round(rect.top + Math.min(Math.max(rect.height / 2, 1), Math.max(rect.height - 1, 1)));
  return { clientX, clientY };
}

async function scrollElementIntoView(element) {
  element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
  await waitForAnimationFrames(2);
}

function focusElement(element) {
  if (typeof element.focus === "function") {
    element.focus({ preventScroll: true });
  }
}

function setNativeTextValue(element, text) {
  if (element instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) {
      setter.call(element, text);
      return;
    }
  }

  if (element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) {
      setter.call(element, text);
      return;
    }
  }

  element.value = text;
}

function dispatchPointerLikeEvent(element, type, init) {
  if (typeof PointerEvent === "function") {
    element.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        ...init,
      }),
    );
    return;
  }

  element.dispatchEvent(
    new MouseEvent(type.replace(/^pointer/, "mouse"), {
      bubbles: true,
      cancelable: true,
      composed: true,
      ...init,
    }),
  );
}

function targetFromAction(target) {
  if (target.strategy === "bySelector") {
    const element = document.querySelector(target.selector);
    const actionableTarget = actionableTargetFromElement(element);
    if (!(actionableTarget instanceof HTMLElement)) {
      throw new Error(`Selector not found: ${target.selector}`);
    }
    return actionableTarget;
  }

  if (target.strategy === "byIndex") {
    let element = document.querySelector(`[${CID_ATTR}="${target.index}"]`);
    if (!(element instanceof HTMLElement)) {
      interactiveElements();
      element = document.querySelector(`[${CID_ATTR}="${target.index}"]`);
    }

    const actionableTarget = actionableTargetFromElement(element);
    if (!(actionableTarget instanceof HTMLElement)) {
      throw new Error(`Element index not found: ${target.index}`);
    }
    return actionableTarget;
  }

  if (target.strategy === "byCoordinates") {
    const { x, y } = denormalizeCoordinates(
      target.coordinateX,
      target.coordinateY,
      target.viewportWidth,
      target.viewportHeight,
    );
    const element = document.elementFromPoint(x, y);
    const actionableTarget = actionableTargetFromElement(element);
    if (!(actionableTarget instanceof HTMLElement)) {
      throw new Error(`No element found at coordinates ${x},${y}`);
    }
    return actionableTarget;
  }

  throw new Error("Unsupported target strategy.");
}

function ensureUiMounted() {
  if (ui) {
    return ui;
  }

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.zIndex = "2147483646";
  host.style.pointerEvents = "none";

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #f9fafb;
    }
    .root {
      position: fixed;
      inset: 0;
      pointer-events: none;
    }
    .glow {
      position: absolute;
      inset: 0;
      opacity: 0;
      transition: opacity 180ms ease;
      background:
        radial-gradient(circle at top center, rgba(96, 165, 250, 0.34), transparent 26%) top/100% 140px no-repeat,
        radial-gradient(circle at bottom center, rgba(59, 130, 246, 0.22), transparent 24%) bottom/100% 120px no-repeat,
        linear-gradient(180deg, rgba(96, 165, 250, 0.34), transparent 14%) top/100% 24px no-repeat,
        linear-gradient(0deg, rgba(59, 130, 246, 0.22), transparent 14%) bottom/100% 24px no-repeat,
        linear-gradient(90deg, rgba(96, 165, 250, 0.24), transparent 16%) left/24px 100% no-repeat,
        linear-gradient(270deg, rgba(96, 165, 250, 0.24), transparent 16%) right/24px 100% no-repeat;
      box-shadow:
        inset 0 0 0 1px rgba(96, 165, 250, 0.2),
        inset 0 0 44px rgba(37, 99, 235, 0.08);
    }
    .glow.visible {
      opacity: 1;
    }
    .bar {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      width: min(860px, calc(100vw - 24px));
      padding: 12px 14px;
      border-radius: 18px;
      border: 1px solid rgba(96, 165, 250, 0.26);
      background:
        linear-gradient(135deg, rgba(37, 99, 235, 0.16), rgba(15, 23, 42, 0.94) 42%, rgba(15, 23, 42, 0.98)) padding-box,
        linear-gradient(135deg, rgba(147, 197, 253, 0.52), rgba(59, 130, 246, 0.18), rgba(30, 64, 175, 0.42)) border-box;
      box-shadow:
        0 18px 44px rgba(2, 6, 23, 0.42),
        inset 0 1px 0 rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(18px);
      pointer-events: auto;
    }
    .bar.visible {
      display: flex;
    }
    .bar-left {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .eyebrow {
      width: fit-content;
      max-width: 100%;
      padding: 6px 10px;
      border-radius: 999px;
      background: linear-gradient(135deg, rgba(59, 130, 246, 0.28), rgba(37, 99, 235, 0.12));
      border: 1px solid rgba(147, 197, 253, 0.18);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: #eff6ff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .status {
      font-size: 14px;
      line-height: 1.4;
      color: rgba(241, 245, 249, 0.96);
      max-width: 60ch;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    button {
      appearance: none;
      border: 0;
      border-radius: 999px;
      padding: 9px 12px;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
      transition: transform 120ms ease, opacity 120ms ease, background 120ms ease;
    }
    button:hover {
      transform: translateY(-1px);
    }
    button.primary {
      background: rgba(248, 250, 252, 0.96);
      color: #0f172a;
    }
    button.secondary {
      background: rgba(148, 163, 184, 0.12);
      color: #f8fafc;
      border: 1px solid rgba(148, 163, 184, 0.18);
    }
    .modal {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(2, 6, 23, 0.58);
      pointer-events: auto;
    }
    .modal.visible {
      display: flex;
    }
    .modal-card {
      width: min(520px, calc(100vw - 32px));
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 18px;
      border-radius: 18px;
      border: 1px solid rgba(148, 163, 184, 0.25);
      background: rgba(15, 23, 42, 0.96);
      box-shadow: 0 24px 64px rgba(15, 23, 42, 0.45);
    }
    .modal-title {
      font-size: 17px;
      font-weight: 600;
      color: #f8fafc;
    }
    .modal-copy {
      font-size: 13px;
      line-height: 1.5;
      color: rgba(226, 232, 240, 0.88);
    }
    textarea {
      width: 100%;
      min-height: 140px;
      box-sizing: border-box;
      resize: vertical;
      padding: 12px;
      border-radius: 14px;
      border: 1px solid rgba(148, 163, 184, 0.25);
      background: rgba(30, 41, 59, 0.9);
      color: #f8fafc;
      font: inherit;
      font-size: 13px;
      line-height: 1.5;
    }
    textarea:focus {
      outline: none;
      border-color: rgba(96, 165, 250, 0.72);
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.18);
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }
    .highlights {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .highlight {
      position: fixed;
      border: 2px solid rgba(96, 165, 250, 0.96);
      border-radius: 12px;
      box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.18);
      background: rgba(59, 130, 246, 0.08);
      pointer-events: none;
    }
    .highlight-label {
      position: absolute;
      top: -11px;
      left: -2px;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(59, 130, 246, 0.98);
      color: white;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      white-space: nowrap;
      box-shadow: 0 6px 16px rgba(37, 99, 235, 0.28);
    }
    .show-pill {
      position: fixed;
      top: 16px;
      right: 16px;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 10px 14px;
      border-radius: 999px;
      border: 1px solid rgba(148, 163, 184, 0.25);
      background: rgba(15, 23, 42, 0.9);
      color: #f8fafc;
      font: inherit;
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      box-shadow: 0 20px 48px rgba(15, 23, 42, 0.35);
      backdrop-filter: blur(18px);
      pointer-events: auto;
      cursor: pointer;
    }
    .show-pill.visible {
      display: inline-flex;
    }
    @media (max-width: 720px) {
      .bar {
        top: 10px;
        width: calc(100vw - 16px);
        align-items: flex-start;
      }
      .bar,
      .actions {
        flex-wrap: wrap;
      }
      .actions {
        width: 100%;
      }
      button {
        flex: 1 1 auto;
      }
      .show-pill {
        top: auto;
        right: 12px;
        bottom: 12px;
      }
    }
  `;

  const root = document.createElement("div");
  root.className = "root";

  const glow = document.createElement("div");
  glow.className = "glow";

  const highlights = document.createElement("div");
  highlights.className = "highlights";

  const bar = document.createElement("div");
  bar.className = "bar";

  const barLeft = document.createElement("div");
  barLeft.className = "bar-left";

  const eyebrow = document.createElement("div");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = currentTaskLabel;

  const status = document.createElement("div");
  status.className = "status";
  status.textContent = DEFAULT_STATUS_TEXT;

  barLeft.append(eyebrow, status);

  const actions = document.createElement("div");
  actions.className = "actions";

  const primaryButton = document.createElement("button");
  primaryButton.type = "button";
  primaryButton.className = "primary";
  primaryButton.textContent = "Take over";

  const stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.className = "secondary";
  stopButton.textContent = "Stop";

  const hideButton = document.createElement("button");
  hideButton.type = "button";
  hideButton.className = "secondary";
  hideButton.textContent = "Hide";

  actions.append(primaryButton, hideButton, stopButton);
  bar.append(barLeft, actions);

  const showButton = document.createElement("button");
  showButton.type = "button";
  showButton.className = "show-pill";
  showButton.textContent = "Show controls";

  const modal = document.createElement("div");
  modal.className = "modal";

  const modalCard = document.createElement("div");
  modalCard.className = "modal-card";

  const modalTitle = document.createElement("div");
  modalTitle.className = "modal-title";
  modalTitle.textContent = "Tell the operator what changed";

  const modalCopy = document.createElement("div");
  modalCopy.className = "modal-copy";
  modalCopy.textContent =
    "Summarize what you changed while taking over so the agent can continue smoothly.";

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Describe what you changed in the browser...";

  const modalActions = document.createElement("div");
  modalActions.className = "modal-actions";

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "secondary";
  cancelButton.textContent = "Cancel";

  const resumeButton = document.createElement("button");
  resumeButton.type = "button";
  resumeButton.className = "primary";
  resumeButton.textContent = "Send and continue";

  modalActions.append(cancelButton, resumeButton);
  modalCard.append(modalTitle, modalCopy, textarea, modalActions);
  modal.append(modalCard);

  root.append(glow, highlights, bar, showButton, modal);
  shadow.append(style, root);

  const appendHost = () => {
    if (!document.documentElement || host.isConnected) {
      return;
    }
    document.documentElement.appendChild(host);
  };

  appendHost();
  if (!host.isConnected) {
    document.addEventListener("DOMContentLoaded", appendHost, { once: true });
  }

  ui = {
    host,
    glow,
    highlights,
    bar,
    eyebrow,
    status,
    primaryButton,
    hideButton,
    stopButton,
    showButton,
    modal,
    textarea,
    cancelButton,
    resumeButton,
  };

  primaryButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (currentMaskState === "ongoing") {
      setControlsPending(true);
      try {
        const response = await chrome.runtime.sendMessage({ type: "extension/stop-task" });
        if (response?.ok) {
          applyRuntimeState(response.state, response.status, response.session);
        }
      } finally {
        setControlsPending(false);
      }
      return;
    }

    if (currentMaskState === "takeover") {
      showResumeModal();
    }
  });

  stopButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    setControlsPending(true);
    try {
      const response = await chrome.runtime.sendMessage({ type: "extension/unauthorize-task" });
      if (response?.ok) {
        hideResumeModal(true);
        applyRuntimeState(response.state, response.status, response.session);
      }
    } finally {
      setControlsPending(false);
    }
  });

  cancelButton.addEventListener("click", () => {
    hideResumeModal();
  });

  hideButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    setControlsPending(true);
    try {
      const response = await chrome.runtime.sendMessage({ type: "extension/hide-task-controls" });
      if (response?.ok) {
        applyRuntimeState(response.state, response.status, response.session);
      }
    } finally {
      setControlsPending(false);
    }
  });

  showButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    setControlsPending(true);
    try {
      const response = await chrome.runtime.sendMessage({ type: "extension/show-task-controls" });
      if (response?.ok) {
        applyRuntimeState(response.state, response.status, response.session);
      }
    } finally {
      setControlsPending(false);
    }
  });

  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      hideResumeModal();
    }
  });

  resumeButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    setControlsPending(true);
    try {
      const summary = ui.textarea.value.trim();
      const response = await chrome.runtime.sendMessage({ type: "extension/resume-task", summary });
      if (response?.ok) {
        hideResumeModal(true);
        applyRuntimeState(response.state, response.status, response.session);
      }
    } finally {
      setControlsPending(false);
    }
  });

  const blockHandler = (event) => {
    if (operatorInteractionDepth > 0) {
      return;
    }

    if (!maskBlocksUserInteraction()) {
      return;
    }

    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.includes(host)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
  };

  for (const eventName of BLOCKED_EVENTS) {
    document.addEventListener(eventName, blockHandler, { capture: true, passive: false });
  }

  return ui;
}

function clearHighlights() {
  ensureUiMounted().highlights.innerHTML = "";
}

function flashRect(rect, label) {
  const mountedUi = ensureUiMounted();
  const highlight = document.createElement("div");
  highlight.className = "highlight";
  highlight.style.left = `${Math.round(rect.left)}px`;
  highlight.style.top = `${Math.round(rect.top)}px`;
  highlight.style.width = `${Math.round(rect.width)}px`;
  highlight.style.height = `${Math.round(rect.height)}px`;

  const badge = document.createElement("div");
  badge.className = "highlight-label";
  badge.textContent = label;
  highlight.appendChild(badge);
  mountedUi.highlights.appendChild(highlight);

  setTimeout(() => {
    highlight.remove();
  }, 900);
}

function flashElement(element, label) {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) {
    return;
  }
  flashRect(rect, label);
}

function setStatusText(text) {
  currentStatusText = text || DEFAULT_STATUS_TEXT;
  ensureUiMounted().status.textContent = currentStatusText;
}

function taskLabelFromSession(session) {
  const label = typeof session?.taskName === "string" ? session.taskName.trim() : "";
  return label || "cBrowse task";
}

function setTaskLabel(label) {
  currentTaskLabel = label || "cBrowse task";
  ensureUiMounted().eyebrow.textContent = currentTaskLabel;
}

function setControlsPending(pending) {
  const mountedUi = ensureUiMounted();
  for (const control of [
    mountedUi.primaryButton,
    mountedUi.hideButton,
    mountedUi.stopButton,
    mountedUi.showButton,
    mountedUi.cancelButton,
    mountedUi.resumeButton,
  ]) {
    control.disabled = pending;
  }
}

function applyRuntimeState(maskState, statusText, session = undefined) {
  setTaskLabel(taskLabelFromSession(session));
  if (maskState === "hidden") {
    hiddenReturnState = session?.status === "takeover" ? "takeover" : "ongoing";
  }
  setMaskState(maskState ?? "idle", statusText || currentStatusText);
}

function hideResumeModal(clear = false) {
  const mountedUi = ensureUiMounted();
  mountedUi.modal.classList.remove("visible");
  if (clear) {
    mountedUi.textarea.value = "";
  }
}

function showResumeModal() {
  const mountedUi = ensureUiMounted();
  mountedUi.modal.classList.add("visible");
  mountedUi.textarea.focus();
}

function setMaskState(state, statusText = currentStatusText) {
  currentMaskState = state;
  setStatusText(statusText);

  const mountedUi = ensureUiMounted();
  mountedUi.glow.classList.toggle("visible", state === "ongoing");
  mountedUi.bar.classList.toggle(
    "visible",
    state === "ongoing" || state === "takeover",
  );
  mountedUi.showButton.classList.toggle("visible", state === "hidden");

  if (state === "ongoing") {
    hiddenReturnState = "ongoing";
    mountedUi.primaryButton.textContent = "Take over";
    mountedUi.hideButton.style.display = "inline-flex";
    mountedUi.stopButton.textContent = "Cancel";
    mountedUi.stopButton.style.display = "inline-flex";
    hideResumeModal();
    return;
  }

  if (state === "takeover") {
    hiddenReturnState = "takeover";
    mountedUi.primaryButton.textContent = "Resume";
    mountedUi.hideButton.style.display = "inline-flex";
    mountedUi.stopButton.textContent = "Stop";
    mountedUi.stopButton.style.display = "inline-flex";
    return;
  }

  if (state === "hidden") {
    mountedUi.hideButton.style.display = "none";
    hideResumeModal();
    return;
  }

  mountedUi.hideButton.style.display = "none";
  mountedUi.stopButton.style.display = "none";
  hideResumeModal();
  clearHighlights();
}

function keyDescriptor(keyString) {
  const tokens = keyString
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean);

  const descriptor = {
    key: "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  };

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "ctrl" || lower === "control") {
      descriptor.ctrlKey = true;
      continue;
    }
    if (lower === "shift") {
      descriptor.shiftKey = true;
      continue;
    }
    if (lower === "alt") {
      descriptor.altKey = true;
      continue;
    }
    if (lower === "meta" || lower === "cmd" || lower === "command") {
      descriptor.metaKey = true;
      continue;
    }
    descriptor.key = token.length === 1 ? token : token.charAt(0).toUpperCase() + token.slice(1);
  }

  return descriptor;
}

function pressKey(keyString) {
  const descriptor = keyDescriptor(keyString);
  if (!descriptor.key) {
    throw new Error(`Failed to parse key string: "${keyString}"`);
  }

  const target =
    document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  const init = {
    key: descriptor.key,
    bubbles: true,
    cancelable: true,
    ctrlKey: descriptor.ctrlKey,
    shiftKey: descriptor.shiftKey,
    altKey: descriptor.altKey,
    metaKey: descriptor.metaKey,
  };

  withOperatorInteraction(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    if (descriptor.key.length === 1 && !descriptor.ctrlKey && !descriptor.metaKey) {
      target.dispatchEvent(new KeyboardEvent("keypress", init));
    }
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  });
}

async function dispatchMouseClick(element, clickType) {
  await scrollElementIntoView(element);
  focusElement(element);
  const point = interactionPointForElement(element);
  flashElement(element, clickType === "single" ? "Click" : clickType === "double" ? "Double click" : "Right click");

  withOperatorInteraction(() => {
    dispatchPointerLikeEvent(element, "pointerover", point);
    dispatchPointerLikeEvent(element, "pointerenter", point);
    element.dispatchEvent(
      new MouseEvent("mouseover", {
        bubbles: true,
        cancelable: true,
        composed: true,
        ...point,
      }),
    );
    element.dispatchEvent(
      new MouseEvent("mouseenter", {
        bubbles: false,
        cancelable: false,
        composed: true,
        ...point,
      }),
    );
    dispatchPointerLikeEvent(element, "pointerdown", point);
    element.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        composed: true,
        ...point,
      }),
    );
    dispatchPointerLikeEvent(element, "pointerup", point);
    element.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        composed: true,
        ...point,
      }),
    );
  });

  if (clickType === "double") {
    withOperatorInteraction(() => {
      element.click();
    });
    await waitForAnimationFrames(1);
    withOperatorInteraction(() => {
      element.dispatchEvent(
        new MouseEvent("dblclick", {
          bubbles: true,
          cancelable: true,
          composed: true,
          ...point,
        }),
      );
    });
    await waitForAnimationFrames(2);
    return;
  }

  if (clickType === "right") {
    withOperatorInteraction(() => {
      element.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          composed: true,
          ...point,
        }),
      );
    });
    await waitForAnimationFrames(2);
    return;
  }

  withOperatorInteraction(() => {
    element.click();
  });
  await waitForAnimationFrames(2);
}

async function setElementValue(element, text) {
  await scrollElementIntoView(element);
  flashElement(element, "Type");
  focusElement(element);

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (typeof element.select === "function") {
      element.select();
    }
    withOperatorInteraction(() => {
      if (typeof InputEvent === "function") {
        element.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: text,
          }),
        );
      }
      setNativeTextValue(element, text);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitForAnimationFrames(2);
    return;
  }

  if (element instanceof HTMLSelectElement) {
    const normalizedText = text.trim().toLowerCase();
    const matchingOption = Array.from(element.options).find((option) => {
      return (
        option.value.trim().toLowerCase() === normalizedText ||
        option.textContent?.trim().toLowerCase() === normalizedText
      );
    });

    if (!matchingOption) {
      throw new Error(`No select option matched "${text}".`);
    }

    withOperatorInteraction(() => {
      element.value = matchingOption.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitForAnimationFrames(2);
    return;
  }

  if (element.isContentEditable) {
    focusElement(element);
    withOperatorInteraction(() => {
      if (typeof InputEvent === "function") {
        element.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: text,
          }),
        );
      }
      element.textContent = text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await waitForAnimationFrames(2);
    return;
  }

  throw new Error("Target is not text-editable.");
}

function scrollWindow(direction, toEnd) {
  const verticalDelta = Math.max(160, Math.round(window.innerHeight * 0.7));
  const horizontalDelta = Math.max(160, Math.round(window.innerWidth * 0.7));

  const top =
    direction === "down"
      ? toEnd
        ? document.documentElement.scrollHeight
        : window.scrollY + verticalDelta
      : direction === "up"
        ? toEnd
          ? 0
          : Math.max(window.scrollY - verticalDelta, 0)
        : window.scrollY;
  const left =
    direction === "right"
      ? toEnd
        ? document.documentElement.scrollWidth
        : window.scrollX + horizontalDelta
      : direction === "left"
        ? toEnd
          ? 0
          : Math.max(window.scrollX - horizontalDelta, 0)
        : window.scrollX;

  window.scrollTo({ top, left, behavior: "auto" });
}

async function waitForScrollSettled(readPosition, stableFrames = 3, maxFrames = 18) {
  let stableCount = 0;
  let previous = readPosition();
  for (let index = 0; index < maxFrames; index += 1) {
    await waitForAnimationFrames(1);
    const next = readPosition();
    if (next.left === previous.left && next.top === previous.top) {
      stableCount += 1;
      if (stableCount >= stableFrames) {
        return;
      }
    } else {
      stableCount = 0;
      previous = next;
    }
  }
}

function isScrollable(element, axis) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }

  const overflow = axis === "y" ? style.overflowY : style.overflowX;
  if (!["auto", "scroll", "overlay"].includes(overflow)) {
    return false;
  }

  return axis === "y"
    ? element.scrollHeight > element.clientHeight + 1
    : element.scrollWidth > element.clientWidth + 1;
}

function scrollContainerAtPoint(action) {
  if (
    typeof action.coordinateX !== "number" ||
    typeof action.coordinateY !== "number"
  ) {
    throw new Error("Container scroll requires coordinates.");
  }

  const { x, y } = denormalizeCoordinates(
    action.coordinateX,
    action.coordinateY,
    action.viewportWidth,
    action.viewportHeight,
  );
  let element = document.elementFromPoint(x, y);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`No element found at coordinates ${x},${y}`);
  }

  const axis = action.direction === "left" || action.direction === "right" ? "x" : "y";
  while (element && !isScrollable(element, axis)) {
    const root = element.getRootNode();
    if (root instanceof ShadowRoot && root.host instanceof HTMLElement && root.host !== element) {
      element = root.host;
      continue;
    }
    element = element.parentElement;
  }

  if (!(element instanceof HTMLElement)) {
    throw new Error("No scrollable container found at the requested coordinates.");
  }

  const delta =
    axis === "y"
      ? Math.max(160, Math.round(element.clientHeight * 0.7))
      : Math.max(160, Math.round(element.clientWidth * 0.7));
  const maxPosition =
    axis === "y"
      ? Math.max(element.scrollHeight - element.clientHeight, 0)
      : Math.max(element.scrollWidth - element.clientWidth, 0);
  const currentPosition = axis === "y" ? element.scrollTop : element.scrollLeft;
  let nextPosition = currentPosition;

  if (action.direction === "down" || action.direction === "right") {
    nextPosition = action.toEnd ? maxPosition : Math.min(currentPosition + delta, maxPosition);
  } else {
    nextPosition = action.toEnd ? 0 : Math.max(currentPosition - delta, 0);
  }

  if (axis === "y") {
    element.scrollTo({ top: nextPosition, behavior: "auto" });
  } else {
    element.scrollTo({ left: nextPosition, behavior: "auto" });
  }

  flashElement(element, `Scroll ${action.direction}`);
}

async function scrollWithAction(action) {
  if (action.target === "container") {
    scrollContainerAtPoint(action);
    await waitForScrollSettled(() => {
      const { x, y } = denormalizeCoordinates(
        action.coordinateX,
        action.coordinateY,
        action.viewportWidth,
        action.viewportHeight,
      );
      const element = document.elementFromPoint(x, y);
      let scrollable = element instanceof HTMLElement ? element : null;
      const axis = action.direction === "left" || action.direction === "right" ? "x" : "y";
      while (scrollable && !isScrollable(scrollable, axis)) {
        scrollable = scrollable.parentElement;
      }
      return {
        left: scrollable?.scrollLeft ?? 0,
        top: scrollable?.scrollTop ?? 0,
      };
    });
    return;
  }

  scrollWindow(action.direction, action.toEnd);
  await waitForScrollSettled(() => ({ left: window.scrollX, top: window.scrollY }));
}

async function hoverCoordinates(x, y, viewportWidth, viewportHeight) {
  const next = denormalizeCoordinates(x, y, viewportWidth, viewportHeight);
  const element = actionableTargetFromElement(document.elementFromPoint(next.x, next.y));
  if (!(element instanceof HTMLElement)) {
    throw new Error(`No element found at coordinates ${next.x},${next.y}`);
  }

  withOperatorInteraction(() => {
    if (lastHoveredElement && lastHoveredElement !== element) {
      dispatchPointerLikeEvent(lastHoveredElement, "pointerout", next);
      lastHoveredElement.dispatchEvent(
        new MouseEvent("mouseout", {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: next.x,
          clientY: next.y,
        }),
      );
    }

    dispatchPointerLikeEvent(element, "pointerover", next);
    dispatchPointerLikeEvent(element, "pointermove", next);
    element.dispatchEvent(
      new MouseEvent("mouseover", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: next.x,
        clientY: next.y,
      }),
    );
    element.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: next.x,
        clientY: next.y,
      }),
    );
  });
  lastHoveredElement = element;
  flashElement(element, "Hover");
  await waitForAnimationFrames(1);
}

function findKeywordMatches(keyword) {
  const text = document.body?.innerText || "";
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) {
    throw new Error("Keyword cannot be empty.");
  }

  const segments = text
    .split(/\n+/)
    .map((segment) => normalizeText(segment, 220))
    .filter(Boolean);

  const matches = [];
  for (const segment of segments) {
    if (!segment.toLowerCase().includes(normalizedKeyword)) {
      continue;
    }

    matches.push({
      index: matches.length,
      text: segment,
    });

    if (matches.length >= MAX_KEYWORD_MATCHES) {
      break;
    }
  }

  if (matches.length === 0) {
    throw new Error(`No text found containing "${keyword}" on the current page.`);
  }

  return matches;
}

async function restoreSessionState() {
  if (restoreRequested) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: "content/get-session-state" });
    if (!response?.ok) {
      throw new Error(response?.error || "Failed to restore session state.");
    }

    restoreRequested = true;
    restoreAttempts = 0;
    applyRuntimeState(response.state, response.status, response.session);
  } catch {
    restoreAttempts += 1;
    if (restoreAttempts < MAX_RESTORE_ATTEMPTS) {
      setTimeout(() => {
        void restoreSessionState();
      }, RESTORE_RETRY_DELAY_MS);
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    await waitForDocumentReady();
    ensureUiMounted();

    switch (message.type) {
      case "operator:set-status":
        setMaskState(currentMaskState === "idle" ? "ongoing" : currentMaskState, message.status);
        return { ok: true };
      case "operator:set-mask-state":
        setMaskState(message.state, message.status || currentStatusText);
        return { ok: true };
      case "operator:view":
        setStatusText("Inspecting page");
        return collectPageState();
      case "operator:click": {
        const element = targetFromAction(message.action.target);
        await dispatchMouseClick(element, message.action.clickType);
        setStatusText(`Clicked ${message.action.clickType}`);
        return collectPageState("click complete", {
          primaryTarget: describeActionTarget(element),
        });
      }
      case "operator:input": {
        const element = targetFromAction(message.action.target);
        await setElementValue(element, message.action.text);
        if (message.action.pressEnter) {
          pressKey("Enter");
        }
        setStatusText("Input complete");
        return collectPageState("input complete", {
          primaryTarget: describeActionTarget(element),
        });
      }
      case "operator:press-key":
        pressKey(message.action.key);
        setStatusText(`Pressed ${message.action.key}`);
        return collectPageState("key pressed");
      case "operator:scroll":
        await scrollWithAction(message.action);
        setStatusText(`Scrolled ${message.action.direction}`);
        return collectPageState("scroll complete");
      case "operator:move-mouse":
        await hoverCoordinates(
          message.action.coordinateX,
          message.action.coordinateY,
          message.action.viewportWidth,
          message.action.viewportHeight,
        );
        setStatusText(
          `Hover ${message.action.coordinateX},${message.action.coordinateY}`,
        );
        return collectPageState("mouse moved", {
          primaryTarget:
            lastHoveredElement instanceof HTMLElement ? describeActionTarget(lastHoveredElement) : undefined,
        });
      case "operator:find-keyword": {
        const matches = findKeywordMatches(message.action.keyword);
        setStatusText(`Found ${matches.length} matches for "${message.action.keyword}"`);
        return collectPageState("keyword search complete", {
          keywordMatches: matches,
        });
      }
      default:
        return { ok: false, error: "Unknown content action." };
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

void waitForDocumentReady()
  .then(() => {
    ensureUiMounted();
    void restoreSessionState();
  })
  .catch(() => {
    // Ignore pages that never become interactive.
  });
