// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import type { RemoteControlState, Link } from "@/lib/remote-control";
import { createCinetteDestination, type RemoteSnapshot } from "@/lib/cinette-destination";
import type { RemoteDevice } from "@/lib/tauri";

const control = vi.hoisted(() => ({
	state: { devices: [], link: null, ended: null } as unknown as RemoteControlState,
	connect: vi.fn(),
	leave: vi.fn(),
}));
vi.mock("@/hooks/useRemoteControl", () => ({
	useRemoteControl: () => ({
		...control.state,
		connect: control.connect,
		leave: control.leave,
	}),
}));

const sessions = vi.hoisted(() => ({ list: [] as unknown[] }));
const tauriEvents = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
vi.mock("@/hooks/useRemoteTarget", () => ({
	useRemoteSessions: () => sessions.list,
	useTauriEvent: (event: string, handler: (payload: unknown) => void) => {
		tauriEvents.set(event, handler);
	},
}));
vi.mock("@/components/remote/TransferHistoryDialog", () => ({
	TransferHistoryDialog: ({ onClose }: { onClose: () => void }) => (
		<button type="button" onClick={onClose}>
			Close transfer
		</button>
	),
}));
vi.mock("@/components/remote/SendProvidersDialog", () => ({
	SendProvidersDialog: ({ onClose }: { onClose: () => void }) => (
		<button type="button" onClick={onClose}>
			Close sending
		</button>
	),
}));
const os = vi.hoisted(() => ({ platform: "macos" }));
vi.mock("@/lib/platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/platform")>()),
	getPlatform: () => os.platform,
}));
vi.mock("@/lib/tauri", () => ({
	remoteDisconnect: vi.fn(() => Promise.resolve()),
	remoteLocalNetworkDenied: vi.fn(() => Promise.resolve(false)),
	remoteOpen: vi.fn(() => Promise.resolve()),
	getVpnActive: vi.fn(() => Promise.resolve(false)),
}));

import { getVpnActive, remoteDisconnect, remoteLocalNetworkDenied, remoteOpen } from "@/lib/tauri";
import { LOCAL_NETWORK_DENIED, LOCAL_NETWORK_DENIED_IOS } from "@/lib/remote-devices";
import { VPN_HINT } from "@/lib/cast";
import {
	ConnectStatusDialog,
	ControllersBar,
	DevicesButton,
	LEAVE_FAILED,
	LOOKING,
	LOOKING_MS,
	NONE_FOUND,
	ProvidersAddedNotice,
	RemoteBar,
} from "./RemoteControls";
import { createTestQueryClient, wrapperFor } from "@/test/query";

const tv: RemoteDevice = {
	deviceId: "tv1",
	name: "Living Room",
	deviceType: "fire-tv",
	controlAllowed: true,
	available: true,
};
const den: RemoteDevice = {
	deviceId: "den1",
	name: "Den",
	deviceType: "mac",
	controlAllowed: false,
	available: true,
};

const snapshot: RemoteSnapshot = {
	status: "playing",
	item: { id: "live-7", name: "News at Ten", contentType: "live", group: "UK" },
	position: 0,
	duration: 0,
	volume: 50,
	subtitles: [],
	subtitleId: null,
	audio: [],
	audioId: null,
	capabilities: {
		pause: true,
		seek: false,
		volume: true,
		subtitles: false,
		audioTracks: false,
		resumeAt: false,
	},
	error: null,
};

const send = vi.fn<(command: unknown) => Promise<number>>(() => Promise.resolve(1));

const link = (phase: Link["phase"], code: string | null = null, features: string[] = []): Link => {
	const destination = createCinetteDestination("tv1", "Living Room", send);
	return { id: 3, deviceId: "tv1", name: "Living Room", phase, code, features, destination };
};

/** A leave as the store does it: the link goes here at once, and then
 *  the backend fails. */
const leavesThenFails = () => {
	control.state = { ...control.state, link: null };
	return Promise.reject("unavailable");
};

beforeEach(() => {
	control.state = { devices: [tv, den], link: null, ended: null };
	control.connect.mockReset().mockResolvedValue(undefined);
	control.leave.mockReset().mockResolvedValue(undefined);
	send.mockClear();
});

afterEach(() => {
	os.platform = "macos";
});

describe("DevicesButton", () => {
	it("opens the picker with this device and the Cinette devices", () => {
		render(<DevicesButton />);
		expect(screen.queryByRole("dialog"), "closed until asked").toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Devices" }));
		const picker = screen.getByRole("dialog", { name: "Play on" });
		expect(within(picker).getByRole("button", { name: /This device/ })).toHaveAttribute(
			"aria-current",
			"true"
		);
		expect(within(picker).getByRole("button", { name: /Den/ })).toHaveAttribute(
			"aria-disabled",
			"true"
		);
	});

	it("says when macOS keeps it off the local network, checking at each opening", async () => {
		vi.mocked(remoteLocalNetworkDenied).mockResolvedValueOnce(true);
		render(<DevicesButton />);
		const open = () => fireEvent.click(screen.getByRole("button", { name: "Devices" }));
		open();
		const picker = screen.getByRole("dialog", { name: "Play on" });
		expect(await within(picker).findByRole("status")).toHaveTextContent(LOCAL_NETWORK_DENIED);
		expect(LOCAL_NETWORK_DENIED).toMatch(/Local Network in System Settings/);
		fireEvent.keyDown(picker, { key: "Escape" });
		// Allowed meanwhile.
		open();
		await waitFor(() => expect(remoteLocalNetworkDenied).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
	});

	it("says where iOS allows the local network", async () => {
		os.platform = "ios";
		vi.mocked(remoteLocalNetworkDenied).mockResolvedValueOnce(true);
		render(<DevicesButton />);
		fireEvent.click(screen.getByRole("button", { name: "Devices" }));
		expect(await screen.findByRole("status")).toHaveTextContent(LOCAL_NETWORK_DENIED_IOS);
		expect(LOCAL_NETWORK_DENIED_IOS).toMatch(/in Settings, Privacy & Security, Local Network/);
	});

	it("starts remote control before it asks about the network", async () => {
		const order: string[] = [];
		vi.mocked(remoteOpen).mockImplementationOnce(async () => {
			order.push("open");
		});
		vi.mocked(remoteLocalNetworkDenied).mockImplementationOnce(async () => {
			order.push("denied?");
			return false;
		});
		render(<DevicesButton />);
		fireEvent.click(screen.getByRole("button", { name: "Devices" }));
		await waitFor(() => expect(order).toEqual(["open", "denied?"]));
	});

	it("still asks about the network when starting remote control failed", async () => {
		vi.mocked(remoteOpen).mockRejectedValueOnce("couldn't start");
		vi.mocked(remoteLocalNetworkDenied).mockResolvedValueOnce(true);
		render(<DevicesButton />);
		fireEvent.click(screen.getByRole("button", { name: "Devices" }));
		expect(await screen.findByRole("status")).toHaveTextContent(LOCAL_NETWORK_DENIED);
	});

	it("says nothing about the network until it knows, or when it can't tell", async () => {
		vi.mocked(remoteLocalNetworkDenied)
			.mockImplementationOnce(() => new Promise(() => {}))
			.mockResolvedValueOnce(true)
			.mockRejectedValueOnce("unavailable");
		render(<DevicesButton />);
		const open = () => fireEvent.click(screen.getByRole("button", { name: "Devices" }));
		const close = () =>
			fireEvent.keyDown(screen.getByRole("dialog", { name: "Play on" }), { key: "Escape" });
		open();
		expect(screen.queryByRole("status"), "not before it knows").toBeNull();
		close();
		open();
		expect(await screen.findByRole("status")).toHaveTextContent(LOCAL_NETWORK_DENIED);
		close();
		open();
		await waitFor(() => expect(remoteLocalNetworkDenied).toHaveBeenCalledTimes(3));
		await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
	});

	it("asks the device chosen for control", () => {
		const kitchen = { ...tv, deviceId: "k1", name: "Kitchen" };
		control.state = { ...control.state, devices: [tv, kitchen] };
		render(<DevicesButton />);
		const button = screen.getByRole("button", { name: "Devices" });
		expect(button).toHaveAttribute("title", "Play on another device");
		fireEvent.click(button);
		fireEvent.click(screen.getByRole("button", { name: /Kitchen/ }));
		expect(control.connect).toHaveBeenCalledWith(kitchen);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("clears an earlier error when asking again", async () => {
		control.connect.mockRejectedValueOnce("Couldn't reach it.");
		render(<DevicesButton />);
		const open = () => fireEvent.click(screen.getByRole("button", { name: "Devices" }));
		open();
		fireEvent.click(screen.getByRole("button", { name: /Living Room/ }));
		await screen.findByRole("status");
		open();
		fireEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", { name: /Living Room/ })
		);
		await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
	});

	it("says why a request couldn't start, until dismissed", async () => {
		control.connect.mockRejectedValue("That device isn't on the network now.");
		render(<DevicesButton />);
		fireEvent.click(screen.getByRole("button", { name: "Devices" }));
		fireEvent.click(screen.getByRole("button", { name: /Living Room/ }));
		expect(await screen.findByRole("status")).toHaveTextContent(
			"That device isn't on the network now."
		);
		expect(screen.getByRole("button", { name: "Dismiss" })).toHaveClass(
			"inline-flex",
			"pointer-coarse:min-h-11",
			"pointer-coarse:min-w-11"
		);
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("shows which device plays, and choosing this device returns", async () => {
		control.state = { ...control.state, link: link({ phase: "connected" }) };
		render(<DevicesButton />);
		const button = screen.getByRole("button", { name: "Devices, playing on Living Room" });
		expect(button).toHaveAttribute("title", "Playing on Living Room");
		expect(button).toHaveClass("text-primary");
		fireEvent.click(button);
		const picker = screen.getByRole("dialog", { name: "Play on" });
		expect(within(picker).getByRole("button", { name: /Living Room/ })).toHaveAttribute(
			"aria-current",
			"true"
		);
		fireEvent.click(within(picker).getByRole("button", { name: /This device/ }));
		expect(control.leave).toHaveBeenCalledTimes(1);
		expect(control.connect).not.toHaveBeenCalled();
		await act(async () => {});
		expect(screen.queryByRole("status"), "it worked, so nothing to say").toBeNull();
	});

	it("says when ending the session from the picker didn't work", async () => {
		control.leave.mockImplementationOnce(leavesThenFails);
		control.state = { ...control.state, link: link({ phase: "connected" }) };
		const { rerender } = render(<DevicesButton />);
		fireEvent.click(screen.getByRole("button", { name: "Devices, playing on Living Room" }));
		fireEvent.click(screen.getByRole("button", { name: /This device/ }));
		rerender(<DevicesButton />);
		expect(await screen.findByRole("status")).toHaveTextContent(LEAVE_FAILED);
		expect(screen.getByRole("status")).toHaveClass("bottom-20");
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("says a VPN may hide the other devices when it found none", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		vi.mocked(getVpnActive).mockResolvedValueOnce(true);
		control.state = { ...control.state, devices: [] };
		render(<DevicesButton />);
		fireEvent.click(screen.getByRole("button", { name: "Devices" }));
		await act(async () => {});
		act(() => vi.advanceTimersByTime(LOOKING_MS));
		expect(screen.getByRole("status")).toHaveTextContent(`${NONE_FOUND} ${VPN_HINT}`);
		// It asks again each time, and a check that fails counts as no VPN.
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		vi.mocked(getVpnActive).mockRejectedValueOnce(new Error("no"));
		fireEvent.click(screen.getByRole("button", { name: "Devices" }));
		await act(async () => {});
		act(() => vi.advanceTimersByTime(LOOKING_MS));
		expect(screen.getByRole("status").textContent).toBe(NONE_FOUND);
		vi.useRealTimers();
	});

	it("gives no VPN hint before it knows, or when there's no VPN", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		control.state = { ...control.state, devices: [] };
		vi.mocked(getVpnActive).mockReturnValueOnce(new Promise(() => {}));
		const first = render(<DevicesButton />);
		fireEvent.click(screen.getByRole("button", { name: "Devices" }));
		await act(async () => {});
		act(() => vi.advanceTimersByTime(LOOKING_MS));
		expect(screen.getByRole("status").textContent).toBe(NONE_FOUND);
		first.unmount();
		vi.mocked(getVpnActive).mockResolvedValueOnce(false);
		render(<DevicesButton />);
		fireEvent.click(screen.getByRole("button", { name: "Devices" }));
		await act(async () => {});
		act(() => vi.advanceTimersByTime(LOOKING_MS));
		expect(screen.getByRole("status").textContent).toBe(NONE_FOUND);
		vi.useRealTimers();
	});

	it("looks for a moment before it says no other device was found", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		control.state = { ...control.state, devices: [] };
		render(<DevicesButton />);
		const open = () => fireEvent.click(screen.getByRole("button", { name: "Devices" }));
		const close = () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		open();
		await act(async () => {});
		expect(screen.getByRole("status")).toHaveTextContent(LOOKING);
		act(() => vi.advanceTimersByTime(LOOKING_MS - 1));
		expect(screen.getByRole("status")).toHaveTextContent(LOOKING);
		act(() => vi.advanceTimersByTime(1));
		expect(screen.getByRole("status")).toHaveTextContent(NONE_FOUND);
		// Opened again, it looks again.
		close();
		open();
		expect(screen.getByRole("status")).toHaveTextContent(LOOKING);
		// Closed before its time and opened later, the old wait doesn't count.
		act(() => vi.advanceTimersByTime(LOOKING_MS - 1000));
		close();
		act(() => vi.advanceTimersByTime(LOOKING_MS));
		open();
		expect(screen.getByRole("status")).toHaveTextContent(LOOKING);
		act(() => vi.advanceTimersByTime(LOOKING_MS - 1));
		expect(screen.getByRole("status")).toHaveTextContent(LOOKING);
		vi.useRealTimers();
	});

	it("says a device set to Never allow doesn't allow it", () => {
		control.state = {
			...control.state,
			devices: [{ ...tv, deviceId: "n1", name: "Garage", controlAllowed: false }],
		};
		render(<DevicesButton />);
		fireEvent.click(screen.getByRole("button", { name: "Devices" }));
		expect(screen.getByRole("button", { name: /Garage/ })).toHaveTextContent(
			"Doesn't allow remote control"
		);
	});

	it("does nothing for the device already chosen", () => {
		render(<DevicesButton />);
		fireEvent.click(screen.getByRole("button", { name: "Devices" }));
		fireEvent.click(screen.getByRole("button", { name: /This device/ }));
		expect(control.leave).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("closes the picker with Escape", () => {
		render(<DevicesButton />);
		fireEvent.click(screen.getByRole("button", { name: "Devices" }));
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});

describe("ConnectStatusDialog", () => {
	it("shows nothing without a link, or once connected", () => {
		const { rerender } = render(<ConnectStatusDialog />);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.queryByRole("status"), "and no notice").toBeNull();
		control.state = { ...control.state, link: link({ phase: "connected" }) };
		rerender(<ConnectStatusDialog />);
		expect(screen.queryByRole("dialog")).toBeNull();
		control.state = { ...control.state, link: link({ phase: "reconnecting", attempt: 1 }) };
		rerender(<ConnectStatusDialog />);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("says it's connecting before there's a code", () => {
		control.state = { ...control.state, link: link({ phase: "connecting" }) };
		render(<ConnectStatusDialog />);
		const dialog = screen.getByRole("dialog", { name: "Connecting to Living Room" });
		expect(dialog).toHaveTextContent("Looking for it on the network");
	});

	it("shows the code to compare while the other device decides", () => {
		control.state = {
			...control.state,
			link: link({ phase: "pending", expiresInMs: 30_000 }, "042917"),
		};
		render(<ConnectStatusDialog />);
		const dialog = screen.getByRole("dialog", { name: "Waiting for Living Room to allow it" });
		expect(dialog).toHaveTextContent("Check that this code matches the one on that device.");
		expect(screen.getByText("Code 0 4 2 9 1 7")).toHaveClass("sr-only");
		expect(screen.getByText("042 917")).toHaveAttribute("aria-hidden");
	});

	it("shows the code as soon as the handshake gives it", () => {
		control.state = {
			...control.state,
			link: link({ phase: "verifying", code: "123456", name: "Living Room" }, "123456"),
		};
		render(<ConnectStatusDialog />);
		screen.getByRole("dialog", { name: "Connecting to Living Room" });
		expect(screen.getByText("Code 1 2 3 4 5 6")).toBeInTheDocument();
	});

	it("cancels with the button or Escape", () => {
		control.state = { ...control.state, link: link({ phase: "connecting" }) };
		render(<ConnectStatusDialog />);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(control.leave).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("says so when cancelling fails, after the dialog has gone", async () => {
		control.leave.mockImplementationOnce(leavesThenFails);
		control.state = { ...control.state, link: link({ phase: "pending", expiresInMs: 1 }) };
		const { rerender } = render(<ConnectStatusDialog />);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		rerender(<ConnectStatusDialog />);
		expect(await screen.findByRole("status")).toHaveTextContent(LEAVE_FAILED);
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("sets the device's name apart from the sentence", () => {
		control.state = { ...control.state, link: link({ phase: "connecting" }) };
		render(<ConnectStatusDialog />);
		expect(screen.getByText("Living Room").tagName).toBe("BDI");
	});
});

describe("RemoteBar", () => {
	it("offers to send providers to a connected device that takes them", () => {
		control.state = {
			...control.state,
			link: link({ phase: "connected" }, "123456", ["providers"]),
		};
		render(<RemoteBar />);
		fireEvent.click(screen.getByRole("button", { name: "Send providers" }));
		fireEvent.click(screen.getByRole("button", { name: "Close sending" }));
		expect(screen.queryByRole("button", { name: "Close sending" })).toBeNull();
		expect(screen.getByRole("button", { name: "Send providers" })).toBeInTheDocument();
	});

	it("offers to transfer history with a connected device that takes it", () => {
		control.state = {
			...control.state,
			link: link({ phase: "connected" }, "123456", ["history"]),
		};
		render(<RemoteBar />);
		expect(screen.queryByRole("button", { name: "Send providers" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Transfer history" }));
		fireEvent.click(screen.getByRole("button", { name: "Close transfer" }));
		expect(screen.queryByRole("button", { name: "Close transfer" })).toBeNull();
	});

	it("doesn't bring either dialog back by itself on the next link", () => {
		control.state = {
			...control.state,
			link: link({ phase: "connected" }, "123456", ["providers"]),
		};
		const { rerender } = render(<RemoteBar />);
		fireEvent.click(screen.getByRole("button", { name: "Send providers" }));
		expect(screen.getByRole("button", { name: "Close sending" })).toBeInTheDocument();
		control.state = {
			...control.state,
			link: { ...link({ phase: "connected" }, "123456", ["providers"]), id: 4 },
		};
		rerender(<RemoteBar />);
		expect(screen.queryByRole("button", { name: "Close sending" })).toBeNull();
		control.state = {
			...control.state,
			link: link({ phase: "connected" }, "123456", ["history"]),
		};
		rerender(<RemoteBar />);
		fireEvent.click(screen.getByRole("button", { name: "Transfer history" }));
		control.state = {
			...control.state,
			link: { ...link({ phase: "connected" }, "123456", ["history"]), id: 5 },
		};
		rerender(<RemoteBar />);
		expect(screen.queryByRole("button", { name: "Close transfer" })).toBeNull();
	});

	it("doesn't offer it to a device that doesn't take them, or while reconnecting", () => {
		control.state = { ...control.state, link: link({ phase: "connected" }) };
		const { unmount } = render(<RemoteBar />);
		expect(screen.queryByRole("button", { name: "Send providers" })).toBeNull();
		unmount();
		control.state = {
			...control.state,
			link: link({ phase: "reconnecting", attempt: 1 }, null, ["providers", "history"]),
		};
		render(<RemoteBar />);
		expect(screen.queryByRole("button", { name: "Send providers" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Transfer history" })).toBeNull();
	});

	it("shows nothing without a link or an ending to explain", () => {
		render(<RemoteBar />);
		expect(screen.queryByRole("region")).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("names the device that receives commands and what plays there", () => {
		const l = link({ phase: "connected" });
		l.destination.receive({ epoch: "e", version: 1, state: snapshot }, 0);
		control.state = { ...control.state, link: l };
		render(<RemoteBar />);
		const bar = screen.getByRole("region", { name: "Remote control" });
		expect(bar).toHaveTextContent("Playing on Living Room");
		expect(within(bar).getByTitle("Living Room").textContent).toBe("Playing on Living Room");
		expect(bar).toHaveTextContent("News at Ten");
	});

	it("follows the other device's state and sends its controls there", async () => {
		const l = link({ phase: "connected" });
		control.state = { ...control.state, link: l };
		render(<RemoteBar />);
		expect(screen.getByRole("region")).toHaveTextContent("Nothing playing");
		expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
		act(() => l.destination.receive({ epoch: "e", version: 1, state: snapshot }, 0));
		fireEvent.click(screen.getByRole("button", { name: "Pause" }));
		await waitFor(() =>
			expect(send).toHaveBeenCalledWith({ action: "pause", itemId: "live-7" })
		);
		act(() =>
			l.destination.receive(
				{ epoch: "e", version: 2, state: { ...snapshot, status: "paused" } },
				0
			)
		);
		fireEvent.click(screen.getByRole("button", { name: "Play" }));
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		await waitFor(() => expect(send).toHaveBeenCalledWith({ action: "stop" }));
		expect(send).toHaveBeenCalledWith({ action: "play", itemId: "live-7" });
	});

	it("leaves out play and pause where the other device can't pause", () => {
		const l = link({ phase: "connected" });
		const state = { ...snapshot, capabilities: { ...snapshot.capabilities, pause: false } };
		l.destination.receive({ epoch: "e", version: 1, state }, 0);
		control.state = { ...control.state, link: l };
		render(<RemoteBar />);
		expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
		expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
	});

	it("makes its buttons big enough to tap on a touch screen", () => {
		const l = link({ phase: "connected" });
		l.destination.receive({ epoch: "e", version: 1, state: snapshot }, 0);
		control.state = { ...control.state, link: l };
		render(<RemoteBar />);
		for (const name of ["Pause", "Stop", "Return to independent playback"]) {
			const button = screen.getByRole("button", { name });
			expect(button).toHaveClass("pointer-coarse:min-h-11", "pointer-coarse:min-w-11");
		}
		for (const name of ["Pause", "Stop"]) {
			expect(screen.getByRole("button", { name })).toHaveClass(
				"inline-flex",
				"items-center",
				"justify-center"
			);
		}
	});

	it("wraps onto more lines where one is too narrow, so nothing covers Play and Stop", () => {
		const l = link({ phase: "connected" });
		l.destination.receive({ epoch: "e", version: 1, state: snapshot }, 0);
		control.state = { ...control.state, link: l };
		render(<RemoteBar />);
		expect(screen.getByRole("region", { name: "Remote control" })).toHaveClass(
			"flex",
			"flex-wrap",
			"items-center",
			"gap-x-3",
			"gap-y-2"
		);
	});

	it("shows a buffering item as playing", () => {
		const l = link({ phase: "connected" });
		l.destination.receive(
			{ epoch: "e", version: 1, state: { ...snapshot, status: "buffering" } },
			0
		);
		control.state = { ...control.state, link: l };
		render(<RemoteBar />);
		expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
	});

	it("keeps going when a control is refused", async () => {
		send.mockRejectedValueOnce("stale_item");
		const l = link({ phase: "connected" });
		l.destination.receive({ epoch: "e", version: 1, state: snapshot }, 0);
		control.state = { ...control.state, link: l };
		render(<RemoteBar />);
		fireEvent.click(screen.getByRole("button", { name: "Pause" }));
		await act(async () => {});
		expect(screen.getByRole("region")).toBeInTheDocument();
	});

	it("says it's reconnecting", () => {
		control.state = { ...control.state, link: link({ phase: "reconnecting", attempt: 2 }) };
		render(<RemoteBar />);
		expect(within(screen.getByRole("region")).getByTitle("Living Room").textContent).toBe(
			"Reconnecting to Living Room…"
		);
	});

	it("waits for consent before showing", () => {
		control.state = { ...control.state, link: link({ phase: "pending", expiresInMs: 1 }) };
		render(<RemoteBar />);
		expect(screen.queryByRole("region")).toBeNull();
	});

	it("returns to independent playback", () => {
		control.state = { ...control.state, link: link({ phase: "connected" }) };
		render(<RemoteBar />);
		expect(screen.queryByRole("status")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Return to independent playback" }));
		expect(control.leave).toHaveBeenCalledTimes(1);
	});

	it("says when returning to independent playback didn't work, once the bar has gone", async () => {
		control.leave.mockImplementationOnce(leavesThenFails);
		control.state = { ...control.state, link: link({ phase: "connected" }) };
		const { rerender } = render(<RemoteBar />);
		fireEvent.click(screen.getByRole("button", { name: "Return to independent playback" }));
		rerender(<RemoteBar />);
		expect(screen.queryByRole("region"), "the link is gone here at once").toBeNull();
		expect(LEAVE_FAILED).toMatch(/disconnect it there/);
		expect(await screen.findByRole("status")).toHaveTextContent(LEAVE_FAILED);
		expect(screen.getByRole("status")).toHaveClass("bottom-20");
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("says it while the link is still there too", async () => {
		control.leave.mockRejectedValueOnce("gone");
		control.state = { ...control.state, link: link({ phase: "connected" }) };
		render(<RemoteBar />);
		fireEvent.click(screen.getByRole("button", { name: "Return to independent playback" }));
		expect(await screen.findByRole("status")).toHaveTextContent(LEAVE_FAILED);
		// A second try that works says nothing.
		fireEvent.click(screen.getByRole("button", { name: "Return to independent playback" }));
		await act(async () => {});
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("says once why a link ended", () => {
		control.state = {
			...control.state,
			ended: { name: "Living Room", reason: { target: "revoked" } },
		};
		const { rerender } = render(<RemoteBar />);
		expect(screen.getByRole("status")).toHaveTextContent(
			"Living Room disconnected this device."
		);
		// It sits at the bottom, below where a raised notice goes.
		expect(screen.getByRole("status")).toHaveClass("bottom-4");
		expect(screen.getByRole("status")).not.toHaveClass("bottom-20");
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("status")).toBeNull();
		rerender(<RemoteBar />);
		expect(screen.queryByRole("status")).toBeNull();
		control.state = { ...control.state, ended: { name: "Den", reason: "lost" } };
		rerender(<RemoteBar />);
		expect(screen.getByRole("status")).toHaveTextContent("Lost the connection to Den.");
	});

	it("says nothing when this device left", () => {
		control.state = { ...control.state, ended: { name: "Den", reason: "left" } };
		render(<RemoteBar />);
		expect(screen.queryByRole("status")).toBeNull();
	});
});

describe("ControllersBar", () => {
	const session = (id: string, name: string, connected: boolean) => ({
		sessionId: id,
		deviceId: `d-${id}`,
		name,
		deviceType: "iphone",
		connected,
	});

	it("shows nothing while no device controls this one", () => {
		sessions.list = [];
		render(<ControllersBar />);
		expect(screen.queryByRole("region")).toBeNull();
	});

	it("names each controlling device with a way to disconnect it", () => {
		sessions.list = [
			session("s1", "Phone", true),
			session("s2", "Laptop", true),
			session("s3", "Tablet", false),
		];
		render(<ControllersBar />);
		const bar = screen.getByRole("region", { name: "Devices controlling this one" });
		expect(bar).toHaveTextContent("Controlled from");
		expect(within(bar).getByText("Laptop").tagName).toBe("BDI");
		expect(bar).not.toHaveTextContent("Laptop Reconnecting…");
		fireEvent.click(screen.getByRole("button", { name: "Disconnect Laptop" }));
		expect(remoteDisconnect).toHaveBeenCalledWith("s2");
	});

	it("keeps a device that's reconnecting, which can still be cut off", () => {
		sessions.list = [session("s3", "Tablet", false)];
		render(<ControllersBar />);
		const bar = screen.getByRole("region", { name: "Devices controlling this one" });
		expect(bar).toHaveTextContent("TabletReconnecting…");
		fireEvent.click(screen.getByRole("button", { name: "Disconnect Tablet" }));
		expect(remoteDisconnect).toHaveBeenCalledWith("s3");
	});

	it("keeps going when disconnecting fails", async () => {
		vi.mocked(remoteDisconnect).mockRejectedValueOnce("gone");
		sessions.list = [session("s1", "Phone", true)];
		render(<ControllersBar />);
		fireEvent.click(screen.getByRole("button", { name: "Disconnect Phone" }));
		await act(async () => {});
		expect(screen.getByRole("region")).toBeInTheDocument();
	});
});

describe("ProvidersAddedNotice", () => {
	it("brings a TV remote to the notice, and Back closes it", () => {
		os.platform = "tv";
		render(<ProvidersAddedNotice />, { wrapper: wrapperFor() });
		act(() => tauriEvents.get("remote://providers-added")!({ from: "Mac", names: ["Home"] }));
		const notice = screen.getByRole("status");
		expect(notice).toHaveFocus();
		fireEvent.keyDown(notice, { key: "Escape" });
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("says what was added and loads the lists again", () => {
		const client = createTestQueryClient();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		render(<ProvidersAddedNotice />, { wrapper: wrapperFor(client) });
		expect(screen.queryByRole("status")).toBeNull();
		act(() => tauriEvents.get("remote://providers-added")!({ from: "Mac", names: ["Home"] }));
		expect(screen.getByRole("status")).toHaveTextContent("Added “Home” from Mac.");
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["local", "providers"] });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["local", "channels"] });
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("status")).toBeNull();
	});
});
