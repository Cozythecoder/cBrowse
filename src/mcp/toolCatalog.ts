import { z } from "zod";

import { ExtensionBridge } from "../bridge/extensionBridge.js";
import type { BrowserAction } from "../protocol/types.js";

type ToolDefinition<TInput extends z.ZodTypeAny> = {
  name: string;
  description: string;
  inputSchema: TInput;
  toAction: (input: z.infer<TInput>) => BrowserAction;
};

const agentContextShape = {
  agentId: z.string().min(1).optional(),
  agentName: z.string().min(1).optional(),
  via: z.enum(["mcp", "skills", "mcp+skills", "direct"]).optional(),
  sessionId: z.string().min(1).optional(),
  taskName: z.string().min(1).optional(),
  tabId: z.number().int().optional(),
};

function withAgentContext<T extends z.ZodRawShape>(shape: T) {
  return z.object({
    ...shape,
    ...agentContextShape,
  });
}

function extractAgentContext(input: {
  agentId?: string;
  agentName?: string;
  via?: "mcp" | "skills" | "mcp+skills" | "direct";
  sessionId?: string;
  taskName?: string;
  tabId?: number;
}) {
  const hasAgentIdentity = Boolean(input.agentId || input.agentName);
  return {
    sessionId: input.sessionId,
    taskName: input.taskName,
    targetTabId: input.tabId,
    agent: hasAgentIdentity
      ? {
          id: input.agentId ?? String(input.agentName).toLowerCase().replace(/\s+/g, "_"),
          name: input.agentName ?? input.agentId ?? "Unknown Agent",
          via: input.via ?? "mcp",
        }
      : undefined,
  };
}

const navigateInput = withAgentContext({
  url: z.string().url(),
  tabMode: z.enum(["grouped", "ungrouped"]).default("grouped"),
});

const clickInput = withAgentContext({
  selector: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  coordinateX: z.number().optional(),
  coordinateY: z.number().optional(),
  viewportWidth: z.number().positive().optional(),
  viewportHeight: z.number().positive().optional(),
  clickType: z.enum(["single", "double", "right"]).default("single"),
});

const inputInput = withAgentContext({
  selector: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  coordinateX: z.number().optional(),
  coordinateY: z.number().optional(),
  viewportWidth: z.number().positive().optional(),
  viewportHeight: z.number().positive().optional(),
  text: z.string(),
  pressEnter: z.boolean().default(false),
});

const pressKeyInput = withAgentContext({
  key: z.string().min(1),
});

const scrollInput = withAgentContext({
  direction: z.enum(["up", "down", "left", "right"]),
  toEnd: z.boolean().default(false),
  target: z.string().optional(),
  coordinateX: z.number().optional(),
  coordinateY: z.number().optional(),
  viewportWidth: z.number().positive().optional(),
  viewportHeight: z.number().positive().optional(),
});

const moveMouseInput = withAgentContext({
  coordinateX: z.number(),
  coordinateY: z.number(),
  viewportWidth: z.number().positive().optional(),
  viewportHeight: z.number().positive().optional(),
});

const findKeywordInput = withAgentContext({
  keyword: z.string().min(1),
});

const emptyInput = withAgentContext({});

function resolveTarget(input: {
  selector?: string;
  index?: number;
  coordinateX?: number;
  coordinateY?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}) {
  if (input.selector) {
    return { strategy: "bySelector" as const, selector: input.selector };
  }

  if (typeof input.index === "number") {
    return { strategy: "byIndex" as const, index: input.index };
  }

  if (typeof input.coordinateX === "number" && typeof input.coordinateY === "number") {
    return {
      strategy: "byCoordinates" as const,
      coordinateX: input.coordinateX,
      coordinateY: input.coordinateY,
      viewportWidth: input.viewportWidth,
      viewportHeight: input.viewportHeight,
    };
  }

  throw new Error("A target is required. Provide selector, index, or coordinates.");
}

export const toolCatalog = [
  {
    name: "browser_navigate",
    description: "Navigate the active browser tab to a URL.",
    inputSchema: navigateInput,
    toAction: (input) => ({
      type: "browser_navigate",
      url: input.url,
      tabMode: input.tabMode,
    }),
  },
  {
    name: "browser_click",
    description: "Click an element by selector, index, or coordinates.",
    inputSchema: clickInput,
    toAction: (input) => ({
      type: "browser_click",
      target: resolveTarget(input),
      clickType: input.clickType,
    }),
  },
  {
    name: "browser_input",
    description: "Type text into an input target by selector, index, or coordinates.",
    inputSchema: inputInput,
    toAction: (input) => ({
      type: "browser_input",
      target: resolveTarget(input),
      text: input.text,
      pressEnter: input.pressEnter,
    }),
  },
  {
    name: "browser_press_key",
    description: "Press a keyboard key or key chord in the active page.",
    inputSchema: pressKeyInput,
    toAction: (input) => ({
      type: "browser_press_key",
      key: input.key,
    }),
  },
  {
    name: "browser_scroll",
    description: "Scroll the page in a direction, optionally to the end.",
    inputSchema: scrollInput,
    toAction: (input) => ({
      type: "browser_scroll",
      direction: input.direction,
      toEnd: input.toEnd,
      target: input.target,
      coordinateX: input.coordinateX,
      coordinateY: input.coordinateY,
      viewportWidth: input.viewportWidth,
      viewportHeight: input.viewportHeight,
    }),
  },
  {
    name: "browser_move_mouse",
    description: "Move the mouse to viewport coordinates.",
    inputSchema: moveMouseInput,
    toAction: (input) => ({
      type: "browser_move_mouse",
      coordinateX: input.coordinateX,
      coordinateY: input.coordinateY,
      viewportWidth: input.viewportWidth,
      viewportHeight: input.viewportHeight,
    }),
  },
  {
    name: "browser_find_keyword",
    description: "Search the current page text for a keyword and return nearby matching excerpts.",
    inputSchema: findKeywordInput,
    toAction: (input) => ({
      type: "browser_find_keyword",
      keyword: input.keyword,
    }),
  },
  {
    name: "browser_view",
    description: "Inspect the current page and return page metadata and element annotations.",
    inputSchema: emptyInput,
    toAction: () => ({
      type: "browser_view",
    }),
  },
] satisfies Array<ToolDefinition<z.ZodTypeAny>>;

export type ToolName = (typeof toolCatalog)[number]["name"];

export async function invokeTool(
  bridge: ExtensionBridge,
  name: ToolName,
  rawInput: unknown,
  pairingKey?: string,
): Promise<unknown> {
  const tool = toolCatalog.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const input = tool.inputSchema.parse(rawInput);
  const action = tool.toAction(input);
  const executionContext = {
    ...extractAgentContext(input),
    pairingKey,
  };
  const artifact = await bridge.execute(action, executionContext);

  return {
    action,
    agent: executionContext.agent,
    targetTabId: executionContext.targetTabId,
    artifact,
  };
}
