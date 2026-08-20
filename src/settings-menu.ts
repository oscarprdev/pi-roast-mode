import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { defineMenu, type RunMenuResult, runMenu } from "@narumitw/pi-tui-kit";
import { ROAST_MODE_COMPLETE_TOOL_NAME } from "./completion-tool.js";
import { retentionLabel } from "./implementation-retention.js";
import { ROAST_MODE_QUESTION_TOOL_NAME } from "./question-tool.js";
import { roastExportDestination } from "./roast-export.js";
import {
	configuredImplementationRoastRetention,
	configuredRoastExportPath,
	configuredRoastModeToggleShortcut,
	IMPLEMENTATION_ROAST_RETENTIONS,
	normalizeKeyId,
	ROAST_MODE_THINKING_LEVELS,
	type RoastModeSettings,
	type RoastModeSettingsLoadResult,
	type RoastModeSettingsPatch,
	readRoastModeSettings,
	roastModeSettingsPath,
	type UpdateRoastModeSettingsOptions,
	updateRoastModeSettings,
} from "./settings.js";
import { canSelectToolInRoastMode } from "./tool-policy.js";
import { defaultRoastModeToolNames, toolPolicyLabel } from "./tool-selection.js";

interface SettingsMenuState {
	kind: "valid" | "invalid";
	settings: RoastModeSettings;
	notice?: string;
	reason?: string;
}

export interface RoastModeSettingsMenuOptions {
	tools: readonly ToolInfo[];
	signal: AbortSignal;
	isCurrent(): boolean;
	settingsPath?: string;
	legacySettingsPath?: string;
	readSettings?: (settingsPath?: string) => Promise<RoastModeSettingsLoadResult>;
	updateSettings?: (
		patch: RoastModeSettingsPatch,
		options?: UpdateRoastModeSettingsOptions,
	) => Promise<RoastModeSettings>;
	onSaved(settings: RoastModeSettings): void;
}

type Screen = "settings" | "tools" | "export" | "shortcut";
type Action =
	| "set-thinking"
	| "open-tools"
	| "toggle-tool"
	| "reset-tools"
	| "set-retention"
	| "open-export"
	| "set-export"
	| "open-shortcut"
	| "set-shortcut";

export async function showRoastModeSettings(
	ctx: ExtensionContext,
	options: RoastModeSettingsMenuOptions,
): Promise<RunMenuResult> {
	const settingsPath = options.settingsPath ?? roastModeSettingsPath();
	const readSettings = options.readSettings ?? readRoastModeSettings;
	const updateSettings = options.updateSettings ?? updateRoastModeSettings;
	const tools = options.tools.filter(
		(tool) =>
			tool.name !== ROAST_MODE_QUESTION_TOOL_NAME && tool.name !== ROAST_MODE_COMPLETE_TOOL_NAME,
	);

	const loadState = async (): Promise<SettingsMenuState> => {
		const loaded = await readSettings(options.settingsPath);
		if (loaded.kind === "invalid") {
			return {
				kind: "invalid",
				settings: { thinkingLevel: "inherit" },
				notice: loaded.notice,
				reason: loaded.reason,
			};
		}
		return {
			kind: "valid",
			settings: loaded.kind === "loaded" ? loaded.settings : { thinkingLevel: "inherit" },
			notice: loaded.notice,
		};
	};

	const menu = defineMenu<SettingsMenuState, Screen, Action, ExtensionContext>({
		start: "settings",
		screens: {
			settings: ({ state }) =>
				state.kind === "invalid"
					? invalidScreen(settingsPath, state)
					: {
							kind: "settings",
							title: "Roast Mode Settings",
							lines: settingsLines(settingsPath, state.notice),
							items: [
								{
									id: "thinkingLevel",
									label: "Roast thinking",
									description: "Set the thinking level when the next Roast workflow starts.",
									currentValue: state.settings.thinkingLevel,
									values: ROAST_MODE_THINKING_LEVELS,
									action: "set-thinking",
								},
								{
									id: "defaultRoastTools",
									label: "Roast tools",
									description:
										"Choose persistent defaults; a launch-time selection still overrides them for that session.",
									currentValue: defaultToolsValue(state.settings.defaultRoastTools),
									action: "open-tools",
								},
								{
									id: "implementationRoastRetention",
									label: "After Implement",
									description: "Choose how long the accepted roast keeps guiding implementation.",
									currentValue: retentionLabel(
										configuredImplementationRoastRetention(state.settings),
									),
									values: IMPLEMENTATION_ROAST_RETENTIONS.map(retentionLabel),
									action: "set-retention",
								},
								{
									id: "defaultRoastExportPath",
									label: "Export destination",
									description: "Set the destination used when an export omits its path.",
									currentValue: safeTerminalText(configuredRoastExportPath(state.settings)),
									action: "open-export",
								},
								{
									id: "toggleShortcut",
									label: "Roast mode shortcut",
									description: "Set the global shortcut used to toggle Roast mode.",
									currentValue: configuredRoastModeToggleShortcut(state.settings) ?? "none",
									action: "open-shortcut",
								},
							],
						},
			tools: ({ state }) => ({
				kind: "multiSelect",
				title: "Default Roast-mode tools",
				lines: [
					"Changes apply when a later Roast workflow starts; required Roast tools stay enabled.",
					"Non-built-in tools run at user risk.",
				],
				enableSearch: true,
				viewportSize: 10,
				items: defaultToolItems(tools, state.settings.defaultRoastTools),
				action: "toggle-tool",
				actions: [
					{
						id: "reset-tools",
						label: "Use automatic safe built-ins",
						action: "reset-tools",
					},
				],
				hint: "back",
			}),
			export: ({ state }) => {
				const configured = configuredRoastExportPath(state.settings);
				const destination = roastExportDestination(configured, ctx.cwd);
				return {
					kind: "input",
					title: "Export destination",
					lines: [
						`Configured: ${destination.configuredPath}`,
						`Resolves here to: ${destination.resolvedPath}`,
						"Submit an empty value to reset to ROAST.md. Changes affect the next export.",
					],
					placeholder: configured,
					action: "set-export",
					hint: "back",
				};
			},
			shortcut: ({ state }) => ({
				kind: "input",
				title: "Roast mode shortcut",
				lines: [
					`Configured: ${configuredRoastModeToggleShortcut(state.settings) ?? "none"}`,
					"Use Pi key identifiers.",
					"Submit an empty value to clear the shortcut.",
					"When unset, Roast mode has no global shortcut.",
				],
				placeholder: configuredRoastModeToggleShortcut(state.settings) ?? "",
				action: "set-shortcut",
				hint: "back",
			}),
		},
		actions: {
			"set-thinking": async ({ ctx: actionCtx, value, signal }) => {
				if (
					!ROAST_MODE_THINKING_LEVELS.includes(value as (typeof ROAST_MODE_THINKING_LEVELS)[number])
				) {
					return { kind: "rejected" };
				}
				return savePatch(
					actionCtx,
					{ thinkingLevel: value as RoastModeSettings["thinkingLevel"] },
					signal,
					`Roast mode thinking level: ${value}. Applies to the next Roast workflow.`,
				);
			},
			"open-tools": async () => ({ kind: "to", screen: "tools" }),
			"set-retention": async ({ ctx: actionCtx, value, signal }) => {
				const implementationRoastRetention = retentionFromLabel(value);
				if (!implementationRoastRetention) return { kind: "rejected" };
				return savePatch(
					actionCtx,
					{ implementationRoastRetention },
					signal,
					`After Implement: ${retentionLabel(implementationRoastRetention)}. Applies to the next Implement action.`,
				);
			},
			"open-export": async () => ({ kind: "to", screen: "export" }),
			"set-export": async ({ ctx: actionCtx, value, signal }) => {
				const defaultRoastExportPath = value?.trim() || null;
				const result = await savePatch(
					actionCtx,
					{ defaultRoastExportPath },
					signal,
					defaultRoastExportPath
						? `Default Roast export destination: ${safeTerminalText(defaultRoastExportPath)}.`
						: "Default Roast export destination reset to ROAST.md.",
				);
				return result.kind === "stay" ? { kind: "to", screen: "settings" } : result;
			},
			"open-shortcut": async () => ({ kind: "to", screen: "shortcut" }),
			"set-shortcut": async ({ ctx: actionCtx, value, signal }) => {
				const raw = value?.trim() || null;
				if (raw && !normalizeKeyId(raw)) {
					actionCtx.ui.notify(
						`Invalid key identifier: ${safeTerminalText(raw)}. Use Pi key identifiers like ctrl+alt+p.`,
						"warning",
					);
					return { kind: "stay" as const };
				}
				const toggleShortcut = raw as RoastModeSettingsPatch["toggleShortcut"];
				const result = await savePatch(
					actionCtx,
					{ toggleShortcut },
					signal,
					toggleShortcut
						? `Roast mode shortcut: ${safeTerminalText(toggleShortcut)}.`
						: "Roast mode shortcut cleared (no global shortcut).",
				);
				return result.kind === "stay" ? { kind: "to", screen: "settings" } : result;
			},
			"toggle-tool": async ({ ctx: actionCtx, state, itemId, selected, signal }) => {
				const tool = tools.find((candidate) => candidate.name === itemId);
				if (!tool || !canSelectToolInRoastMode(tool)) return { kind: "rejected" };
				const names = explicitToolNames(tools, state.settings.defaultRoastTools);
				const next = selected
					? Array.from(new Set([...names, tool.name]))
					: names.filter((name) => name !== tool.name);
				return savePatch(
					actionCtx,
					{ defaultRoastTools: next },
					signal,
					`Default Roast-mode tools: ${next.length === 0 ? "required tools only" : `${next.length} selected`}.`,
				);
			},
			"reset-tools": async ({ ctx: actionCtx, state, signal }) => {
				if (state.settings.defaultRoastTools === undefined) return { kind: "stay" };
				return savePatch(
					actionCtx,
					{ defaultRoastTools: null },
					signal,
					"Default Roast-mode tools: automatic safe built-ins.",
				);
			},
		},
	});

	return runMenu(ctx, menu, {
		getState: loadState,
		signal: options.signal,
		isCurrent: options.isCurrent,
	});

	async function savePatch(
		actionCtx: ExtensionContext,
		patch: RoastModeSettingsPatch,
		signal: AbortSignal,
		successMessage: string,
	) {
		if (signal.aborted || !options.isCurrent()) return { kind: "rejected" as const };
		try {
			const saved = await updateSettings(patch, {
				settingsPath: options.settingsPath,
				legacySettingsPath: options.legacySettingsPath,
				signal,
			});
			if (options.isCurrent()) options.onSaved(saved);
			if (signal.aborted || !options.isCurrent()) return { kind: "rejected" as const };
			actionCtx.ui.notify(successMessage, "info");
			return { kind: "stay" as const };
		} catch (error) {
			if (!signal.aborted && options.isCurrent()) {
				actionCtx.ui.notify(
					`Could not save Roast mode settings; the previous value remains: ${safeTerminalText(formatError(error))}`,
					"error",
				);
			}
			return { kind: "rejected" as const };
		}
	}
}

function settingsLines(settingsPath: string, notice: string | undefined) {
	return [
		`User settings · ${safeTerminalText(settingsPath)}`,
		"Roast defaults apply to the next workflow; handoff and export choices apply to their next action.",
		...(notice ? [safeTerminalText(notice)] : []),
	];
}

function invalidScreen(settingsPath: string, state: SettingsMenuState) {
	return {
		kind: "detail" as const,
		title: "Roast Mode Settings · Read only",
		lines: [
			`Invalid settings file. Fix ${safeTerminalText(settingsPath)} before saving.`,
			safeTerminalText(state.reason ?? "The settings file is invalid."),
			...(state.notice ? [safeTerminalText(state.notice)] : []),
		],
		hint: "back" as const,
	};
}

function retentionFromLabel(value: string | undefined) {
	return IMPLEMENTATION_ROAST_RETENTIONS.find((retention) => retentionLabel(retention) === value);
}

function defaultToolsValue(configured: string[] | undefined) {
	if (configured === undefined) return "Automatic safe built-ins";
	if (configured.length === 0) return "Required tools only";
	return `${configured.length} selected`;
}

function defaultToolItems(tools: readonly ToolInfo[], configured: string[] | undefined) {
	const selected = new Set(explicitToolNames(tools, configured));
	const availableNames = new Set(tools.map((tool) => tool.name));
	const items = tools.map((tool) => {
		const selectable = canSelectToolInRoastMode(tool);
		const policy = toolPolicyLabel(tool);
		const description = tool.description ?? "No description available";
		return {
			id: tool.name,
			label: tool.name,
			description: `${policy} · ${description}`,
			searchText: `${policy} ${description}`,
			selected: selected.has(tool.name),
			disabled: !selectable,
			disabledReason: selectable ? undefined : "Blocked by Roast-mode policy",
		};
	});
	for (const name of configured ?? []) {
		if (availableNames.has(name)) continue;
		items.push({
			id: name,
			label: name,
			description: "unavailable · Retained in settings but unavailable in this session",
			searchText: "unavailable retained settings",
			selected: true,
			disabled: true,
			disabledReason: "Unavailable in this session; reset defaults to remove unavailable names",
		});
	}
	return items;
}

function explicitToolNames(tools: readonly ToolInfo[], configured: string[] | undefined) {
	return configured === undefined
		? defaultRoastModeToolNames([...tools], undefined)
		: [...configured];
}

function safeTerminalText(value: string) {
	return [...value]
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
		})
		.join("")
		.trim();
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
