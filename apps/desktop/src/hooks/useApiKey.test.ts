// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { StrictMode } from "react";
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

/** Any rendered hook, whatever props it takes. */
type KeyView = Pick<Awaited<ReturnType<typeof renderKey>>, "result">;

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

type Load = ReturnType<typeof deferred<string | null>>;

/** The ways a load that comes back late can end. */
const LATE_LOADS = [
	["resolves", (load: Load) => load.resolve("old-key")],
	["fails", (load: Load) => load.reject(new Error("store"))],
] as const;

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
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

	it("keeps the key from the second load when Strict Mode loads twice", async () => {
		const first = deferred<string | null>();
		const second = deferred<string | null>();
		const service = makeService();
		service.load.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const view = renderHook(() => useApiKey(service), { wrapper: StrictMode });
		expect(service.load).toHaveBeenCalledTimes(2);

		await act(async () => second.resolve("saved-key"));
		await act(async () => first.reject(new Error("store")));
		expect(view.result.current).toMatchObject({
			value: "saved-key",
			saved: "saved-key",
			loadFailed: false,
		});
	});

	it.each(LATE_LOADS)("ignores a load that %s after a save", async (_, settle) => {
		const load = deferred<string | null>();
		const service = makeService();
		service.load.mockReturnValue(load.promise);
		const view = renderHook(() => useApiKey(service));
		type(view, "new-key");
		await save(view);

		await act(async () => settle(load));
		expect(view.result.current).toMatchObject({
			value: "new-key",
			saved: "new-key",
			loadFailed: false,
			dirty: false,
		});
	});

	it("still takes the saved key when it loads after a failed save", async () => {
		const load = deferred<string | null>();
		const service = makeService();
		service.load.mockReturnValue(load.promise);
		service.save.mockRejectedValue(new Error("disk full"));
		const view = renderHook(() => useApiKey(service));
		type(view, "new-key");
		await save(view);

		await act(async () => load.resolve("saved-key"));
		expect(view.result.current).toMatchObject({
			value: "new-key",
			saved: "saved-key",
			saveStatus: "error",
		});
	});

	it.each(LATE_LOADS)(
		"ignores a load from a service it no longer uses when it %s",
		async (_, settle) => {
			const oldLoad = deferred<string | null>();
			const oldService = makeService();
			oldService.load.mockReturnValue(oldLoad.promise);
			const newService = makeService("new-key");
			const view = renderHook(({ service }) => useApiKey(service), {
				initialProps: { service: oldService },
			});
			view.rerender({ service: newService });
			await act(async () => {});

			await act(async () => settle(oldLoad));
			expect(view.result.current).toMatchObject({
				value: "new-key",
				saved: "new-key",
				loadFailed: false,
			});
		}
	);

	it("takes the key a new service loads after a save to the old one", async () => {
		const oldService = makeService();
		const newService = makeService("other-key");
		const view = renderHook(({ service }) => useApiKey(service), {
			initialProps: { service: oldService as ApiKeyService },
		});
		await act(async () => {});
		type(view, "new-key");
		await save(view);

		view.rerender({ service: newService });
		await act(async () => {});
		expect(view.result.current).toMatchObject({ saved: "other-key", dirty: true });
	});

	it("takes the old service's key again when the field switches back to it", async () => {
		const oldService = makeService();
		const newService = makeService("other-key");
		const view = renderHook(({ service }) => useApiKey(service), {
			initialProps: { service: oldService as ApiKeyService },
		});
		await act(async () => {});
		type(view, "new-key");
		await save(view);

		view.rerender({ service: newService });
		await act(async () => {});
		oldService.load.mockResolvedValue("newer-key");
		view.rerender({ service: oldService });
		await act(async () => {});
		expect(view.result.current.saved).toBe("newer-key");
	});

	it("doesn't count spaces around the saved key as a change", async () => {
		const view = await renderKey(makeService("saved-key"));
		type(view, " saved-key  ");
		expect(view.result.current.dirty).toBe(false);
	});

	it("lets a blank field be saved when the saved key can't be read, which removes it", async () => {
		const service = makeService();
		service.load.mockRejectedValue(new Error("store"));
		const view = await renderKey(service);
		expect(view.result.current.dirty).toBe(true);

		await save(view);
		expect(service.save).toHaveBeenCalledExactlyOnceWith("");
		expect(view.result.current).toMatchObject({
			loadFailed: false,
			dirty: false,
			saveStatus: "removed",
		});
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

	it("starts no Saved timer for a save that lands after the field has gone", async () => {
		vi.useFakeTimers();
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

		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps a save that lands after a switch to another service out of the new one", async () => {
		vi.useFakeTimers();
		const pending = deferred();
		const oldService = makeService();
		oldService.save.mockReturnValue(pending.promise);
		const newService = makeService("other-key");
		const view = renderHook(({ service }) => useApiKey(service), {
			initialProps: { service: oldService as ApiKeyService },
		});
		await act(async () => {});
		type(view, "new-key");

		let saving!: Promise<void>;
		act(() => {
			saving = view.result.current.save();
		});
		view.rerender({ service: newService });
		await act(async () => {});
		await act(async () => {
			pending.resolve();
			await saving;
		});

		expect(oldService.onSaved).toHaveBeenCalledExactlyOnceWith("new-key");
		expect(view.result.current).toMatchObject({ saved: "other-key", saveStatus: "idle" });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clears Saving when a save fails after a switch to another service", async () => {
		const pending = deferred();
		const oldService = makeService();
		oldService.save.mockReturnValue(pending.promise);
		const view = renderHook(({ service }) => useApiKey(service), {
			initialProps: { service: oldService as ApiKeyService },
		});
		await act(async () => {});
		type(view, "new-key");

		let saving!: Promise<void>;
		act(() => {
			saving = view.result.current.save();
		});
		view.rerender({ service: makeService("other-key") });
		await act(async () => {
			pending.reject(new Error("store"));
			await saving;
		});

		expect(view.result.current.saveStatus).toBe("idle");
	});

	it("shows Saved and logs the error when reporting the save throws", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const service = makeService();
		service.onSaved.mockImplementation(() => {
			throw new Error("listener");
		});
		const view = await renderKey(service);
		type(view, "new-key");

		await save(view);
		expect(view.result.current.saveStatus).toBe("saved");
		expect(logged).toHaveBeenCalledExactlyOnceWith(
			"Couldn't report the saved key",
			new Error("listener")
		);
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

	it("drops an answer that lands after a switch to another service", async () => {
		const answer = deferred<boolean>();
		const oldService = makeService();
		oldService.test.mockReturnValue(answer.promise);
		const view = renderHook(({ service }) => useApiKey(service), {
			initialProps: { service: oldService as ApiKeyService },
		});
		await act(async () => {});
		type(view, "typed-key");

		let checking!: Promise<void>;
		act(() => {
			checking = view.result.current.test();
		});
		view.rerender({ service: makeService("other-key") });
		await act(async () => {
			answer.resolve(false);
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
