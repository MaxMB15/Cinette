// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { deferred } from "@/test/deferred";
import { AirPlayButton } from "./AirPlayButton";

const button = () => screen.getByRole("button", { name: "AirPlay" }) as HTMLButtonElement;
const notice = () => screen.queryByRole("alert")?.textContent ?? null;

afterEach(() => {
	vi.useRealTimers();
});

describe("AirPlayButton", () => {
	it("sends with the button's position, once at a time", async () => {
		const sending = deferred<string | null>();
		const onSend = vi.fn(() => sending.promise);
		render(<AirPlayButton onSend={onSend} warning="Keep it on." />);
		const rect = new DOMRect(5, 6, 36, 36);
		vi.spyOn(button(), "getBoundingClientRect").mockReturnValue(rect);
		fireEvent.click(button());
		expect(onSend).toHaveBeenCalledWith(rect, expect.any(Function));
		expect(button().disabled).toBe(true);
		// It shows it's working while the item is checked.
		expect(button().getAttribute("aria-busy")).toBe("true");
		expect(button().querySelector(".animate-spin")).not.toBeNull();
		fireEvent.click(button());
		expect(onSend).toHaveBeenCalledTimes(1);
		await act(async () => sending.resolve(null));
		expect(button().disabled).toBe(false);
		expect(button().getAttribute("aria-busy")).toBe("false");
		expect(button().querySelector(".animate-spin")).toBeNull();
		expect(notice()).toBeNull();
	});

	it("says why it couldn't, for a while", async () => {
		vi.useFakeTimers();
		render(
			<AirPlayButton
				onSend={async () => "AirPlay can't play MKV files."}
				warning="Keep it on."
			/>
		);
		await act(async () => fireEvent.click(button()));
		expect(notice()).toBe("AirPlay can't play MKV files.");
		act(() => vi.advanceTimersByTime(5999));
		expect(notice()).toBe("AirPlay can't play MKV files.");
		act(() => vi.advanceTimersByTime(1));
		expect(notice()).toBeNull();
	});

	it("keeps a new reason up for its own while", async () => {
		vi.useFakeTimers();
		const onSend = vi
			.fn<(r: DOMRect) => Promise<string | null>>()
			.mockResolvedValueOnce("First.")
			.mockResolvedValueOnce("Second.");
		render(<AirPlayButton onSend={onSend} warning="Keep it on." />);
		await act(async () => fireEvent.click(button()));
		act(() => vi.advanceTimersByTime(3000));
		await act(async () => fireEvent.click(button()));
		expect(notice()).toBe("Second.");
		act(() => vi.advanceTimersByTime(3000));
		expect(notice()).toBe("Second.");
		act(() => vi.advanceTimersByTime(3000));
		expect(notice()).toBeNull();
	});

	it("clears the last reason when it tries again", async () => {
		const second = deferred<string | null>();
		const onSend = vi
			.fn<(r: DOMRect) => Promise<string | null>>()
			.mockResolvedValueOnce("No.")
			.mockReturnValueOnce(second.promise);
		render(<AirPlayButton onSend={onSend} warning="Keep it on." />);
		await act(async () => fireEvent.click(button()));
		expect(notice()).toBe("No.");
		fireEvent.click(button());
		expect(notice()).toBeNull();
		await act(async () => second.resolve(null));
	});

	it("comes back after a send that throws", async () => {
		render(
			<AirPlayButton onSend={() => Promise.reject(new Error("x"))} warning="Keep it on." />
		);
		await act(async () => fireEvent.click(button()));
		expect(button().disabled).toBe(false);
		expect(notice()).toBe("Couldn't start AirPlay.");
	});
});

describe("AirPlayButton's confirm step", () => {
	it("asks before converting, and answers what the user picks", async () => {
		let asked: Promise<boolean> = Promise.resolve(false);
		const onSend = vi.fn(async (_: DOMRect, confirm: () => Promise<boolean>) => {
			asked = confirm();
			return (await asked) ? null : "Not sent.";
		});
		render(<AirPlayButton onSend={onSend} warning="Keep it on." />);
		await act(async () => fireEvent.click(button()));
		const dialog = screen.getByRole("dialog", { name: "Convert on this device?" });
		expect(dialog.textContent).toContain("Keep it on.");
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send to TV" })));
		expect(await asked).toBe(true);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(notice()).toBeNull();

		await act(async () => fireEvent.click(button()));
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
		expect(await asked).toBe(false);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(notice()).toBe("Not sent.");
	});

	it("takes Escape as a no, and ignores other keys", async () => {
		let asked: Promise<boolean> = Promise.resolve(true);
		const onSend = vi.fn(async (_: DOMRect, confirm: () => Promise<boolean>) => {
			asked = confirm();
			return (await asked) ? null : "Not sent.";
		});
		render(<AirPlayButton onSend={onSend} warning="Keep it on." />);
		await act(async () => fireEvent.click(button()));
		await act(async () => fireEvent.keyDown(window, { key: "Enter" }));
		expect(screen.getByRole("dialog")).toBeTruthy();
		await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
		expect(await asked).toBe(false);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(notice()).toBe("Not sent.");
	});

	it("answers no when it goes while asking, and stops listening for Escape", async () => {
		let asked: Promise<boolean> = Promise.resolve(true);
		const onSend = vi.fn(async (_: DOMRect, confirm: () => Promise<boolean>) => {
			asked = confirm();
			await asked;
			return null;
		});
		const removed = vi.spyOn(window, "removeEventListener");
		const { unmount } = render(<AirPlayButton onSend={onSend} warning="Keep it on." />);
		await act(async () => fireEvent.click(button()));
		unmount();
		expect(await asked).toBe(false);
		expect(removed).toHaveBeenCalledWith("keydown", expect.any(Function));
		removed.mockRestore();
	});

	it("goes quietly when nothing was asked", () => {
		const { unmount } = render(<AirPlayButton onSend={vi.fn()} warning="Keep it on." />);
		expect(() => unmount()).not.toThrow();
	});
});
