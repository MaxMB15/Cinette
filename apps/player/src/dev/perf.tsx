// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Profiler, type ReactNode } from "react";
import { readStorage } from "@/lib/storage";
import { createRenderCounter } from "./render-counts";
import { createTally, type Tally } from "./tally";

/** Set this key to "1" in local storage, then reload, to count in a dev build. */
export const PERF_SWITCH_KEY = "cinette-perf";

/** What the counters saw since the last reset. */
export interface PerfReport {
	commits: number;
	renders: Record<string, number>;
	invokes: Record<string, number>;
}

export interface PerfCounters {
	report: () => PerfReport;
	/** Prints the report as two tables in the console, and returns it. */
	print: () => PerfReport;
	reset: () => void;
}

declare global {
	interface Window {
		/** The counters, while the dev switch is on. */
		cinettePerf?: PerfCounters;
	}
}

type Invoke = (cmd: string, ...rest: unknown[]) => Promise<unknown>;

/** Counts each call through `target.invoke` by its command name. */
export const countInvokes = (target: { invoke: Invoke }, tally: Tally): void => {
	const original = target.invoke;
	target.invoke = (cmd, ...rest) => {
		tally.add(cmd);
		return original.call(target, cmd, ...rest);
	};
};

/**
 * Wraps `app` so it counts renders per component and backend calls per
 * command, when the switch in local storage is on. `container` is the element
 * the app's React root renders into. Otherwise it returns `app` as it is.
 */
export const withPerfCounters = (app: ReactNode, container: Element): ReactNode => {
	if (readStorage(PERF_SWITCH_KEY) !== "1") return app;
	const renders = createRenderCounter(container);
	const invokes = createTally();
	// Every backend call from @tauri-apps/api goes through this object.
	const internals = (window as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__;
	if (internals) countInvokes(internals, invokes);

	const report = (): PerfReport => ({
		commits: renders.commits(),
		renders: Object.fromEntries(renders.counts()),
		invokes: Object.fromEntries(invokes.entries()),
	});
	window.cinettePerf = {
		report,
		print: () => {
			const r = report();
			console.log(`[perf] ${r.commits} commits`);
			console.table(r.renders);
			console.table(r.invokes);
			return r;
		},
		reset: () => {
			renders.reset();
			invokes.reset();
		},
	};
	return (
		<Profiler id="app" onRender={renders.onRender}>
			{app}
		</Profiler>
	);
};
