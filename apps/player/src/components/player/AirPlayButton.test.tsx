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
		render(<AirPlayButton onSend={onSend} />);
		const rect = new DOMRect(5, 6, 36, 36);
		vi.spyOn(button(), "getBoundingClientRect").mockReturnValue(rect);
		fireEvent.click(button());
		expect(onSend).toHaveBeenCalledWith(rect);
		expect(button().disabled).toBe(true);
		fireEvent.click(button());
		expect(onSend).toHaveBeenCalledTimes(1);
		await act(async () => sending.resolve(null));
		expect(button().disabled).toBe(false);
		expect(notice()).toBeNull();
	});

	it("says why it couldn't, for a while", async () => {
		vi.useFakeTimers();
		render(<AirPlayButton onSend={async () => "AirPlay can't play MKV files."} />);
		await act(async () => fireEvent.click(button()));
		expect(notice()).toBe("AirPlay can't play MKV files.");
		act(() => vi.advanceTimersByTime(5999));
		expect(notice()).toBe("AirPlay can't play MKV files.");
		act(() => vi.advanceTimersByTime(1));
		expect(notice()).toBeNull();
	});

	it("clears the last reason when it tries again", async () => {
		const second = deferred<string | null>();
		const onSend = vi
			.fn<(r: DOMRect) => Promise<string | null>>()
			.mockResolvedValueOnce("No.")
			.mockReturnValueOnce(second.promise);
		render(<AirPlayButton onSend={onSend} />);
		await act(async () => fireEvent.click(button()));
		expect(notice()).toBe("No.");
		fireEvent.click(button());
		expect(notice()).toBeNull();
		await act(async () => second.resolve(null));
	});

	it("comes back after a send that throws", async () => {
		render(<AirPlayButton onSend={() => Promise.reject(new Error("x"))} />);
		await act(async () => fireEvent.click(button()));
		expect(button().disabled).toBe(false);
		expect(notice()).toBe("Couldn't start AirPlay.");
	});
});
