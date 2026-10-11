// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { mpvLoad, mpvStop } from "./tauri";

const deferred = () => {
	let resolve!: () => void;
	let reject!: (e: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

const commands = () => invoke.mock.calls.map(([cmd]) => cmd);

describe("mpv load and stop", () => {
	beforeEach(() => invoke.mockReset());

	it("sends a load only after the stop before it finishes", async () => {
		const stop = deferred();
		invoke.mockReturnValueOnce(stop.promise).mockResolvedValueOnce(undefined);

		void mpvStop();
		const load = mpvLoad("http://example.com/live.ts");
		await flush();
		expect(commands()).toEqual(["plugin:mpv|mpv_stop"]);

		stop.resolve();
		await load;
		expect(commands()).toEqual(["plugin:mpv|mpv_stop", "plugin:mpv|mpv_load"]);
	});

	it("keeps going after a failed call and still reports the failure", async () => {
		const load = deferred();
		invoke.mockReturnValueOnce(load.promise).mockResolvedValueOnce(undefined);

		const failed = mpvLoad("http://example.com/bad.ts");
		const stopped = mpvStop();
		load.reject(new Error("load failed"));

		await expect(failed).rejects.toThrow("load failed");
		await stopped;
		expect(commands()).toEqual(["plugin:mpv|mpv_load", "plugin:mpv|mpv_stop"]);
	});
});
