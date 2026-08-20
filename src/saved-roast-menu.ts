import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import {
	type RoastExportDestinationProvider,
	roastExportInputScreen,
} from "./roast-export-screen.js";

interface SavedRoastMenuOptions {
	statusText: string;
	implementationOutcome(): string;
	getExportDestination: RoastExportDestinationProvider;
	signal: AbortSignal;
	isCurrent(): boolean;
	show(): void;
	implementHere(): void | Promise<void>;
	implementFresh(signal: AbortSignal): void | Promise<void>;
	exportRoast(path: string, signal: AbortSignal): Promise<boolean>;
	settings(signal: AbortSignal): Promise<boolean>;
	clear(): void;
}

export async function showSavedRoastMenu(ctx: ExtensionContext, options: SavedRoastMenuOptions) {
	if (!ctx.hasUI) {
		throw new Error(
			`${options.statusText} Use /roast show, /roast implement, /roast export, or /roast exit.`,
		);
	}
	type Screen = "saved" | "export";
	type Action = "show" | "implement-here" | "implement-fresh" | "export" | "settings" | "clear";
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: "saved",
		screens: {
			saved: () => ({
				kind: "actions",
				title: "Saved roast",
				lines: [
					options.statusText,
					"Implement here keeps this roasting conversation.",
					"Start fresh transfers only the approved roast to a new session.",
					options.implementationOutcome(),
				],
				items: [
					{ id: "show", label: "Show saved roast", action: "show" },
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
					{ id: "settings", label: "Settings", action: "settings" },
					{ id: "clear", label: "Clear saved roast", action: "clear" },
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
			settings: async ({ signal }) => {
				const close = await options.settings(signal);
				if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
				return close ? { kind: "close" } : { kind: "stay" };
			},
			clear: async () => {
				options.clear();
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
