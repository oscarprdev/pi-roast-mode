import type { RoastExportDestination } from "./roast-export.js";

export type RoastExportDestinationProvider = () => RoastExportDestination;

export function roastExportInputScreen(getDestination: RoastExportDestinationProvider) {
	const destination = getDestination();
	return {
		kind: "input" as const,
		title: "Export roast",
		lines: [
			"Existing paths are never overwritten.",
			`Default: ${destination.configuredPath}`,
			`Resolves to: ${destination.resolvedPath}`,
		],
		placeholder: destination.configuredPath,
		action: "export" as const,
		hint: "back" as const,
	};
}
