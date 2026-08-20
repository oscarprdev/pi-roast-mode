import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import {
	type RoastExportDestinationProvider,
	roastExportInputScreen,
} from "./roast-export-screen.js";

interface MenuLifecycle {
	signal: AbortSignal;
	isCurrent(): boolean;
}

const IMPLEMENTATION_CONTEXT_LINES = [
	"Implement here keeps this roasting conversation.",
	"Start fresh transfers only the approved roast to a new session.",
] as const;

interface RoastMenuOptions extends MenuLifecycle {
	statusText: string;
	hasReadyRoast: boolean;
	implementationOutcome(): string;
	getExportDestination: RoastExportDestinationProvider;
	show(): void;
	finalize(): void;
	implementHere(): void | Promise<void>;
	implementFresh(signal: AbortSignal): void | Promise<void>;
	exportRoast(path: string, signal: AbortSignal): Promise<boolean>;
	save(): void;
	stay(): void;
	exit(): void;
}

export async function showRoastModeMenu(ctx: ExtensionContext, options: RoastMenuOptions) {
	type Screen = "main" | "export";
	type Action =
		| "show"
		| "finalize"
		| "implement-here"
		| "implement-fresh"
		| "export"
		| "save"
		| "stay"
		| "exit";
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: "main",
		screens: {
			main: () => ({
				kind: "actions",
				title: "Roast mode",
				lines: [
					options.statusText,
					...(options.hasReadyRoast
						? [...IMPLEMENTATION_CONTEXT_LINES, options.implementationOutcome()]
						: []),
				],
				items: options.hasReadyRoast
					? [
							{ id: "show", label: "Show latest proposed roast", action: "show" },
							{
								id: "implement-here",
								label: "Implement here",
								description: "Continue in this session with the roasting conversation.",
								action: "implement-here",
							},
							{
								id: "implement-fresh",
								label: "Start fresh and implement",
								description: "Open a new linked session; transfer only the approved roast.",
								action: "implement-fresh",
								busyLabel: "Starting fresh implementation session…",
							},
							{ id: "export", label: "Export roast…", to: "export" },
							{ id: "save", label: "Save for later", action: "save" },
							{ id: "stay", label: "Stay in Roast mode", action: "stay" },
							{ id: "exit", label: "Discard roast and exit", action: "exit" },
						]
					: [
							{ id: "finalize", label: "Request final roast", action: "finalize" },
							{ id: "stay", label: "Stay in Roast mode", action: "stay" },
							{ id: "exit", label: "Exit Roast mode", action: "exit" },
						],
				hint: "close",
			}),
			export: () => roastExportInputScreen(options.getExportDestination),
		},
		actions: {
			show: async () => {
				options.show();
				return { kind: "close" };
			},
			finalize: async () => {
				options.finalize();
				return { kind: "close" };
			},
			"implement-here": async () => {
				await options.implementHere();
				return { kind: "close" };
			},
			"implement-fresh": async ({ signal }) => {
				await options.implementFresh(signal);
				return { kind: "close" };
			},
			export: async ({ value, signal }) =>
				(await options.exportRoast(value ?? "", signal)) ? { kind: "close" } : { kind: "rejected" },
			save: async () => {
				options.save();
				return { kind: "close" };
			},
			stay: async () => {
				options.stay();
				return { kind: "close" };
			},
			exit: async () => {
				options.exit();
				return { kind: "close" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: options.signal,
		isCurrent: options.isCurrent,
	});
}

interface ReadyRoastMenuOptions extends MenuLifecycle {
	implementationOutcome(): string;
	getExportDestination: RoastExportDestinationProvider;
	implementHere(): void | Promise<void>;
	implementFresh(signal: AbortSignal): void | Promise<void>;
	exportRoast(path: string, signal: AbortSignal): Promise<boolean>;
	save(): void;
	stay(): void;
	exit(): void;
}

export async function showReadyRoastMenu(ctx: ExtensionContext, options: ReadyRoastMenuOptions) {
	type Screen = "ready" | "export";
	type Action = "implement-here" | "implement-fresh" | "export" | "save" | "stay" | "exit";
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: "ready",
		screens: {
			ready: () => ({
				kind: "actions",
				title: "Proposed roast ready. What next?",
				lines: [...IMPLEMENTATION_CONTEXT_LINES, options.implementationOutcome()],
				items: [
					{
						id: "implement-here",
						label: "Implement here",
						description: "Continue in this session with the roasting conversation.",
						action: "implement-here",
					},
					{
						id: "implement-fresh",
						label: "Start fresh and implement",
						description: "Open a new linked session; transfer only the approved roast.",
						action: "implement-fresh",
						busyLabel: "Starting fresh implementation session…",
					},
					{ id: "export", label: "Export roast…", to: "export" },
					{ id: "save", label: "Save for later", action: "save" },
					{ id: "stay", label: "Stay in Roast mode", action: "stay" },
					{ id: "exit", label: "Discard roast and exit", action: "exit" },
				],
				hint: "close",
			}),
			export: () => roastExportInputScreen(options.getExportDestination),
		},
		actions: {
			"implement-here": async () => {
				await options.implementHere();
				return { kind: "close" };
			},
			"implement-fresh": async ({ signal }) => {
				await options.implementFresh(signal);
				return { kind: "close" };
			},
			export: async ({ value, signal }) =>
				(await options.exportRoast(value ?? "", signal)) ? { kind: "close" } : { kind: "rejected" },
			save: async () => {
				options.save();
				return { kind: "close" };
			},
			stay: async () => {
				options.stay();
				return { kind: "close" };
			},
			exit: async () => {
				options.exit();
				return { kind: "close" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: options.signal,
		isCurrent: options.isCurrent,
	});
}
