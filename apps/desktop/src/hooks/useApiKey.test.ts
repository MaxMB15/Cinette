// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "@/test/deferred";
import { SAVED_MS, useApiKey, type ApiKeyService } from "./useApiKey";

/** A service with `saved` as its key, where every save and check works. */
const makeService = (saved: string | null = null) => ({
	load: vi.fn<ApiKeyService["load"]>().mockResolvedValue(saved),
	save: vi.fn<ApiKeyService["save"]>().mockResolvedValue(undefined),
	test: vi.fn<ApiKeyService["test"]>().mockResolvedValue(true),
	onSaved: vi.fn<NonNullable<ApiKeyService["onSaved"]>>(),
});

/** Renders the hook and lets the saved key load. */
const renderKey = async (service: ApiKeyService) => {
	const view = renderHook(() => useApiKey(service));
	await act(async () => {});
	return view;
};

type KeyView = Awaited<ReturnType<typeof renderKey>>;

const type = (view: KeyView, value: string) => {
	act(() => view.result.current.setValue(value));
};

const save = async (view: KeyView) => {
	await act(() => view.result.current.save());
};

const check = async (view: KeyView) => {
	await act(() => view.result.current.test());
};

const advance = (ms: number) => {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
};

afterEach(() => {
	vi.useRealTimers();
});

describe("useApiKey loading", () => {
	it("fills the field with the saved key, trimmed", async () => {
		const service = makeService("  saved-key \n");
		const view = await renderKey(service);

		expect(service.load).toHaveBeenCalledOnce();
		expect(view.result.current).toMatchObject({
			value: "saved-key",
			saved: "saved-key",
			dirty: false,
			loadFailed: false,
			saveStatus: "idle",
			testStatus: "idle",
		});
	});

	it("starts empty when no key is saved", async () => {
		const view = await renderKey(makeService(null));
		expect(view.result.current).toMatchObject({ value: "", saved: "", dirty: false });
	});

	it("says when the saved key can't be read and starts empty", async () => {
		const service = makeService();
		service.load.mockRejectedValue(new Error("store"));
		const view = await renderKey(service);

		expect(view.result.current).toMatchObject({ value: "", saved: "", loadFailed: true });
	});

	it("keeps text typed while the saved key loads", async () => {
		const load = deferred<string | null>();
		const service = makeService();
		service.load.mockReturnValue(load.promise);
		const view = renderHook(() => useApiKey(service));

		type(view, "typed-key");
		await act(async () => load.resolve("saved-key"));

		expect(view.result.current).toMatchObject({
			value: "typed-key",
			saved: "saved-key",
			dirty: true,
		});
	});

	it("loads the key once across renders", async () => {
		const service = makeService("saved-key");
		const view = await renderKey(service);
		view.rerender();
		type(view, "other-key");

		expect(service.load).toHaveBeenCalledOnce();
	});
});

describe("useApiKey saving", () => {
	it("saves the trimmed key, says Saved for a moment and reports the save", async () => {
		vi.useFakeTimers();
		const service = makeService();
		const view = await renderKey(service);
		type(view, "  new-key  ");
		expect(view.result.current.dirty).toBe(true);

		await save(view);

		expect(service.save).toHaveBeenCalledExactlyOnceWith("new-key");
		expect(service.onSaved).toHaveBeenCalledExactlyOnceWith("new-key");
		expect(view.result.current).toMatchObject({
			value: "new-key",
			saved: "new-key",
			dirty: false,
			saveStatus: "saved",
		});

		advance(SAVED_MS - 1);
		expect(view.result.current.saveStatus).toBe("saved");
		advance(1);
		expect(view.result.current.saveStatus).toBe("idle");
	});

	it("removes the key when a blank field is saved", async () => {
		const service = makeService("saved-key");
		const view = await renderKey(service);
		type(view, "   ");

		await save(view);

		expect(service.save).toHaveBeenCalledExactlyOnceWith("");
		expect(service.onSaved).toHaveBeenCalledExactlyOnceWith("");
		expect(view.result.current).toMatchObject({ value: "", saved: "", saveStatus: "removed" });
	});

	it("shows Saving until the save lands and keeps it through an edit", async () => {
		const pending = deferred();
		const service = makeService();
		service.save.mockReturnValue(pending.promise);
		const view = await renderKey(service);
		type(view, "new-key");

		let saving!: Promise<void>;
		act(() => {
			saving = view.result.current.save();
		});
		expect(view.result.current.saveStatus).toBe("saving");
		type(view, "newer-key");
		expect(view.result.current.saveStatus).toBe("saving");

		await act(async () => {
			pending.resolve();
			await saving;
		});
		expect(view.result.current.saveStatus).toBe("idle");
	});

	it("keeps an edit made during a save and still records the save", async () => {
		const pending = deferred();
		const service = makeService();
		service.save.mockReturnValue(pending.promise);
		const view = await renderKey(service);
		type(view, "new-key");

		let saving!: Promise<void>;
		act(() => {
			saving = view.result.current.save();
		});
		type(view, "newer-key");
		await act(async () => {
			pending.resolve();
			await saving;
		});

		expect(service.onSaved).toHaveBeenCalledExactlyOnceWith("new-key");
		expect(view.result.current).toMatchObject({
			value: "newer-key",
			saved: "new-key",
			dirty: true,
			saveStatus: "idle",
		});
	});

	it("ignores a second save while one is on its way", async () => {
		const pending = deferred();
		const service = makeService();
		service.save.mockReturnValue(pending.promise);
		const view = await renderKey(service);
		type(view, "new-key");

		let first!: Promise<void>;
		act(() => {
			first = view.result.current.save();
		});
		await save(view);
		expect(service.save).toHaveBeenCalledOnce();

		await act(async () => {
			pending.resolve();
			await first;
		});
		await save(view);
		expect(service.save).toHaveBeenCalledTimes(2);
	});

	it("says when the key can't be saved and keeps the old one", async () => {
		const service = makeService("saved-key");
		service.save.mockRejectedValueOnce(new Error("disk full"));
		const view = await renderKey(service);
		type(view, "new-key");

		await save(view);

		expect(service.onSaved).not.toHaveBeenCalled();
		expect(view.result.current).toMatchObject({
			value: "new-key",
			saved: "saved-key",
			dirty: true,
			saveStatus: "error",
		});

		type(view, "newer-key");
		expect(view.result.current.saveStatus).toBe("idle");
	});

	it("drops a failure that lands after the field was edited", async () => {
		const pending = deferred();
		const service = makeService();
		service.save.mockReturnValue(pending.promise);
		const view = await renderKey(service);
		type(view, "new-key");

		let saving!: Promise<void>;
		act(() => {
			saving = view.result.current.save();
		});
		type(view, "newer-key");
		await act(async () => {
			pending.reject(new Error("disk full"));
			await saving;
		});

		expect(view.result.current.saveStatus).toBe("idle");
	});

	it("clears a failed read once a save works", async () => {
		const service = makeService();
		service.load.mockRejectedValue(new Error("store"));
		const view = await renderKey(service);
		type(view, "new-key");

		await save(view);
		expect(view.result.current.loadFailed).toBe(false);
	});

	it("restarts the Saved timer when the key is saved again", async () => {
		vi.useFakeTimers();
		const view = await renderKey(makeService());
		type(view, "new-key");
		await save(view);
		advance(SAVED_MS - 500);
		await save(view);

		advance(SAVED_MS - 1);
		expect(view.result.current.saveStatus).toBe("saved");
		advance(1);
		expect(view.result.current.saveStatus).toBe("idle");
	});

	it("drops Saved and its timer as soon as the field is edited", async () => {
		vi.useFakeTimers();
		const view = await renderKey(makeService());
		type(view, "new-key");
		await save(view);

		type(view, "newer-key");
		expect(view.result.current.saveStatus).toBe("idle");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("still reports a save that lands after the field has gone", async () => {
		const pending = deferred();
		const service = makeService();
		service.save.mockReturnValue(pending.promise);
		const view = await renderKey(service);
		type(view, "new-key");

		let saving!: Promise<void>;
		act(() => {
			saving = view.result.current.save();
		});
		view.unmount();
		await act(async () => {
			pending.resolve();
			await saving;
		});

		expect(service.onSaved).toHaveBeenCalledExactlyOnceWith("new-key");
	});

	it("stops the Saved timer when the field goes", async () => {
		vi.useFakeTimers();
		const view = await renderKey(makeService());
		type(view, "new-key");
		await save(view);
		expect(vi.getTimerCount()).toBe(1);

		view.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("useApiKey checking", () => {
	it.each([
		["valid", true],
		["invalid", false],
	] as const)("calls the key %s when the service says so", async (status, accepted) => {
		const service = makeService();
		service.test.mockResolvedValue(accepted);
		const view = await renderKey(service);
		type(view, " typed-key ");

		await check(view);

		expect(service.test).toHaveBeenCalledExactlyOnceWith("typed-key");
		expect(view.result.current.testStatus).toBe(status);
	});

	it("says the check couldn't reach the service when it fails", async () => {
		const service = makeService();
		service.test.mockRejectedValue(new Error("offline"));
		const view = await renderKey(service);
		type(view, "typed-key");

		await check(view);
		expect(view.result.current.testStatus).toBe("unreachable");
	});

	it("doesn't check a blank field", async () => {
		const service = makeService();
		const view = await renderKey(service);
		type(view, "   ");

		await check(view);
		expect(service.test).not.toHaveBeenCalled();
		expect(view.result.current.testStatus).toBe("idle");
	});

	it("shows Testing until the answer comes and ignores another check meanwhile", async () => {
		const answer = deferred<boolean>();
		const service = makeService();
		service.test.mockReturnValue(answer.promise);
		const view = await renderKey(service);
		type(view, "typed-key");

		let checking!: Promise<void>;
		act(() => {
			checking = view.result.current.test();
		});
		expect(view.result.current.testStatus).toBe("testing");
		await check(view);
		expect(service.test).toHaveBeenCalledOnce();

		await act(async () => {
			answer.resolve(true);
			await checking;
		});
		expect(view.result.current.testStatus).toBe("valid");
	});

	it("drops an answer for text that has since changed", async () => {
		const answer = deferred<boolean>();
		const service = makeService();
		service.test.mockReturnValueOnce(answer.promise);
		const view = await renderKey(service);
		type(view, "typed-key");

		let checking!: Promise<void>;
		act(() => {
			checking = view.result.current.test();
		});
		type(view, "other-key");
		expect(view.result.current.testStatus).toBe("idle");

		await act(async () => {
			answer.resolve(true);
			await checking;
		});
		expect(view.result.current.testStatus).toBe("idle");
	});

	it("can check the new text while the old check is still out", async () => {
		const answer = deferred<boolean>();
		const service = makeService();
		service.test.mockReturnValueOnce(answer.promise).mockResolvedValueOnce(false);
		const view = await renderKey(service);
		type(view, "typed-key");
		act(() => {
			void view.result.current.test();
		});
		type(view, "other-key");

		await check(view);
		expect(service.test).toHaveBeenLastCalledWith("other-key");
		expect(view.result.current.testStatus).toBe("invalid");

		await act(async () => answer.resolve(true));
		expect(view.result.current.testStatus).toBe("invalid");
	});

	it("drops the last answer once the key is saved", async () => {
		const service = makeService();
		service.test.mockResolvedValue(false);
		const view = await renderKey(service);
		type(view, "typed-key");
		await check(view);
		expect(view.result.current.testStatus).toBe("invalid");

		await save(view);
		expect(view.result.current.testStatus).toBe("idle");
	});
});
