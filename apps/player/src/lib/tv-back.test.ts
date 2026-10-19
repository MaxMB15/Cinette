// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { handleBack } from "./tv-back";

describe("handleBack", () => {
	const cleanups: (() => void)[] = [];
	const listen = (target: EventTarget, listener: (e: KeyboardEvent) => void, capture = false) => {
		target.addEventListener("keydown", listener as EventListener, capture);
		cleanups.push(() =>
			target.removeEventListener("keydown", listener as EventListener, capture)
		);
	};

	afterEach(() => {
		cleanups.splice(0).forEach((f) => f());
		document.body.innerHTML = "";
	});

	it("sends a cancelable Escape that bubbles to the focused element", () => {
		const field = document.createElement("input");
		document.body.appendChild(field);
		field.focus();
		const seen = vi.fn();
		listen(field, (e) => seen(e.key, e.bubbles, e.cancelable, e.target));

		handleBack(document, false, () => {});
		expect(seen).toHaveBeenCalledWith("Escape", true, true, field);
	});

	it("counts Escape as taken when a handler cancels it", () => {
		listen(document.body, (e) => e.preventDefault());
		const goHome = vi.fn();
		expect(handleBack(document, false, goHome)).toBe("closed");
		expect(goHome).not.toHaveBeenCalled();
	});

	it("counts Escape as taken when a handler on the way up stops it", () => {
		listen(document.body, (e) => e.stopPropagation());
		expect(handleBack(document, false, () => {})).toBe("closed");
	});

	it("counts Escape as taken when a handler stops it, as a dialog does", () => {
		listen(document, (e) => e.stopPropagation(), true);
		const goHome = vi.fn();
		expect(handleBack(document, true, goHome)).toBe("closed");
		expect(goHome).not.toHaveBeenCalled();
	});

	it("goes to the home page when nothing takes Escape", () => {
		const goHome = vi.fn();
		expect(handleBack(document, false, goHome)).toBe("home");
		expect(goHome).toHaveBeenCalledOnce();
	});

	it("lets the app close on the home page", () => {
		const goHome = vi.fn();
		expect(handleBack(document, true, goHome)).toBe("exit");
		expect(goHome).not.toHaveBeenCalled();
	});

	it("stops listening once it has an answer", () => {
		const remove = vi.spyOn(document, "removeEventListener");
		handleBack(document, true, () => {});
		expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function));
		remove.mockRestore();
	});
});
