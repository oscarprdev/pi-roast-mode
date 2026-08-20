import assert from "node:assert/strict";
import { test } from "vitest";
import { createRoastActionController } from "../src/roast-action-controller.js";
import { createMockContext } from "./support.js";

test("stale Roast actions do not load interactive UI", async () => {
	let interactiveLoads = 0;
	const controller = createRoastActionController({
		loadInteractiveUi: async () => {
			interactiveLoads += 1;
			return {} as never;
		},
		getState: () => ({ enabled: false, awaitingAction: false }),
		captureLifecycle: () => ({
			signal: new AbortController().signal,
			isCurrent: () => false,
		}),
		statusText: () => "off",
		implementationOutcome: () => "",
		getExportDestination: () => ({ configuredPath: "roast.md", resolvedPath: "/tmp/roast.md" }),
		show: () => undefined,
		finalize: () => undefined,
		implementHere: () => undefined,
		implementFresh: () => undefined,
		exportRoast: async () => false,
		settings: async () => false,
		save: () => undefined,
		stay: () => undefined,
		exitReady: () => undefined,
		clearSaved: () => undefined,
	});
	const context = createMockContext({ hasUI: true });

	await controller.showSaved(context.ctx);
	await controller.showCurrent(context.ctx);
	await controller.showReady(context.ctx);

	assert.equal(interactiveLoads, 0);
});
