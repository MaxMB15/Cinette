// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// Runs the whole app against a made-up backend and counts, for each flow,
// the renders per component and the backend calls per command. Run it with
// `pnpm perf` from apps/player, which prints the numbers. The normal test run
// leaves it out.
//
// It renders without StrictMode, as the shipped app does, with real timers
// and a fixed clock.

import { describe, it, expect, vi } from "vitest";
import { Profiler } from "react";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import App from "@/App";
import { createRenderCounter } from "./render-counts";
import { createTally } from "./tally";
import type { FlowResult } from "./flow-report";
import { createPerfBackend, PERF_NOW_SECONDS } from "@/test/perf-backend";

const backend = vi.hoisted(() => ({
	current: null as null | ReturnType<typeof createPerfBackend>,
}));
const invokes = vi.hoisted(() => ({ add: (() => {}) as (cmd: string) => void }));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (cmd: string, args?: Record<string, unknown>) => {
		invokes.add(cmd);
		return backend.current!.invoke(cmd, args);
	},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/window", () => import("@/test/fake-window"));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: async () => null }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: async () => {} }));

const VIEWPORT_HEIGHT = 900;
const VIEWPORT_WIDTH = 1280;
/** How long nothing may commit before a flow counts as finished. */
const QUIET_MS = 600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until no commit happens for QUIET_MS. Counting goes on after the
 * flow's last action, since effects and backend answers render later.
 */
const settle = async (commits: () => number, maxMs = 15_000) => {
	const deadline = Date.now() + maxMs;
	let seen = -1;
	while (seen !== commits()) {
		if (Date.now() > deadline) throw new Error("the app never stopped rendering");
		seen = commits();
		await act(() => sleep(QUIET_MS));
	}
};

describe("measured flows", () => {
	it("counts renders and backend calls for each flow", { timeout: 120_000 }, async ({ task }) => {
		const results: FlowResult[] = [];
		task.meta.flows = results;
		vi.useFakeTimers({ toFake: ["Date"], now: PERF_NOW_SECONDS * 1000 });
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(VIEWPORT_HEIGHT);
		vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(VIEWPORT_WIDTH);
		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(VIEWPORT_WIDTH);
		backend.current = createPerfBackend();

		const container = document.body.appendChild(document.createElement("div"));
		const renders = createRenderCounter(container);
		const calls = createTally();
		invokes.add = calls.add;

		const callsTo = (cmd: string) => calls.entries().find(([c]) => c === cmd)?.[1] ?? 0;

		/**
		 * Counts what `run` and everything it sets off renders and calls. With
		 * `settled` false, the count stops when `run` returns, for a flow that
		 * never goes quiet, like the player's poll.
		 */
		const measure = async (flow: string, run: () => Promise<void>, settled = true) => {
			renders.reset();
			calls.reset();
			await run();
			if (settled) await settle(renders.commits);
			results.push({
				flow,
				commits: renders.commits(),
				renders: Object.fromEntries(renders.counts()),
				invokes: Object.fromEntries(calls.entries()),
			});
		};

		await measure("Open the app", async () => {
			render(
				<Profiler id="app" onRender={renders.onRender}>
					<MemoryRouter initialEntries={["/"]}>
						<App />
					</MemoryRouter>
				</Profiler>,
				{ container }
			);
			const start = await screen.findByRole("button", { name: "Get Started →" });
			await waitFor(() => expect(start).toBeEnabled(), { timeout: 10_000 });
			fireEvent.click(start);
			await screen.findByText("News 0", undefined, { timeout: 10_000 });
		});

		const scroller = screen.getByText("News 0").closest(".overflow-auto") as HTMLElement;

		await measure("Scroll the channel list", async () => {
			for (let i = 1; i <= 20; i++) {
				scroller.scrollTop = i * 400;
				fireEvent.scroll(scroller);
				await act(() => sleep(16));
			}
		});

		await act(async () => {
			scroller.scrollTop = 0;
			fireEvent.scroll(scroller);
		});
		await settle(renders.commits);

		await measure("Type a search", async () => {
			const input = screen.getByPlaceholderText(/search/i);
			const query = "news 12";
			for (let i = 1; i <= query.length; i++) {
				fireEvent.change(input, { target: { value: query.slice(0, i) } });
				// Well under the list's 250 ms debounce, as a fast typist would.
				await act(() => sleep(50));
			}
		});

		await act(async () => {
			fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "" } });
		});
		await settle(renders.commits);

		await measure("Open the Movies tab", async () => {
			fireEvent.click(screen.getByRole("button", { name: /^Movies/ }));
			await screen.findByText("Movie 0 (1980)");
		});

		await measure("Open a movie's details", async () => {
			fireEvent.click(screen.getByText("Movie 0 (1980)"));
			await screen.findByText("A made-up plot.", undefined, { timeout: 10_000 });
		});

		const closeDetails = async () => {
			fireEvent.click(screen.getByRole("button", { name: "Close" }));
			// The drawer slides away before it closes.
			await waitFor(() => expect(screen.queryByText("A made-up plot.")).toBeNull());
			await settle(renders.commits);
		};
		await closeDetails();

		await measure("Open the same movie's details again", async () => {
			fireEvent.click(screen.getByText("Movie 0 (1980)"));
			await screen.findByText("A made-up plot.", undefined, { timeout: 10_000 });
		});
		await closeDetails();

		await measure("Go back to the Live tab", async () => {
			fireEvent.click(screen.getByRole("button", { name: /^Live/ }));
			await screen.findByText("News 0");
		});

		// The player asks mpv for its state every second. The flow ends as the
		// sixth poll goes out, after the fifth answer has rendered.
		await measure(
			"Start a channel and poll 5 times",
			async () => {
				fireEvent.click(screen.getByText("News 0").closest("button") as HTMLElement);
				await waitFor(() => expect(callsTo("plugin:mpv|mpv_get_state")).toBe(6), {
					timeout: 10_000,
					interval: 20,
				});
			},
			false
		);

		expect([...backend.current.unknown]).toEqual([]);
	});
});
