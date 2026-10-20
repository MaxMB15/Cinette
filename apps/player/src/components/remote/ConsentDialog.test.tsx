// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { StrictMode } from "react";
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
	remotePendingConsent: vi.fn(() => Promise.resolve(null)),
}));

import { remoteAnswerConsent, remotePendingConsent } from "@/lib/tauri";
import { ARM_MS, ConsentDialog } from "./ConsentDialog";

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

/** The dialog with fake time, so a test can wait out the arm delay. */
const shownOnFakeTime = async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
	render(<ConsentDialog />);
	await act(async () => {});
};

const armed = () => act(() => vi.advanceTimersByTime(ARM_MS));

const QUESTION = "Allow “Max's iPhone” to control this device?";

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
		const dialog = screen.getByRole("dialog", { name: QUESTION });
		expect(screen.getByText("Max's iPhone").tagName, "the name is set apart").toBe("BDI");
		expect(dialog).toHaveTextContent("iPhone on your network");
		expect(screen.getByText("042 917")).toHaveAttribute("aria-hidden");
		expect(screen.getByText("Code 0 4 2 9 1 7")).toHaveClass("sr-only");
		expect(dialog).toHaveTextContent("Expires in 30 s");
		expect(
			screen.getByRole("heading", { name: QUESTION }),
			"focus starts on the question, not on a button"
		).toHaveFocus();
		expect(screen.getByRole("button", { name: "Allow" })).toHaveAttribute(
			"aria-disabled",
			"true"
		);
	});

	it("allows once it has been on screen for a moment", async () => {
		await shownOnFakeTime();
		ask(7);
		const allow = screen.getByRole("button", { name: "Allow" });
		act(() => vi.advanceTimersByTime(ARM_MS - 250));
		fireEvent.click(allow);
		expect(remoteAnswerConsent, "too soon").not.toHaveBeenCalled();
		armed();
		expect(allow).not.toHaveAttribute("aria-disabled");
		fireEvent.click(allow);
		expect(remoteAnswerConsent).toHaveBeenCalledWith(7, true);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("waits again when the window gains focus", async () => {
		await shownOnFakeTime();
		ask(7);
		armed();
		act(() => window.dispatchEvent(new Event("focus")));
		const allow = screen.getByRole("button", { name: "Allow" });
		expect(allow).toHaveAttribute("aria-disabled", "true");
		fireEvent.click(allow);
		expect(remoteAnswerConsent).not.toHaveBeenCalled();
		armed();
		fireEvent.click(allow);
		expect(remoteAnswerConsent).toHaveBeenCalledWith(7, true);
	});

	it("works exactly a moment after it shows", async () => {
		await shownOnFakeTime();
		ask(7);
		armed();
		expect(screen.getByRole("button", { name: "Allow" })).not.toHaveAttribute("aria-disabled");
	});

	it("stops listening for focus once it's answered", async () => {
		const added = vi.spyOn(window, "addEventListener");
		const removed = vi.spyOn(window, "removeEventListener");
		await shown();
		ask(7);
		const listener = added.mock.calls.find(([type]) => type === "focus")?.[1];
		expect(listener).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Deny" }));
		expect(removed).toHaveBeenCalledWith("focus", listener);
		added.mockRestore();
		removed.mockRestore();
	});

	it("ignores a click whose press began before the prompt showed", async () => {
		await shownOnFakeTime();
		ask(7);
		armed();
		const allow = screen.getByRole("button", { name: "Allow" });
		fireEvent.click(allow, { detail: 1 });
		expect(remoteAnswerConsent).not.toHaveBeenCalled();
		fireEvent.pointerDown(allow);
		fireEvent.click(allow, { detail: 1 });
		expect(remoteAnswerConsent).toHaveBeenCalledWith(7, true);
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

	it("shows a request that came before it listened", async () => {
		vi.mocked(remotePendingConsent).mockResolvedValueOnce({
			request: 4,
			deviceId: "abc",
			name: "Max's iPhone",
			deviceType: "iphone",
			code: "042917",
			expiresInMs: 12_000,
		});
		await shown();
		expect(await screen.findByRole("dialog", { name: QUESTION })).toHaveTextContent(
			"Expires in 12 s"
		);
	});

	it("drops a waiting request that answers after its effect was cleaned up", async () => {
		// StrictMode runs the effect, cleans it up and runs it again, so the
		// first answer belongs to an effect that's gone.
		let first: (pending: Awaited<ReturnType<typeof remotePendingConsent>>) => void = () => {};
		vi.mocked(remotePendingConsent)
			.mockReturnValueOnce(new Promise((r) => (first = r)))
			.mockResolvedValueOnce(null);
		render(
			<StrictMode>
				<ConsentDialog />
			</StrictMode>
		);
		await act(async () => {});
		expect(remotePendingConsent).toHaveBeenCalledTimes(2);
		await act(async () =>
			first({
				request: 4,
				deviceId: "old",
				name: "Old",
				deviceType: "mac",
				code: "111111",
				expiresInMs: 10_000,
			})
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("keeps a request an event brought over the older one it asked for", async () => {
		let answer: (pending: Awaited<ReturnType<typeof remotePendingConsent>>) => void = () => {};
		vi.mocked(remotePendingConsent).mockReturnValueOnce(new Promise((r) => (answer = r)));
		await shown();
		ask(5);
		await act(async () =>
			answer({
				request: 4,
				deviceId: "old",
				name: "Old",
				deviceType: "mac",
				code: "111111",
				expiresInMs: 1_000,
			})
		);
		fireEvent.click(screen.getByRole("button", { name: "Deny" }));
		expect(remoteAnswerConsent).toHaveBeenCalledWith(5, false);
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

	it("shows the next request in place of the first, waiting again", async () => {
		await shownOnFakeTime();
		ask(1);
		armed();
		ask(2);
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		expect(
			remoteAnswerConsent,
			"a double click can't allow the next one"
		).not.toHaveBeenCalled();
		armed();
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
		await shownOnFakeTime();
		ask(1);
		armed();
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await act(async () => {});
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
