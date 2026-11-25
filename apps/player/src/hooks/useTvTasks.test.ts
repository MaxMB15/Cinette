// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "@/test/deferred";
import { useTvTasks } from "./useTvTasks";

/** Runs `action` under `key`, and lets a settled one report back. */
const run = async (
	view: { result: { current: ReturnType<typeof useTvTasks> } },
	key: string,
	action: () => Promise<string | void>
) => {
	await act(async () => {
		view.result.current.run(key, action);
	});
};

describe("useTvTasks", () => {
	it("says nothing about a row that has run nothing", () => {
		const { result } = renderHook(() => useTvTasks());
		expect(result.current.busy("clear")).toBe(false);
		expect(result.current.message("clear")).toBeNull();
		expect(result.current.failed("clear")).toBe(false);
	});

	it("is busy until the action answers, and shows its answer", async () => {
		const view = renderHook(() => useTvTasks());
		const task = deferred<string>();

		await run(view, "clear", () => task.promise);
		expect(view.result.current.busy("clear")).toBe(true);
		expect(view.result.current.message("clear")).toBeNull();

		await act(async () => task.resolve("Cleared"));
		expect(view.result.current.busy("clear")).toBe(false);
		expect(view.result.current.message("clear")).toBe("Cleared");
		expect(view.result.current.failed("clear")).toBe(false);
	});

	it("shows no message for an action that has nothing to say", async () => {
		const view = renderHook(() => useTvTasks());
		await run(view, "clear", async () => {});
		expect(view.result.current.busy("clear")).toBe(false);
		expect(view.result.current.message("clear")).toBeNull();
	});

	it("shows what a failed action threw", async () => {
		const view = renderHook(() => useTvTasks());
		await run(view, "clear", () => Promise.reject(new Error("no network")));
		expect(view.result.current.busy("clear")).toBe(false);
		expect(view.result.current.message("clear")).toBe("Error: no network");
		expect(view.result.current.failed("clear")).toBe(true);
	});

	it("stops saying a row failed once it runs again", async () => {
		const view = renderHook(() => useTvTasks());
		await run(view, "clear", () => Promise.reject(new Error("no network")));
		const task = deferred<string>();
		await run(view, "clear", () => task.promise);
		expect(view.result.current.failed("clear")).toBe(false);
		await act(async () => task.resolve("Cleared"));
		expect(view.result.current.failed("clear")).toBe(false);
	});

	it("ignores another press while the row's action runs", async () => {
		const view = renderHook(() => useTvTasks());
		const task = deferred<string>();
		const again = vi.fn(async () => "again");

		await run(view, "clear", () => task.promise);
		await run(view, "clear", again);

		expect(again).not.toHaveBeenCalled();
		expect(view.result.current.busy("clear")).toBe(true);
		await act(async () => task.resolve("Cleared"));
	});

	it("can run a row again once its action is done, and clears the last message", async () => {
		const view = renderHook(() => useTvTasks());
		await run(view, "clear", async () => "Cleared");

		const task = deferred<string>();
		await run(view, "clear", () => task.promise);
		expect(view.result.current.busy("clear")).toBe(true);
		expect(view.result.current.message("clear")).toBeNull();

		await act(async () => task.resolve("Cleared again"));
		expect(view.result.current.message("clear")).toBe("Cleared again");
	});

	it("keeps each row's state apart", async () => {
		const view = renderHook(() => useTvTasks());
		await run(view, "done", async () => "Done");

		const running = deferred<string>();
		await run(view, "running", () => running.promise);
		expect(view.result.current.message("done")).toBe("Done");
		expect(view.result.current.busy("running")).toBe(true);
		expect(view.result.current.busy("done")).toBe(false);

		await run(view, "other", async () => "Other");
		expect(view.result.current.busy("running")).toBe(true);

		await act(async () => running.resolve("Finished"));
		expect(view.result.current.message("done")).toBe("Done");
		expect(view.result.current.message("running")).toBe("Finished");
		expect(view.result.current.message("other")).toBe("Other");
	});
});
