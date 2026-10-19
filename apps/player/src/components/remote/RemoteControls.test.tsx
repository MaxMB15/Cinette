// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach } from "vitest";
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
vi.mock("@/hooks/useRemoteTarget", () => ({ useRemoteSessions: () => sessions.list }));
vi.mock("@/lib/tauri", () => ({
	remoteDisconnect: vi.fn(() => Promise.resolve()),
	remoteLocalNetworkDenied: vi.fn(() => Promise.resolve(false)),
}));

import { remoteDisconnect, remoteLocalNetworkDenied } from "@/lib/tauri";
import {
	ConnectStatusDialog,
	ControllersBar,
	DevicesButton,
	LEAVE_FAILED,
	LOCAL_NETWORK_DENIED,
	NONE_FOUND,
	RemoteBar,
} from "./RemoteControls";

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

const link = (phase: Link["phase"], code: string | null = null): Link => {
	const destination = createCinetteDestination("tv1", "Living Room", send);
	return { id: 3, deviceId: "tv1", name: "Living Room", phase, code, destination };
};

beforeEach(() => {
	control.state = { devices: [tv, den], link: null, ended: null };
	control.connect.mockReset().mockResolvedValue(undefined);
	control.leave.mockReset().mockResolvedValue(undefined);
	send.mockClear();
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
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("shows which device plays, and choosing this device returns", () => {
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
	});

	it("says when ending the session from the picker didn't work", async () => {
		control.leave.mockRejectedValueOnce("gone");
		control.state = { ...control.state, link: link({ phase: "connected" }) };
		render(<DevicesButton />);
		fireEvent.click(screen.getByRole("button", { name: "Devices, playing on Living Room" }));
		fireEvent.click(screen.getByRole("button", { name: /This device/ }));
		expect(await screen.findByRole("status")).toHaveTextContent(LEAVE_FAILED);
		expect(screen.getByRole("status")).toHaveClass("bottom-20");
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("says when no other device was found", async () => {
		control.state = { ...control.state, devices: [] };
		render(<DevicesButton />);
		fireEvent.click(screen.getByRole("button", { name: "Devices" }));
		expect(await screen.findByRole("status")).toHaveTextContent(NONE_FOUND);
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
	});
});

describe("RemoteBar", () => {
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
		expect(screen.getByRole("region")).toHaveTextContent("Reconnecting to Living Room…");
	});

	it("waits for consent before showing", () => {
		control.state = { ...control.state, link: link({ phase: "pending", expiresInMs: 1 }) };
		render(<RemoteBar />);
		expect(screen.queryByRole("region")).toBeNull();
	});

	it("returns to independent playback", () => {
		control.state = { ...control.state, link: link({ phase: "connected" }) };
		render(<RemoteBar />);
		fireEvent.click(screen.getByRole("button", { name: "Return to independent playback" }));
		expect(control.leave).toHaveBeenCalledTimes(1);
	});

	it("says when returning to independent playback didn't work", async () => {
		control.leave.mockRejectedValueOnce("gone");
		control.state = { ...control.state, link: link({ phase: "connected" }) };
		render(<RemoteBar />);
		fireEvent.click(screen.getByRole("button", { name: "Return to independent playback" }));
		expect(await screen.findByRole("status")).toHaveTextContent(LEAVE_FAILED);
		expect(screen.getByRole("status")).toHaveClass("bottom-4");
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("status")).toBeNull();
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

	it("shows nothing while no device is connected", () => {
		sessions.list = [session("s1", "Phone", false)];
		render(<ControllersBar />);
		expect(screen.queryByRole("region")).toBeNull();
	});

	it("names each connected device with a way to disconnect it", () => {
		sessions.list = [
			session("s1", "Phone", true),
			session("s2", "Laptop", true),
			session("s3", "Tablet", false),
		];
		render(<ControllersBar />);
		const bar = screen.getByRole("region", { name: "Devices controlling this one" });
		expect(bar).toHaveTextContent("Controlled from");
		expect(bar).not.toHaveTextContent("Tablet");
		fireEvent.click(screen.getByRole("button", { name: "Disconnect Laptop" }));
		expect(remoteDisconnect).toHaveBeenCalledWith("s2");
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
