// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import type { EventCallback } from "@tauri-apps/api/event";

const handlers = vi.hoisted(() => new Map<string, EventCallback<unknown>>());
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn((event: string, handler: EventCallback<unknown>) => {
		handlers.set(event, handler);
		return Promise.resolve(() => handlers.delete(event));
	}),
}));

vi.mock("@/lib/tauri", () => ({
	remoteAnswerConsent: vi.fn(() => Promise.resolve()),
}));

import { remoteAnswerConsent } from "@/lib/tauri";
import { ConsentDialog } from "./ConsentDialog";

const ask = (request = 3, expiresInMs = 30_000) =>
	act(() =>
		handlers.get("remote://consent")!({
			event: "remote://consent",
			id: 1,
			payload: {
				request,
				deviceId: "abc",
				name: "Max's iPhone",
				deviceType: "iphone",
				code: "042917",
				expiresInMs,
			},
		})
	);

const hide = (request: number) =>
	act(() =>
		handlers.get("remote://consent-hidden")!({
			event: "remote://consent-hidden",
			id: 2,
			payload: { request },
		})
	);

const shown = async () => {
	render(<ConsentDialog />);
	await waitFor(() => expect(handlers.size).toBe(2));
};

beforeEach(() => {
	handlers.clear();
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("ConsentDialog", () => {
	it("shows nothing until a device asks", async () => {
		await shown();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("names the device, its type and the code", async () => {
		await shown();
		ask();
		const dialog = screen.getByRole("dialog", {
			name: "Allow Max's iPhone to control this device?",
		});
		expect(dialog).toHaveTextContent("iPhone on your network");
		expect(screen.getByText("042 917")).toHaveAttribute("aria-hidden");
		expect(screen.getByText("Code 0 4 2 9 1 7")).toHaveClass("sr-only");
		expect(dialog).toHaveTextContent("Expires in 30 s");
		expect(
			screen.getByRole("heading", { name: "Allow Max's iPhone to control this device?" }),
			"focus starts on the question, not on a button"
		).toHaveFocus();
		expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
	});

	it("allows", async () => {
		await shown();
		ask(7);
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		expect(remoteAnswerConsent).toHaveBeenCalledWith(7, true);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("denies with the button, Escape or a click outside", async () => {
		await shown();
		ask(1);
		fireEvent.click(screen.getByRole("button", { name: "Deny" }));
		expect(remoteAnswerConsent).toHaveBeenLastCalledWith(1, false);

		ask(2);
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(remoteAnswerConsent).toHaveBeenLastCalledWith(2, false);

		ask(3);
		fireEvent.click(screen.getByRole("dialog").parentElement!);
		expect(remoteAnswerConsent).toHaveBeenLastCalledWith(3, false);
		expect(remoteAnswerConsent).toHaveBeenCalledTimes(3);
	});

	it("ignores a hidden request when none is shown", async () => {
		await shown();
		hide(9);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("stops its clock once it's answered", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
		render(<ConsentDialog />);
		await act(async () => {});
		ask(1);
		expect(vi.getTimerCount()).toBe(1);
		fireEvent.click(screen.getByRole("button", { name: "Deny" }));
		expect(vi.getTimerCount()).toBe(0);
	});

	it("goes away when its request is hidden, but not for another one", async () => {
		await shown();
		ask(5);
		hide(4);
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		hide(5);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(remoteAnswerConsent).not.toHaveBeenCalled();
	});

	it("shows the next request in place of the first", async () => {
		await shown();
		ask(1);
		ask(2);
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		expect(remoteAnswerConsent).toHaveBeenCalledWith(2, true);
	});

	it("counts down and says when it ran out", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
		render(<ConsentDialog />);
		await act(async () => {});
		ask(1, 2_000);
		expect(screen.getByRole("dialog")).toHaveTextContent("Expires in 2 s");
		const said = () =>
			Array.from(document.querySelectorAll("[aria-live]")).map((n) => n.textContent);
		expect(said(), "the count isn't read out").toStrictEqual([""]);
		act(() => vi.advanceTimersByTime(1_000));
		expect(screen.getByRole("dialog")).toHaveTextContent("Expires in 1 s");
		expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
		act(() => vi.advanceTimersByTime(1_000));
		expect(screen.getByRole("dialog")).toHaveTextContent("Expired");
		expect(said()).toStrictEqual(["The request expired."]);
		expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
	});

	it("keeps going when answering fails", async () => {
		vi.mocked(remoteAnswerConsent).mockRejectedValueOnce("gone");
		await shown();
		ask(1);
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await act(async () => {});
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
