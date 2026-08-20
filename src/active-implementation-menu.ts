import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import {
	type RoastExportDestinationProvider,
	roastExportInputScreen,
} from "./roast-export-screen.js";

interface ActiveImplementationMenuOptions {
	statusText: string;
	getExportDestination: RoastExportDestinationProvider;
	signal: AbortSignal;
	isCurrent(): boolean;
	show(): void;
	exportRoast(path: string, signal: AbortSignal): Promise<boolean>;
	settings(signal: AbortSignal): Promise<boolean>;
	startNew(): void;
	clear(): void;
}

export async function showActiveImplementationMenu(
	ctx: ExtensionContext,
	options: ActiveImplementationMenuOptions,
) {
	type Screen = "active" | "export";
	type Action = "show" | "export" | "settings" | "start-new" | "clear";
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: "active",
		screens: {
			active: () => ({
				kind: "actions",
				title: "Active implementation roast",
				lines: [options.statusText],
				items: [
					{ id: "show", label: "Show active implementation roast", action: "show" },
					{ id: "export", label: "Export roast…", to: "export" },
					{ id: "settings", label: "Settings", action: "settings" },
					{ id: "start-new", label: "Start a new roast", action: "start-new" },
					{ id: "clear", label: "Clear active implementation roast", action: "clear" },
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
			export: async ({ value, signal }) =>
				(await options.exportRoast(value ?? "", signal)) ? { kind: "close" } : { kind: "rejected" },
			settings: async ({ signal }) => {
				const close = await options.settings(signal);
				if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
				return close ? { kind: "close" } : { kind: "stay" };
			},
			"start-new": async () => {
				options.startNew();
				return { kind: "close" };
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
