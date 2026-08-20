import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { exportStoredRoast, roastExportDestination } from "./roast-export.js";
import { configuredRoastExportPath, type RoastModeSettings } from "./settings.js";
import type { RoastModeState } from "./state.js";

interface RoastExportControllerOptions {
	getState(): RoastModeState;
	getSettings(): RoastModeSettings;
	finishReady(ctx: ExtensionContext): void;
}

export function createRoastExportController(options: RoastExportControllerOptions) {
	return {
		export(
			path: string | undefined,
			ctx: ExtensionContext,
			signal: AbortSignal,
			isCurrent: () => boolean,
		) {
			const state = options.getState();
			return exportStoredRoast(
				state,
				path,
				ctx,
				{
					signal,
					isCurrent,
					getState: options.getState,
					finishReady: () => options.finishReady(ctx),
				},
				configuredRoastExportPath(options.getSettings()),
			);
		},
		getDestination(ctx: ExtensionContext) {
			return roastExportDestination(configuredRoastExportPath(options.getSettings()), ctx.cwd);
		},
	};
}
