import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";

export interface RoastLaunchTool {
	name: string;
	description: string;
	searchText: string;
	disabled: boolean;
	disabledReason?: string;
}

interface RoastLaunchMenuOptions {
	statusText: string;
	toolSummary(selectedNames: ReadonlySet<string>): string;
	getSelectedNames(): ReadonlySet<string>;
	tools: readonly RoastLaunchTool[];
	signal: AbortSignal;
	isCurrent(): boolean;
	initialScreen?: "main" | "tools";
	start(signal: AbortSignal): void;
	startWithTools(toolNames: string[], signal: AbortSignal): void;
	settings(signal: AbortSignal): Promise<boolean>;
}

export async function showRoastLaunchMenu(ctx: ExtensionContext, options: RoastLaunchMenuOptions) {
	type Screen = "main" | "tools" | "help";
	type Action = "start" | "toggle-tool" | "start-with-tools" | "settings";
	const selectedNames = new Set(options.getSelectedNames());
	let draftChanged = false;
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: options.initialScreen ?? "main",
		screens: {
			main: () => ({
				kind: "actions",
				title: "Roast mode",
				lines: [options.statusText, options.toolSummary(selectedNames)],
				items: [
					{ id: "start", label: "Start Roast mode", action: "start" },
					{ id: "tools", label: "Choose tools, then start…", to: "tools" },
					{ id: "settings", label: "Settings", action: "settings" },
					{ id: "help", label: "How Roast mode works", to: "help" },
				],
				hint: "close",
			}),
			tools: () => ({
				kind: "multiSelect",
				title: "Choose Roast-mode tools",
				lines: [
					"Changes apply only when you start Roast mode.",
					"Non-built-in tools run at user risk.",
				],
				enableSearch: true,
				viewportSize: 10,
				items: options.tools.map((tool) => ({
					id: tool.name,
					label: tool.name,
					description: tool.description,
					searchText: tool.searchText,
					selected: selectedNames.has(tool.name),
					disabled: tool.disabled,
					disabledReason: tool.disabledReason,
				})),
				action: "toggle-tool",
				actions: [
					{
						id: "start-with-tools",
						label: "Done — start Roast mode",
						action: "start-with-tools",
					},
				],
				hint: "back",
			}),
			help: () => ({
				kind: "detail",
				title: "How Roast mode works",
				lines: [
					"Roast mode uses read-only exploration to understand the project before implementation.",
					"The agent can ask important decision questions, then returns a complete implementation-ready roast.",
					"File mutation stays blocked until you explicitly choose to implement the completed roast.",
				],
				hint: "back",
			}),
		},
		actions: {
			start: async ({ signal }) => {
				if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
				options.start(signal);
				return { kind: "close" };
			},
			"toggle-tool": async ({ itemId, selected, signal }) => {
				if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
				const tool = options.tools.find((candidate) => candidate.name === itemId);
				if (!tool || tool.disabled) return { kind: "rejected" };
				if (selected) selectedNames.add(tool.name);
				else selectedNames.delete(tool.name);
				draftChanged = true;
				return { kind: "stay" };
			},
			"start-with-tools": async ({ signal }) => {
				if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
				options.startWithTools(Array.from(selectedNames), signal);
				return { kind: "close" };
			},
			settings: async ({ signal }) => {
				if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
				const close = await options.settings(signal);
				if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
				if (close) return { kind: "close" };
				if (!draftChanged) {
					selectedNames.clear();
					for (const name of options.getSelectedNames()) selectedNames.add(name);
				}
				return { kind: "stay" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: options.signal,
		isCurrent: options.isCurrent,
	});
}
