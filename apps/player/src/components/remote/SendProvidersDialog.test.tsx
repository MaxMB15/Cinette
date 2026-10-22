// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import type { Link } from "@/lib/remote-control";
import { createCinetteDestination } from "@/lib/cinette-destination";
import type { RemoteTransferNotice } from "@/lib/tauri";
import type { Provider } from "@/lib/types";

const events = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
vi.mock("@/hooks/useRemoteTarget", () => ({
	useTauriEvent: (event: string, handler: (payload: unknown) => void) => {
		events.set(event, handler);
	},
}));
const channels = vi.hoisted(() => ({ providers: [] as Provider[] }));
vi.mock("@/hooks/useChannels", () => ({ useChannels: () => channels }));
vi.mock("@/lib/tauri", () => ({
	remoteSendProviders: vi.fn(() => Promise.resolve()),
	remoteCancelTransfer: vi.fn(() => Promise.resolve()),
}));

import { remoteCancelTransfer, remoteSendProviders } from "@/lib/tauri";
import { SendProvidersDialog } from "./SendProvidersDialog";

const provider = (id: string, name: string, url = `http://${id}.example`): Provider => ({
	id,
	name,
	type: url.startsWith("file:") ? "m3u" : "xtream",
	url,
	channelCount: 1,
});

const link = (code: string | null = "123456"): Link => ({
	id: 3,
	deviceId: "tv1",
	name: "Living Room",
	phase: { phase: "connected" },
	code,
	features: ["providers"],
	destination: createCinetteDestination("tv1", "Living Room", () => Promise.resolve(1)),
});

const notify = (notice: Partial<RemoteTransferNotice> & { step: string }) =>
	act(() => events.get("remote://transfer")!({ deviceId: "tv1", link: 3, ...notice }));

const onClose = vi.fn();

beforeEach(() => {
	channels.providers = [
		provider("xt-1", "Home"),
		provider("xt-2", "Sports"),
		provider("m3u-f", "Mine", "file:///home/me/a.m3u"),
	];
	onClose.mockClear();
	vi.mocked(remoteSendProviders).mockClear().mockResolvedValue(undefined);
	vi.mocked(remoteCancelTransfer).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

/** Picks providers by name and sends them. */
const pickAndSend = (...names: string[]) => {
	for (const name of names) fireEvent.click(screen.getByRole("checkbox", { name }));
	fireEvent.click(screen.getByRole("button", { name: "Send" }));
};

describe("SendProvidersDialog", () => {
	it("lists the providers, leaving out files on this device", () => {
		render(<SendProvidersDialog link={link()} onClose={onClose} />);
		expect(screen.getByRole("dialog")).toHaveTextContent("Send providers to Living Room");
		expect(screen.getByRole("dialog")).toHaveTextContent("API keys aren't sent.");
		expect(screen.getByRole("checkbox", { name: "Home" })).toBeEnabled();
		const mine = screen.getByRole("checkbox", { name: /Mine/ });
		expect(mine).toBeDisabled();
		expect(screen.getByText("A file on this device")).toBeInTheDocument();
		expect(screen.queryAllByText("A file on this device")).toHaveLength(1);
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
	});

	it("says when there's nothing to send", () => {
		channels.providers = [];
		render(<SendProvidersDialog link={link()} onClose={onClose} />);
		expect(screen.getByText("This device has no providers to send.")).toBeInTheDocument();
		expect(screen.queryByRole("checkbox")).toBeNull();
	});

	it("sends the picked providers, and a second click unpicks one", () => {
		render(<SendProvidersDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("checkbox", { name: "Sports" }));
		expect(screen.getByRole("checkbox", { name: "Sports" })).toBeChecked();
		fireEvent.click(screen.getByRole("checkbox", { name: "Sports" }));
		expect(screen.getByRole("checkbox", { name: "Sports" })).not.toBeChecked();
		pickAndSend("Home", "Sports");
		expect(remoteSendProviders).toHaveBeenCalledWith(3, ["xt-1", "xt-2"]);
		expect(screen.getByRole("status")).toHaveTextContent("Waiting for Living Room to allow it");
	});

	it("shows the code and counts down while the other device asks", () => {
		vi.useFakeTimers();
		render(<SendProvidersDialog link={link()} onClose={onClose} />);
		pickAndSend("Home");
		expect(screen.queryByText(/Expires in/)).toBeNull();
		notify({ step: "pending", expiresInMs: 30_000 });
		expect(screen.getByText("123 456")).toBeInTheDocument();
		expect(screen.getByText("Code 1 2 3 4 5 6")).toBeInTheDocument();
		expect(screen.getByText("Expires in 30 s")).toBeInTheDocument();
		act(() => vi.advanceTimersByTime(10_000));
		expect(screen.getByText("Expires in 20 s")).toBeInTheDocument();
	});

	it("leaves the code out when it has none", () => {
		render(<SendProvidersDialog link={link(null)} onClose={onClose} />);
		pickAndSend("Home");
		expect(screen.queryByText(/Check that this code/)).toBeNull();
	});

	it("shows what became of each provider", () => {
		render(<SendProvidersDialog link={link()} onClose={onClose} />);
		pickAndSend("Home", "Sports");
		notify({ step: "progress", transfer: "t", progress: { state: "saving" } });
		expect(screen.getByRole("status")).toHaveTextContent("Saving on Living Room…");
		expect(screen.queryByText(/Check that this code/)).toBeNull();
		notify({
			step: "progress",
			transfer: "t",
			progress: {
				state: "providersDone",
				data: [
					{ name: "Home", outcome: "added" },
					{ name: "Sports", outcome: "failed", error: "It didn't load." },
				],
			},
		});
		const results = screen.getByRole("list", { name: "Results" });
		expect(results).toHaveTextContent("HomeAdded");
		expect(results).toHaveTextContent("SportsIt didn't load.");
		expect(screen.getByText("It didn't load.")).toHaveClass("text-destructive");
		expect(screen.getByText("Added")).not.toHaveClass("text-destructive");
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		expect(onClose).toHaveBeenCalled();
		expect(remoteCancelTransfer).not.toHaveBeenCalled();
	});

	it("says why the other device didn't take them", () => {
		render(<SendProvidersDialog link={link()} onClose={onClose} />);
		pickAndSend("Home");
		notify({ step: "refused", code: "denied" });
		expect(screen.getByRole("alert")).toHaveTextContent("Living Room said no.");
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalled();
		expect(remoteCancelTransfer).not.toHaveBeenCalled();
	});

	it("says why it couldn't ask", async () => {
		vi.mocked(remoteSendProviders).mockRejectedValue("Pick a provider to send.");
		render(<SendProvidersDialog link={link()} onClose={onClose} />);
		pickAndSend("Home");
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("Pick a provider to send.")
		);
	});

	it("ignores notices for another link", () => {
		render(<SendProvidersDialog link={link()} onClose={onClose} />);
		pickAndSend("Home");
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

	it("cancels a send that's still going when closed", () => {
		render(<SendProvidersDialog link={link()} onClose={onClose} />);
		pickAndSend("Home");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(remoteCancelTransfer).toHaveBeenCalledWith(3);
		expect(onClose).toHaveBeenCalled();
	});

	it("says it's too late once the other device is saving, and doesn't cancel", () => {
		render(<SendProvidersDialog link={link()} onClose={onClose} />);
		pickAndSend("Home");
		notify({ step: "progress", transfer: "t", progress: { state: "saving" } });
		expect(screen.getByText(/too late to stop it now/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalled();
		expect(remoteCancelTransfer).not.toHaveBeenCalled();
	});

	it("counts down from when the other device started asking", () => {
		vi.useFakeTimers();
		render(<SendProvidersDialog link={link()} onClose={onClose} />);
		pickAndSend("Home");
		act(() => vi.advanceTimersByTime(10_000));
		notify({ step: "pending", expiresInMs: 30_000 });
		expect(screen.getByText("Expires in 30 s")).toBeInTheDocument();
	});

	it("lists providers that share a name each on their own line", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		render(<SendProvidersDialog link={link()} onClose={onClose} />);
		pickAndSend("Home");
		notify({
			step: "progress",
			transfer: "t",
			progress: {
				state: "providersDone",
				data: [
					{ name: "Home", outcome: "added" },
					{ name: "Home", outcome: "exists" },
				],
			},
		});
		expect(screen.getAllByRole("listitem")).toHaveLength(2);
		expect(error, "keys are unique").not.toHaveBeenCalled();
		error.mockRestore();
	});

	it("cancels while waiting, but not before sending", () => {
		const { unmount } = render(<SendProvidersDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(remoteCancelTransfer).not.toHaveBeenCalled();
		unmount();
		render(<SendProvidersDialog link={link()} onClose={onClose} />);
		pickAndSend("Home");
		notify({ step: "pending", expiresInMs: 30_000 });
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(remoteCancelTransfer).toHaveBeenCalledTimes(1);
	});

	it("keeps the others picked when one is unpicked", () => {
		render(<SendProvidersDialog link={link()} onClose={onClose} />);
		fireEvent.click(screen.getByRole("checkbox", { name: "Home" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Sports" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Home" }));
		expect(screen.getByRole("checkbox", { name: "Sports" })).toBeChecked();
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		expect(remoteSendProviders).toHaveBeenCalledWith(3, ["xt-2"]);
	});

	it("runs a timer only while it counts down", () => {
		vi.useFakeTimers();
		const { unmount } = render(<SendProvidersDialog link={link()} onClose={onClose} />);
		const before = vi.getTimerCount();
		pickAndSend("Home");
		notify({ step: "pending", expiresInMs: 30_000 });
		expect(vi.getTimerCount()).toBe(before + 1);
		unmount();
		expect(vi.getTimerCount()).toBeLessThanOrEqual(before);
	});
});
