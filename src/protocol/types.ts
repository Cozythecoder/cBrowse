import { z } from "zod";

export const TargetBySelectorSchema = z.object({
  strategy: z.literal("bySelector"),
  selector: z.string().min(1),
});

export const TargetByIndexSchema = z.object({
  strategy: z.literal("byIndex"),
  index: z.number().int().nonnegative(),
});

export const TargetByCoordinatesSchema = z.object({
  strategy: z.literal("byCoordinates"),
  coordinateX: z.number(),
  coordinateY: z.number(),
  viewportWidth: z.number().positive().optional(),
  viewportHeight: z.number().positive().optional(),
});

export const BrowserTargetSchema = z.discriminatedUnion("strategy", [
  TargetBySelectorSchema,
  TargetByIndexSchema,
  TargetByCoordinatesSchema,
]);

export const BrowserNavigateActionSchema = z.object({
  type: z.literal("browser_navigate"),
  url: z.string().url(),
  tabMode: z.enum(["grouped", "ungrouped"]).default("grouped"),
});

export const BrowserClickActionSchema = z.object({
  type: z.literal("browser_click"),
  target: BrowserTargetSchema,
  clickType: z.enum(["single", "double", "right"]).default("single"),
});

export const BrowserInputActionSchema = z.object({
  type: z.literal("browser_input"),
  target: BrowserTargetSchema,
  text: z.string(),
  pressEnter: z.boolean().default(false),
});

export const BrowserPressKeyActionSchema = z.object({
  type: z.literal("browser_press_key"),
  key: z.string().min(1),
});

export const BrowserScrollActionSchema = z.object({
  type: z.literal("browser_scroll"),
  direction: z.enum(["up", "down", "left", "right"]),
  toEnd: z.boolean().default(false),
  target: z.string().min(1).optional(),
  coordinateX: z.number().optional(),
  coordinateY: z.number().optional(),
  viewportWidth: z.number().positive().optional(),
  viewportHeight: z.number().positive().optional(),
});

export const BrowserMoveMouseActionSchema = z.object({
  type: z.literal("browser_move_mouse"),
  coordinateX: z.number(),
  coordinateY: z.number(),
  viewportWidth: z.number().positive().optional(),
  viewportHeight: z.number().positive().optional(),
});

export const BrowserFindKeywordActionSchema = z.object({
  type: z.literal("browser_find_keyword"),
  keyword: z.string().min(1),
});

export const BrowserViewActionSchema = z.object({
  type: z.literal("browser_view"),
});

export const BrowserActionSchema = z.discriminatedUnion("type", [
  BrowserNavigateActionSchema,
  BrowserClickActionSchema,
  BrowserInputActionSchema,
  BrowserPressKeyActionSchema,
  BrowserScrollActionSchema,
  BrowserMoveMouseActionSchema,
  BrowserFindKeywordActionSchema,
  BrowserViewActionSchema,
]);

export const BrowserElementSchema = z.object({
  index: z.number().int().nonnegative(),
  description: z.string(),
  targetKey: z.string().optional(),
  tagName: z.string().optional(),
  role: z.string().optional(),
  label: z.string().optional(),
  text: z.string().optional(),
  selectorHint: z.string().optional(),
  href: z.string().optional(),
  centerX: z.number().optional(),
  centerY: z.number().optional(),
  disabled: z.boolean().optional(),
  checked: z.boolean().optional(),
  selected: z.boolean().optional(),
  interactable: z.boolean().optional(),
  visibilityReason: z.string().optional(),
});

export const BrowserElementRectSchema = z.object({
  index: z.number().int().nonnegative(),
  targetKey: z.string().optional(),
  tagName: z.string().optional(),
  inputType: z.string().optional(),
  selectorHint: z.string().optional(),
  centerX: z.number().optional(),
  centerY: z.number().optional(),
  disabled: z.boolean().optional(),
  checked: z.boolean().optional(),
  interactable: z.boolean().optional(),
  occluded: z.boolean().optional(),
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

export const BrowserKeywordMatchSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string(),
});

export const BrowserArtifactSchema = z.object({
  url: z.string().optional(),
  title: z.string().optional(),
  result: z.string().optional(),
  error: z.boolean().optional(),
  screenshotUploaded: z.boolean().optional(),
  cleanScreenshotUploaded: z.boolean().optional(),
  screenshotDataUrl: z.string().optional(),
  cleanScreenshotDataUrl: z.string().optional(),
  markdown: z.string().optional(),
  fullMarkdown: z.string().optional(),
  elements: z.array(BrowserElementSchema).optional(),
  elementRects: z.array(BrowserElementRectSchema).optional(),
  primaryTarget: BrowserElementSchema.optional(),
  highlightCount: z.number().int().nonnegative().optional(),
  keywordMatches: z.array(BrowserKeywordMatchSchema).optional(),
  viewportWidth: z.number().optional(),
  viewportHeight: z.number().optional(),
  pixelsAbove: z.number().optional(),
  pixelsBelow: z.number().optional(),
  sessionId: z.string().optional(),
  tabId: z.number().int().optional(),
  groupId: z.number().int().optional(),
  controlledBy: z
    .object({
      agentId: z.string(),
      agentName: z.string(),
      via: z.string(),
      integration: z.string().optional(),
    })
    .optional(),
  newPages: z
    .array(
      z.object({
        tabId: z.number().int().optional(),
        url: z.string().optional(),
        title: z.string().optional(),
      }),
    )
    .optional(),
});

export const SessionStateSchema = z.object({
  sessionId: z.string(),
  status: z.enum(["idle", "running", "completed", "stopped", "takeover", "error"]),
  tabId: z.number().int().optional(),
  taskName: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const AgentIdentitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  via: z.enum(["mcp", "skills", "mcp+skills", "direct"]),
});

export const BridgeExecuteSchema = z.object({
  type: z.literal("bridge.execute"),
  requestId: z.string(),
  sessionId: z.string().optional(),
  taskName: z.string().optional(),
  targetTabId: z.number().int().optional(),
  agent: AgentIdentitySchema.optional(),
  action: BrowserActionSchema,
});

export const BridgeCancelSchema = z.object({
  type: z.literal("bridge.cancel"),
  requestId: z.string(),
});

export const BridgeToExtensionSchema = z.discriminatedUnion("type", [
  BridgeExecuteSchema,
  BridgeCancelSchema,
]);

export const ExtensionHelloSchema = z.object({
  type: z.literal("extension.hello"),
  extensionId: z.string().optional(),
  version: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  connectedAgent: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      via: z.string().min(1),
      integration: z.string().optional(),
    })
    .optional(),
});

export const ExtensionActionResultSchema = z.object({
  type: z.literal("extension.action_result"),
  requestId: z.string(),
  ok: z.boolean(),
  artifact: BrowserArtifactSchema.optional(),
  error: z.string().optional(),
});

export const ExtensionSessionUpdateSchema = z.object({
  type: z.literal("extension.session_update"),
  session: SessionStateSchema,
});

export const ExtensionToBridgeSchema = z.discriminatedUnion("type", [
  ExtensionHelloSchema,
  ExtensionActionResultSchema,
  ExtensionSessionUpdateSchema,
]);

export type BrowserTarget = z.infer<typeof BrowserTargetSchema>;
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
export type BrowserArtifact = z.infer<typeof BrowserArtifactSchema>;
export type SessionState = z.infer<typeof SessionStateSchema>;
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;
export type BridgeToExtensionMessage = z.infer<typeof BridgeToExtensionSchema>;
export type ExtensionToBridgeMessage = z.infer<typeof ExtensionToBridgeSchema>;
