import { ROAST_MODE_COMPLETE_TOOL_NAME } from "./completion-tool.js";
import { ROAST_MODE_QUESTION_TOOL_NAME } from "./question-tool.js";
import { unique } from "./tool-selection.js";

export function withRequiredRoastModeTools(toolNames: string[]) {
	return unique([
		...withoutRequiredRoastModeTools(toolNames),
		ROAST_MODE_QUESTION_TOOL_NAME,
		ROAST_MODE_COMPLETE_TOOL_NAME,
	]);
}

export function withoutRoastModeQuestionTool(toolNames: string[]) {
	return toolNames.filter((toolName) => toolName !== ROAST_MODE_QUESTION_TOOL_NAME);
}

export function withoutRequiredRoastModeTools(toolNames: string[]) {
	return toolNames.filter(
		(toolName) =>
			toolName !== ROAST_MODE_QUESTION_TOOL_NAME && toolName !== ROAST_MODE_COMPLETE_TOOL_NAME,
	);
}
