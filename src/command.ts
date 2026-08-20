export interface CommandArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

const ROAST_COMMAND_COMPLETIONS: readonly CommandArgumentCompletion[] = [
	{ value: "start", label: "start", description: "Start Roast mode without sending a prompt" },
	{ value: "show", label: "show", description: "Show the ready, saved, or active roast" },
	{ value: "finalize", label: "finalize", description: "Request a completed roast" },
	{ value: "implement", label: "implement", description: "Implement the completed or saved roast" },
	{ value: "save", label: "save", description: "Save the completed roast for later" },
	{ value: "export", label: "export", description: "Export the stored roast to a Markdown file" },
	{ value: "exit", label: "exit", description: "Leave Roast mode or clear a saved/active roast" },
	{ value: "off", label: "off", description: "Leave Roast mode or clear a saved/active roast" },
	{
		value: "tools",
		label: "tools",
		description: "Choose tools before starting this Roast workflow",
	},
];

export function completeRoastArguments(argumentPrefix: string): CommandArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart().toLowerCase();
	if (prefix === "") return [...ROAST_COMMAND_COMPLETIONS];
	if (/\s/.test(prefix)) return null;

	const matches = ROAST_COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(prefix));
	return matches.length > 0 ? [...matches] : null;
}
