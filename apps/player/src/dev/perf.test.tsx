// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, fireEvent, screen } from "@testing-library/react";
import { setInvokeListener } from "@/lib/invoke";
import { getProviders, getWatchHistory } from "@/lib/tauri";
import { PERF_SWITCH_KEY, withPerfCounters } from "./perf";

type Internals = { invoke: (cmd: string, ...rest: unknown[]) => Promise<unknown> };
const win = window as { __TAURI_INTERNALS__?: Internals };

/**
 * Sets up the object Tauri's webview defines, whose `invoke` can't be
 * written or redefined.
 */
const defineTauriInternals = (invoke: Internals["invoke"]) => {
	const internals = Object.defineProperty({}, "invoke", { value: invoke }) as Internals;
	Object.defineProperty(window, "__TAURI_INTERNALS__", { value: internals, configurable: true });
};

afterEach(() => {
	localStorage.clear();
	delete window.cinettePerf;
	delete win.__TAURI_INTERNALS__;
	setInvokeListener(null);
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
		const backend = vi.fn(async () => []);
		defineTauriInternals(backend);
		renderWithCounters();
		const perf = window.cinettePerf!;
		await getWatchHistory(20);
		expect(perf.report()).toEqual({
			commits: 1,
			renders: { Clicker: 1 },
			invokes: { get_watch_history: 1 },
		});

		perf.reset();
		fireEvent.click(screen.getByRole("button"));
		await getProviders();
		await getProviders();
		expect(perf.report()).toEqual({
			commits: 1,
			renders: { Clicker: 1 },
			invokes: { get_providers: 2 },
		});
		expect(backend).toHaveBeenCalledTimes(3);
	});

	it("renders and counts with Tauri's read-only invoke", async () => {
		localStorage.setItem(PERF_SWITCH_KEY, "1");
		const backend = vi.fn(async () => [{ id: "p1" }]);
		defineTauriInternals(backend);
		renderWithCounters();
		expect(screen.getByRole("button")).toHaveTextContent("clicked 0");

		await expect(getProviders()).resolves.toEqual([{ id: "p1" }]);
		expect(win.__TAURI_INTERNALS__!.invoke).toBe(backend);
		expect(backend).toHaveBeenCalledWith("get_providers", {}, undefined);
		expect(window.cinettePerf!.report().invokes).toEqual({ get_providers: 1 });
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
