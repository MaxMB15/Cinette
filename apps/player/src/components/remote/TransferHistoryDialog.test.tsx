// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrictMode } from "react";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import type { Link } from "@/lib/remote-control";
import { createCinetteDestination } from "@/lib/cinette-destination";
import type { RemoteTransferNotice, TransferReport } from "@/lib/tauri";

const events = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
vi.mock("@/hooks/useRemoteTarget", () => ({
	useTauriEvent: (event: string, handler: (payload: unknown) => void) => {
		events.set(event, handler);
	},
}));
const progress = vi.hoisted(() => ({ playing: "ch-7" as string | null }));
vi.mock("@/lib/player-progress", () => ({
	saveProgressNow: vi.fn(() => Promise.resolve(progress.playing)),
}));
const os = vi.hoisted(() => ({ platform: "macos" }));
vi.mock("@/lib/platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/platform")>()),
	getPlatform: () => os.platform,
}));
vi.mock("@/lib/tauri", () => ({
	remoteAskHistory: vi.fn(() => Promise.resolve()),
	remoteCancelTransfer: vi.fn(() => Promise.resolve()),
	remoteHistoryCounts: vi.fn(() =>
		Promise.resolve({ history: 12, positions: 3, favorites: 5, pins: 2 })
	),
	remoteStartImport: vi.fn(() => Promise.resolve()),
}));

import { saveProgressNow } from "@/lib/player-progress";
import {
	remoteAskHistory,
	remoteCancelTransfer,
	remoteHistoryCounts,
	remoteStartImport,
} from "@/lib/tauri";
import { TransferHistoryDialog } from "./TransferHistoryDialog";

const link = (code: string | null = "123456"): Link => ({
	id: 3,
	deviceId: "tv1",
	name: "Living Room",
	phase: { phase: "connected" },
	code,
	features: ["history"],
	destination: createCinetteDestination("tv1", "Living Room", () => Promise.resolve(1)),
});

const notify = (notice: Partial<RemoteTransferNotice> & { step: string }) =>
	act(() => events.get("remote://transfer")!({ deviceId: "tv1", link: 3, ...notice }));

const tally = (added = 0, updated = 0, unchanged = 0) => ({ added, updated, unchanged });
const report = (extra: Partial<TransferReport> = {}): TransferReport => ({
	history: tally(2),
	positions: tally(),
	favorites: tally(),
	pins: tally(),
	unmatched: [],
	unmatchedTotal: 0,
	...extra,
});

const onClose = vi.fn();

beforeEach(() => {
	onClose.mockClear();
	progress.playing = "ch-7";
	vi.mocked(remoteAskHistory).mockClear().mockResolvedValue(undefined);
	vi.mocked(remoteCancelTransfer).mockClear();
	vi.mocked(remoteHistoryCounts).mockClear();
	vi.mocked(remoteStartImport).mockClear().mockResolvedValue(undefined);
	vi.mocked(saveProgressNow).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	os.platform = "macos";
});

const status = () => screen.getByRole("status");

describe("TransferHistoryDialog", () => {
	it("shows what this device would send, and the privacy note", async () => {
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		await waitFor(() =>
			expect(status()).toHaveTextContent(
				"This device has watch history (12), saved places (3), favorites (5) and pinned groups (2)."
			)
		);
		expect(remoteHistoryCounts).toHaveBeenCalledWith({
			history: true,
			favorites: true,
			pins: true,
		});
		expect(screen.getByRole("dialog")).toHaveTextContent("Provider logins, API keys");
		expect(screen.getByRole("radio", { name: "Send to Living Room" })).toBeChecked();
	});

	it("counts again for what's picked, and says when nothing is", async () => {
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("checkbox", { name: "Favorites" }));
		await waitFor(() =>
			expect(remoteHistoryCounts).toHaveBeenLastCalledWith({
				history: true,
				favorites: false,
				pins: true,
			})
		);
		fireEvent.click(screen.getByRole("checkbox", { name: "Watch history and saved places" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Pinned groups" }));
		expect(status()).toHaveTextContent("Pick something to copy.");
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
	});

	it("shows the kinds without counts when they can't be read", async () => {
		vi.mocked(remoteHistoryCounts).mockRejectedValueOnce("down");
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		await waitFor(() => expect(remoteHistoryCounts).toHaveBeenCalled());
		expect(status()).toHaveTextContent(
			"This device has watch history, saved places, favorites and pinned groups."
		);
	});

	it("saves the player's place, then sends", async () => {
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() =>
			expect(remoteAskHistory).toHaveBeenCalledWith(
				3,
				"send",
				{ history: true, favorites: true, pins: true },
				"ch-7"
			)
		);
		expect(saveProgressNow).toHaveBeenCalled();
		expect(status()).toHaveTextContent("Waiting for Living Room to allow it");
		expect(screen.getByText("123 456")).toBeInTheDocument();
	});

	it("counts down while the other device asks, and leaves out a code it has none of", () => {
		vi.useFakeTimers();
		render(<TransferHistoryDialog link={link(null)} onClose={onClose} />);
		act(() => {
			fireEvent.click(screen.getByRole("button", { name: "Send" }));
		});
		notify({ step: "pending", expiresInMs: 30_000 });
		expect(screen.getByText("Expires in 30 s")).toBeInTheDocument();
		act(() => vi.advanceTimersByTime(10_000));
		expect(screen.getByText("Expires in 20 s")).toBeInTheDocument();
		expect(screen.queryByText(/Check that this code/)).toBeNull();
	});

	it("shows the progress and then the result, with what didn't match", async () => {
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(remoteAskHistory).toHaveBeenCalled());
		notify({
			step: "progress",
			transfer: "t",
			progress: { state: "sending", data: { done: 2, total: 5 } },
		});
		expect(status()).toHaveTextContent("Sending… 2 of 5");
		notify({ step: "progress", transfer: "t", progress: { state: "saving" } });
		expect(status()).toHaveTextContent("Saving…");
		notify({
			step: "progress",
			transfer: "t",
			progress: {
				state: "done",
				data: report({
					unmatched: [{ name: "Heat", kind: "movie", reason: "missing" }],
					unmatchedTotal: 3,
				}),
			},
		});
		expect(screen.getByRole("list", { name: "Copied" })).toHaveTextContent(
			"Watch history: 2 added"
		);
		const unmatched = screen.getByRole("list", { name: "Couldn't match" });
		expect(unmatched).toHaveTextContent("Heat");
		expect(unmatched).toHaveTextContent("and 2 more");
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		expect(onClose).toHaveBeenCalled();
		expect(remoteCancelTransfer).not.toHaveBeenCalled();
	});

	it("says on a phone to keep Cinette open while it waits and moves, until it's saving", async () => {
		os.platform = "ios";
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(remoteAskHistory).toHaveBeenCalled());
		notify({ step: "pending", expiresInMs: 30_000 });
		expect(screen.getByText(/Keep Cinette open until it's done/)).toBeInTheDocument();
		notify({
			step: "progress",
			transfer: "t",
			progress: { state: "sending", data: { done: 1, total: 5 } },
		});
		expect(screen.getByText(/Keep Cinette open until it's done/)).toBeInTheDocument();
		notify({ step: "progress", transfer: "t", progress: { state: "saving" } });
		expect(screen.queryByText(/Keep Cinette open/)).toBeNull();
		expect(screen.getByText(/too late to stop it now/)).toBeInTheDocument();
	});

	it("says nothing about staying open on a computer", async () => {
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(remoteAskHistory).toHaveBeenCalled());
		notify({ step: "pending", expiresInMs: 30_000 });
		notify({
			step: "progress",
			transfer: "t",
			progress: { state: "sending", data: { done: 1, total: 5 } },
		});
		expect(screen.queryByText(/Keep Cinette open/)).toBeNull();
	});

	it("leaves out the unmatched list when everything matched", async () => {
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(remoteAskHistory).toHaveBeenCalled());
		notify({ step: "progress", transfer: "t", progress: { state: "done", data: report() } });
		expect(screen.queryByRole("list", { name: "Couldn't match" })).toBeNull();
	});

	it("imports after showing what the other device has", async () => {
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("radio", { name: "Import from Living Room" }));
		expect(status()).toHaveTextContent(
			"Living Room shows what it has once you allow it there."
		);
		fireEvent.click(screen.getByRole("button", { name: "Ask" }));
		await waitFor(() =>
			expect(remoteAskHistory).toHaveBeenCalledWith(
				3,
				"import",
				{ history: true, favorites: true, pins: true },
				null
			)
		);
		expect(saveProgressNow, "only a send saves the place").not.toHaveBeenCalled();
		notify({
			step: "preview",
			transfer: "t9",
			counts: { history: 4, positions: 1, favorites: 2, pins: 0 },
		});
		expect(status()).toHaveTextContent(
			"Living Room has watch history (4), saved places (1), favorites (2) and pinned groups (0). Import it to this device?"
		);
		fireEvent.click(screen.getByRole("button", { name: "Import" }));
		expect(remoteStartImport).toHaveBeenCalledWith(3, "t9");
		expect(status()).toHaveTextContent("Receiving…");
		notify({
			step: "progress",
			transfer: "t9",
			progress: { state: "receiving", data: { received: 1 } },
		});
		expect(status()).toHaveTextContent("Receiving…");
		// The send direction radio comes back to send.
	});

	it("says why it couldn't ask, or start", async () => {
		vi.mocked(remoteAskHistory).mockRejectedValueOnce("Not connected to that device.");
		const { unmount } = render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("Not connected to that device.")
		);
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalled();
		unmount();

		vi.mocked(remoteStartImport).mockRejectedValueOnce("gone");
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("radio", { name: "Import from Living Room" }));
		fireEvent.click(screen.getByRole("button", { name: "Ask" }));
		await waitFor(() => expect(remoteAskHistory).toHaveBeenCalled());
		notify({
			step: "preview",
			transfer: "t9",
			counts: { history: 0, positions: 0, favorites: 0, pins: 0 },
		});
		fireEvent.click(screen.getByRole("button", { name: "Import" }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("gone"));
	});

	it("says when the other device said no", async () => {
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(remoteAskHistory).toHaveBeenCalled());
		notify({ step: "refused", code: "denied" });
		expect(screen.getByRole("alert")).toHaveTextContent("Living Room said no.");
	});

	it("ignores notices for another link", async () => {
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(remoteAskHistory).toHaveBeenCalled());
		act(() =>
			events.get("remote://transfer")!({
				deviceId: "x",
				link: 9,
				step: "refused",
				code: "denied",
			})
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("cancels a transfer that's going on when closed, but not before or after", async () => {
		const first = render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(remoteCancelTransfer).not.toHaveBeenCalled();
		first.unmount();

		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("radio", { name: "Import from Living Room" }));
		fireEvent.click(screen.getByRole("button", { name: "Ask" }));
		await waitFor(() => expect(remoteAskHistory).toHaveBeenCalled());
		notify({
			step: "preview",
			transfer: "t9",
			counts: { history: 0, positions: 0, favorites: 0, pins: 0 },
		});
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(remoteCancelTransfer).toHaveBeenCalledWith(3);
	});

	it("says it's too late once it's being written, and doesn't cancel", async () => {
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(remoteAskHistory).toHaveBeenCalled());
		notify({
			step: "progress",
			transfer: "t",
			progress: { state: "sending", data: { done: 2, total: 5 } },
		});
		expect(screen.queryByText(/too late to stop it now/)).toBeNull();
		// While it moves, it can still be stopped.
		expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
		notify({ step: "progress", transfer: "t", progress: { state: "saving" } });
		expect(screen.getByText(/too late to stop it now/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalled();
		expect(remoteCancelTransfer).not.toHaveBeenCalled();
	});

	it("cancels while waiting or moving too", async () => {
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(remoteAskHistory).toHaveBeenCalled());
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(remoteCancelTransfer).toHaveBeenCalledTimes(1);
	});

	it("names this device as the one that keeps an import", () => {
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		expect(screen.getByRole("dialog")).toHaveTextContent("it stays on Living Room");
		fireEvent.click(screen.getByRole("radio", { name: "Import from Living Room" }));
		expect(screen.getByRole("dialog")).toHaveTextContent("it stays on this device");
		expect(screen.getByRole("dialog")).toHaveTextContent("Nothing is deleted on Living Room.");
	});

	it("counts only for a send, and keeps the newest count", async () => {
		let first: (c: unknown) => void = () => {};
		vi.mocked(remoteHistoryCounts).mockImplementationOnce(
			() => new Promise((resolve) => (first = resolve as (c: unknown) => void))
		);
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("checkbox", { name: "Favorites" }));
		await waitFor(() =>
			expect(status()).toHaveTextContent(
				"This device has watch history (12), saved places (3)"
			)
		);
		await act(async () => first({ history: 99, positions: 99, favorites: 99, pins: 99 }));
		expect(status()).not.toHaveTextContent("99");
		fireEvent.click(screen.getByRole("radio", { name: "Import from Living Room" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Favorites" }));
		expect(remoteHistoryCounts).toHaveBeenCalledTimes(2);
	});

	it("forgets the counts once they can't be read", async () => {
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		await waitFor(() => expect(status()).toHaveTextContent("(12)"));
		vi.mocked(remoteHistoryCounts).mockRejectedValueOnce("down");
		fireEvent.click(screen.getByRole("checkbox", { name: "Favorites" }));
		await waitFor(() =>
			expect(status()).toHaveTextContent("This device has watch history, saved places")
		);
	});

	it("doesn't ask once it's closed while the player saves its place", async () => {
		let saved: (playing: string | null) => void = () => {};
		vi.mocked(saveProgressNow).mockImplementationOnce(
			() => new Promise((resolve) => (saved = resolve))
		);
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await act(async () => saved("ch-7"));
		expect(remoteAskHistory).not.toHaveBeenCalled();
	});

	it("doesn't ask once it's gone while the player saves its place", async () => {
		let saved: (playing: string | null) => void = () => {};
		vi.mocked(saveProgressNow).mockImplementationOnce(
			() => new Promise((resolve) => (saved = resolve))
		);
		const { unmount } = render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		unmount();
		await act(async () => saved("ch-7"));
		expect(remoteAskHistory).not.toHaveBeenCalled();
	});

	it("withdraws an ask that was closed while it went out", async () => {
		let asked: () => void = () => {};
		vi.mocked(remoteAskHistory).mockImplementationOnce(
			() => new Promise<void>((resolve) => (asked = resolve))
		);
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(remoteAskHistory).toHaveBeenCalled());
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(remoteCancelTransfer).toHaveBeenCalledTimes(1);
		await act(async () => asked());
		expect(remoteCancelTransfer).toHaveBeenCalledTimes(2);
	});

	it("shows no countdown until the other device asks, nor after it allows", async () => {
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(remoteAskHistory).toHaveBeenCalled());
		expect(screen.queryByText(/Expires in/)).toBeNull();
		notify({ step: "pending", expiresInMs: 30_000 });
		expect(screen.getByText(/Expires in/)).toBeInTheDocument();
		notify({ step: "granted", transfer: "t" });
		expect(screen.queryByText(/Expires in/)).toBeNull();
		expect(status()).toHaveTextContent("Sending…");
		expect(status()).not.toHaveTextContent("of");
	});

	it("doesn't cancel when closed after it finished or failed, and can try again", async () => {
		const first = render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(remoteAskHistory).toHaveBeenCalled());
		notify({ step: "progress", transfer: "t", progress: { state: "done", data: report() } });
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
		first.unmount();

		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(remoteAskHistory).toHaveBeenCalledTimes(2));
		notify({ step: "refused", code: "busy" });
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(remoteAskHistory).toHaveBeenCalledTimes(3));
		notify({ step: "refused", code: "busy" });
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(2);
		expect(remoteCancelTransfer).not.toHaveBeenCalled();
	});

	it("still asks under StrictMode, which mounts it twice", async () => {
		render(
			<StrictMode>
				<TransferHistoryDialog link={link()} onClose={onClose} />
			</StrictMode>
		);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(remoteAskHistory).toHaveBeenCalled());
	});

	it("can send any one kind alone", () => {
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		const send = () => screen.getByRole("button", { name: "Send" });
		fireEvent.click(screen.getByRole("checkbox", { name: "Watch history and saved places" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Favorites" }));
		expect(send()).toBeEnabled();
		fireEvent.click(screen.getByRole("checkbox", { name: "Favorites" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Pinned groups" }));
		expect(send()).toBeEnabled();
		expect(send()).toHaveClass("bg-primary");
		expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("hover:bg-accent");
	});

	it("goes back to sending, with its counts", async () => {
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("radio", { name: "Import from Living Room" }));
		fireEvent.click(screen.getByRole("radio", { name: "Send to Living Room" }));
		expect(screen.getByRole("radio", { name: "Send to Living Room" })).toBeChecked();
		await waitFor(() =>
			expect(status()).toHaveTextContent("This device has watch history (12)")
		);
		expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
	});

	it("reads the code out one digit at a time", async () => {
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(remoteAskHistory).toHaveBeenCalled());
		expect(screen.getByText("Code 1 2 3 4 5 6")).toBeInTheDocument();
	});

	it("lists each unmatched item once, with no line for the rest when there's none", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(remoteAskHistory).toHaveBeenCalled());
		const heat = { name: "Heat", kind: "movie" as const, reason: "missing" as const };
		notify({
			step: "progress",
			transfer: "t",
			progress: {
				state: "done",
				data: report({ unmatched: [heat, heat], unmatchedTotal: 2 }),
			},
		});
		const unmatched = screen.getByRole("list", { name: "Couldn't match" });
		expect(within(unmatched).getAllByRole("listitem")).toHaveLength(2);
		expect(error, "keys are unique").not.toHaveBeenCalled();
		error.mockRestore();
	});

	it("keeps newer counts when an older read fails late", async () => {
		let fail: (e: unknown) => void = () => {};
		vi.mocked(remoteHistoryCounts).mockImplementationOnce(
			() => new Promise((_, reject) => (fail = reject))
		);
		render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("checkbox", { name: "Favorites" }));
		await waitFor(() => expect(status()).toHaveTextContent("(12)"));
		await act(async () => fail("down"));
		expect(status()).toHaveTextContent("(12)");
	});

	it("runs a timer only while it counts down", async () => {
		vi.useFakeTimers();
		const { unmount } = render(<TransferHistoryDialog link={link()} onClose={onClose} />);
		const before = vi.getTimerCount();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Send" }));
		});
		notify({ step: "pending", expiresInMs: 30_000 });
		expect(vi.getTimerCount()).toBe(before + 1);
		unmount();
		expect(vi.getTimerCount()).toBeLessThanOrEqual(before);
	});
});
