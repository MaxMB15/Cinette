// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, fireEvent, screen } from "@testing-library/react";
import { PERF_SWITCH_KEY, countInvokes, withPerfCounters } from "./perf";
import { createTally } from "./tally";

type Internals = { invoke: (cmd: string, ...rest: unknown[]) => Promise<unknown> };
const win = window as { __TAURI_INTERNALS__?: Internals };

afterEach(() => {
	localStorage.clear();
	delete window.cinettePerf;
	delete win.__TAURI_INTERNALS__;
	vi.restoreAllMocks();
});

const Clicker = () => {
	const [n, setN] = useState(0);
	return <button onClick={() => setN(n + 1)}>clicked {n}</button>;
};

const renderWithCounters = () => {
	const container = document.body.appendChild(document.createElement("div"));
	render(<>{withPerfCounters(<Clicker />, container)}</>, { container });
};

describe("countInvokes", () => {
	it("counts each command and passes the call through", async () => {
		const original = vi.fn(async (cmd: string) => `answer to ${cmd}`);
		const target: Internals = { invoke: original };
		const tally = createTally();
		countInvokes(target, tally);

		await expect(target.invoke("get_providers", { a: 1 }, { headers: {} })).resolves.toBe(
			"answer to get_providers"
		);
		await target.invoke("get_providers");
		await target.invoke("get_all_channels");

		expect(original).toHaveBeenNthCalledWith(1, "get_providers", { a: 1 }, { headers: {} });
		expect(original.mock.contexts[0]).toBe(target);
		expect(tally.entries()).toEqual([
			["get_providers", 2],
			["get_all_channels", 1],
		]);
	});
});

describe("withPerfCounters", () => {
	it("reads its switch from the cinette-perf key", () => {
		expect(PERF_SWITCH_KEY).toBe("cinette-perf");
	});

	it("leaves the app alone while the switch is off", () => {
		const app = <Clicker />;
		expect(withPerfCounters(app, document.createElement("div"))).toBe(app);
		localStorage.setItem(PERF_SWITCH_KEY, "0");
		expect(withPerfCounters(app, document.createElement("div"))).toBe(app);
		expect(window.cinettePerf).toBeUndefined();
	});

	it("counts renders and backend calls while the switch is on", async () => {
		localStorage.setItem(PERF_SWITCH_KEY, "1");
		win.__TAURI_INTERNALS__ = { invoke: async () => null };
		renderWithCounters();
		const perf = window.cinettePerf!;
		await win.__TAURI_INTERNALS__.invoke("get_watch_history");
		expect(perf.report()).toEqual({
			commits: 1,
			renders: { Clicker: 1 },
			invokes: { get_watch_history: 1 },
		});

		perf.reset();
		fireEvent.click(screen.getByRole("button"));
		await win.__TAURI_INTERNALS__.invoke("get_providers");
		expect(perf.report()).toEqual({
			commits: 1,
			renders: { Clicker: 1 },
			invokes: { get_providers: 1 },
		});
	});

	it("prints the report", () => {
		localStorage.setItem(PERF_SWITCH_KEY, "1");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const table = vi.spyOn(console, "table").mockImplementation(() => {});
		renderWithCounters();

		const report = window.cinettePerf!.print();
		expect(report).toEqual({ commits: 1, renders: { Clicker: 1 }, invokes: {} });
		expect(log).toHaveBeenCalledWith("[perf] 1 commits");
		expect(table).toHaveBeenNthCalledWith(1, { Clicker: 1 });
		expect(table).toHaveBeenNthCalledWith(2, {});
	});

	it("still counts renders outside Tauri", () => {
		localStorage.setItem(PERF_SWITCH_KEY, "1");
		renderWithCounters();
		expect(window.cinettePerf!.report().renders).toEqual({ Clicker: 1 });
	});
});
