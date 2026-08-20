import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { ROAST_MODE_COMPLETE_TOOL_NAME } from "./completion-tool.js";
import { ROAST_MODE_QUESTION_TOOL_NAME } from "./question-tool.js";
import { withRequiredRoastModeTools } from "./required-tools.js";
import {
	canSelectToolInRoastMode,
	classifyRoastModeTool,
	isBuiltinTool,
	SAFE_BUILTIN_ROAST_TOOLS,
} from "./tool-policy.js";

export function toolNameFromLegacyKey(key: string, tools: ToolInfo[]) {
	const directName = tools.find((tool) => tool.name === key)?.name;
	if (directName) return directName;
	const [name] = key.split("\u001f");
	return tools.find((tool) => tool.name === name) ? name : undefined;
}

export function compareTools(left: ToolInfo, right: ToolInfo) {
	const leftBuiltin = isBuiltinTool(left);
	const rightBuiltin = isBuiltinTool(right);
	if (leftBuiltin !== rightBuiltin) return leftBuiltin ? -1 : 1;
	return left.name.localeCompare(right.name);
}

export function toolPolicyLabel(tool: ToolInfo) {
	const policy = classifyRoastModeTool(tool);
	if (policy === "read-only") return "built-in read-only";
	if (policy === "limited") return "built-in limited";
	if (policy === "blocked") return "built-in blocked";
	return `user opt-in: ${toolSourceLabel(tool)}`;
}

function toolSourceLabel(tool: ToolInfo) {
	const sourceInfo = tool.sourceInfo;
	const source = `${sourceInfo.scope}/${sourceInfo.source}`;
	return sourceInfo.path ? `${source} ${sourceInfo.path}` : source;
}

export function unique(values: string[]) {
	return Array.from(new Set(values));
}

export function filterAvailableSelectedToolNames(names: string[], tools: ToolInfo[]) {
	const availableNames = new Set(tools.filter(canSelectToolInRoastMode).map((tool) => tool.name));
	return unique(names.filter((name) => availableNames.has(name)));
}

export function defaultRoastModeToolNames(
	tools: ToolInfo[],
	configuredNames: string[] | undefined,
) {
	if (configuredNames !== undefined) {
		return filterAvailableSelectedToolNames(configuredNames, tools);
	}
	return tools
		.filter((tool) => isBuiltinTool(tool) && SAFE_BUILTIN_ROAST_TOOLS.has(tool.name))
		.map((tool) => tool.name);
}

interface RoastModeToolSelectionSnapshot {
	selectedToolNames?: string[];
	selectedToolKeys?: string[];
	defaultRoastTools?: string[];
}

export function snapshotRoastModeSelectedNames(
	tools: ToolInfo[],
	selection: RoastModeToolSelectionSnapshot,
) {
	const selectedToolNames =
		selection.selectedToolNames ??
		selection.selectedToolKeys
			?.map((key) => toolNameFromLegacyKey(key, tools))
			.filter((name): name is string => name !== undefined);
	return new Set(
		selectedToolNames === undefined
			? defaultRoastModeToolNames(tools, selection.defaultRoastTools)
			: filterAvailableSelectedToolNames(selectedToolNames, tools),
	);
}

export function snapshotRoastModeToolNames(
	tools: ToolInfo[],
	selectedNames: ReadonlySet<string>,
	selection: RoastModeToolSelectionSnapshot,
) {
	if (
		tools.length === 0 &&
		selection.selectedToolNames === undefined &&
		selection.selectedToolKeys === undefined &&
		selection.defaultRoastTools === undefined
	) {
		return ["read", "bash", ROAST_MODE_QUESTION_TOOL_NAME, ROAST_MODE_COMPLETE_TOOL_NAME];
	}
	return withRequiredRoastModeTools(
		tools
			.filter((tool) => selectedNames.has(tool.name) && canSelectToolInRoastMode(tool))
			.map((tool) => tool.name),
	);
}
