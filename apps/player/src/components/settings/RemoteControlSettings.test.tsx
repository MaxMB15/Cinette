// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import type { RemoteSettings } from "@/lib/tauri";

vi.mock("@/lib/tauri", () => ({
	remoteGetSettings: vi.fn(),
	remoteSetSettings: vi.fn(),
	remoteResetIdentity: vi.fn(),
	remoteDisconnect: vi.fn(() => Promise.resolve()),
}));

const sessions = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("@/hooks/useRemoteTarget", () => ({ useRemoteSessions: () => sessions.list }));

import {
	remoteDisconnect,
	remoteGetSettings,
	remoteResetIdentity,
	remoteSetSettings,
} from "@/lib/tauri";
import { MAX_NAME_BYTES, RemoteControlSettings, fitName } from "./RemoteControlSettings";

const defaults: RemoteSettings = {
	discoverable: true,
	remoteControl: "ask",
	deviceName: null,
	defaultName: "Linux PC",
	deviceId: "abc",
};

const shown = async (settings: RemoteSettings = defaults) => {
	vi.mocked(remoteGetSettings).mockResolvedValue(settings);
	render(<RemoteControlSettings />);
	await screen.findByText("Remote control", { selector: "h3,div" });
};

beforeEach(() => {
	vi.clearAllMocks();
	sessions.list = [];
	vi.mocked(remoteSetSettings).mockImplementation(async (s) => ({
		...defaults,
		...s,
		deviceName: s.deviceName,
	}));
});

describe("RemoteControlSettings", () => {
	it("shows nothing where remote control doesn't run", async () => {
		vi.mocked(remoteGetSettings).mockRejectedValue("unavailable");
		const { container } = render(<RemoteControlSettings />);
		await act(async () => {});
		expect(container).toBeEmptyDOMElement();
	});

	it("drops settings that load after it closed", async () => {
		let resolve: (s: RemoteSettings) => void = () => {};
		vi.mocked(remoteGetSettings).mockImplementation(() => new Promise((r) => (resolve = r)));
		const { unmount, container } = render(<RemoteControlSettings />);
		unmount();
		await act(async () => resolve(defaults));
		expect(container).toBeEmptyDOMElement();
	});

	it("shows the settings that loaded last when an earlier load answers late", async () => {
		let late: (s: RemoteSettings) => void = () => {};
		vi.mocked(remoteGetSettings)
			.mockImplementationOnce(() => new Promise((r) => (late = r)))
			.mockResolvedValueOnce({ ...defaults, deviceName: "Den" });
		render(<RemoteControlSettings />, { wrapper: StrictMode });
		await waitFor(() => expect(screen.getByLabelText("Device name")).toHaveValue("Den"));
		await act(async () => late({ ...defaults, deviceName: "Old" }));
		expect(screen.getByLabelText("Device name")).toHaveValue("Den");
	});

	it("saves nothing when the default name is left empty", async () => {
		await shown();
		fireEvent.blur(screen.getByLabelText("Device name"));
		await act(async () => {});
		expect(remoteSetSettings).not.toHaveBeenCalled();
	});

	it("shows the defaults: discoverable, only when allowed, the type as name", async () => {
		await shown();
		const discoverable = screen.getByRole("button", { name: "Discoverable on this network" });
		expect(discoverable).toHaveTextContent("On");
		expect(discoverable).toHaveClass("bg-primary");
		expect(
			screen.getByRole("button", { name: "Discoverable on this network" })
		).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("button", { name: "Only when allowed" })).toHaveAttribute(
			"aria-pressed",
			"true"
		);
		expect(
			screen.getByText(/asks each time another one wants to control it/)
		).toBeInTheDocument();
		expect(screen.getByLabelText("Device name")).toHaveAttribute("placeholder", "Linux PC");
		expect(screen.getByLabelText("Device name")).toHaveValue("");
		expect(screen.getByText(/Devices already connected stay connected/)).toBeInTheDocument();
		expect(screen.getByText("No device is controlling this one.")).toBeInTheDocument();
	});

	it("turns discovery off and on", async () => {
		await shown();
		fireEvent.click(screen.getByRole("button", { name: "Discoverable on this network" }));
		await act(async () => {});
		expect(remoteSetSettings).toHaveBeenCalledWith({
			discoverable: false,
			remoteControl: "ask",
			deviceName: null,
		});
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Discoverable on this network" })
			).toHaveAttribute("aria-pressed", "false")
		);
		const off = screen.getByRole("button", { name: "Discoverable on this network" });
		expect(off).toHaveTextContent("Off");
		expect(off).toHaveClass("bg-secondary");
		expect(off).not.toHaveClass("bg-primary");
	});

	it("changes who may control it and says what each choice means", async () => {
		await shown();
		fireEvent.click(screen.getByRole("button", { name: "Never allow" }));
		await act(async () => {});
		expect(remoteSetSettings).toHaveBeenCalledWith({
			discoverable: true,
			remoteControl: "never",
			deviceName: null,
		});
		expect(await screen.findByText(/Choosing this ends every session now/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
		expect(
			await screen.findByText(
				/Any device on this network can control playback here and browse what this device can play, with no dialog and no code to compare. Only choose this on a network you trust/
			)
		).toBeInTheDocument();
	});

	it("saves the name when the field loses focus or on Enter, and only when it changed", async () => {
		await shown({ ...defaults, deviceName: "Den" });
		const field = screen.getByLabelText("Device name");
		expect(field).toHaveValue("Den");
		fireEvent.blur(field);
		expect(remoteSetSettings).not.toHaveBeenCalled();
		fireEvent.change(field, { target: { value: "  Living Room " } });
		fireEvent.keyDown(field, { key: "Enter" });
		await act(async () => {});
		expect(remoteSetSettings).toHaveBeenCalledWith({
			discoverable: true,
			remoteControl: "ask",
			deviceName: "Living Room",
		});
		await waitFor(() => expect(field).toHaveValue("Living Room"));
		fireEvent.change(field, { target: { value: "Living Room 2" } });
		fireEvent.keyDown(field, { key: "a" });
		await act(async () => {});
		expect(remoteSetSettings, "only Enter saves").toHaveBeenCalledTimes(1);
	});

	it("goes back to the default name when the field is cleared", async () => {
		await shown({ ...defaults, deviceName: "Den" });
		const field = screen.getByLabelText("Device name");
		fireEvent.change(field, { target: { value: "   " } });
		fireEvent.blur(field);
		await act(async () => {});
		expect(remoteSetSettings).toHaveBeenCalledWith({
			discoverable: true,
			remoteControl: "ask",
			deviceName: null,
		});
		await waitFor(() => expect(field).toHaveValue(""));
	});

	it("says when saving failed", async () => {
		vi.mocked(remoteSetSettings).mockRejectedValueOnce("disk full");
		await shown();
		fireEvent.click(screen.getByRole("button", { name: "Never allow" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Couldn't save the remote control settings. Try again."
		);
		fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});

	it("lists the devices controlling it, each with Disconnect", async () => {
		sessions.list = [
			{
				sessionId: "s1",
				deviceId: "d1",
				name: "Phone",
				deviceType: "iphone",
				connected: true,
			},
			{
				sessionId: "s2",
				deviceId: "d2",
				name: "Laptop",
				deviceType: "mac",
				connected: false,
			},
		];
		await shown();
		expect(screen.getByText("Phone").closest("li")?.textContent).toBe(
			"Phone · iPhoneDisconnect"
		);
		expect(screen.getByText("Laptop").closest("li")).toHaveTextContent(
			"Laptop · Mac · reconnecting"
		);
		fireEvent.click(screen.getByRole("button", { name: "Disconnect Laptop" }));
		expect(remoteDisconnect).toHaveBeenCalledWith("s2");
	});

	it("keeps going when disconnecting fails", async () => {
		vi.mocked(remoteDisconnect).mockRejectedValueOnce("gone");
		sessions.list = [
			{
				sessionId: "s1",
				deviceId: "d1",
				name: "Phone",
				deviceType: "iphone",
				connected: true,
			},
		];
		await shown();
		fireEvent.click(screen.getByRole("button", { name: "Disconnect Phone" }));
		await act(async () => {});
		expect(screen.getByText("Phone")).toBeInTheDocument();
	});

	it("resets the identity after asking", async () => {
		vi.mocked(remoteResetIdentity).mockResolvedValue({ ...defaults, deviceId: "new" });
		await shown();
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));
		const dialog = screen.getByRole("dialog", { name: "Reset device identity?" });
		expect(dialog).toHaveTextContent("Every device controlling this one is disconnected");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(remoteResetIdentity).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Reset" }));
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset" }));
		expect(remoteResetIdentity).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("says when resetting failed", async () => {
		vi.mocked(remoteResetIdentity).mockRejectedValue("no key");
		await shown();
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Couldn't reset the device identity. Try again."
		);
	});

	it("saves one change after another, each on top of the last", async () => {
		let finish: () => void = () => {};
		vi.mocked(remoteSetSettings).mockImplementationOnce(
			(sent) =>
				new Promise((resolve) => {
					finish = () => resolve({ ...defaults, ...sent });
				})
		);
		await shown();
		const field = screen.getByLabelText("Device name");
		fireEvent.change(field, { target: { value: "Den" } });
		fireEvent.blur(field);
		// The same name again, on its way already, isn't sent twice.
		fireEvent.blur(field);
		// Chosen before the name's save is back.
		fireEvent.click(screen.getByRole("button", { name: "Never allow" }));
		await act(async () => {});
		expect(remoteSetSettings, "the second waits for the first").toHaveBeenCalledTimes(1);
		await act(async () => finish());
		expect(remoteSetSettings).toHaveBeenLastCalledWith({
			discoverable: true,
			remoteControl: "never",
			deviceName: "Den",
		});
		expect(field).toHaveValue("Den");
		// The same name again, now saved, saves nothing.
		fireEvent.blur(field);
		await act(async () => {});
		expect(remoteSetSettings).toHaveBeenCalledTimes(2);
	});

	it("shows only the newest save's answer", async () => {
		const answers: ((s: RemoteSettings) => void)[] = [];
		vi.mocked(remoteSetSettings).mockImplementation(
			() => new Promise((resolve) => answers.push(resolve))
		);
		await shown();
		const mode = (name: string) => screen.getByRole("button", { name });
		fireEvent.click(mode("Never allow"));
		fireEvent.click(mode("Always allow"));
		await act(async () => {});
		await act(async () => answers[0]({ ...defaults, remoteControl: "never" }));
		expect(mode("Never allow"), "a newer save is on its way").toHaveAttribute(
			"aria-pressed",
			"false"
		);
		await act(async () => answers[1]({ ...defaults, remoteControl: "always" }));
		expect(mode("Always allow")).toHaveAttribute("aria-pressed", "true");
	});

	it("says nothing about an older save that failed", async () => {
		let failFirst: (e: unknown) => void = () => {};
		vi.mocked(remoteSetSettings)
			.mockImplementationOnce(() => new Promise((_, reject) => (failFirst = reject)))
			.mockImplementationOnce(async (sent) => ({ ...defaults, ...sent }));
		await shown();
		fireEvent.click(screen.getByRole("button", { name: "Never allow" }));
		fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
		await act(async () => {});
		await act(async () => failFirst("late"));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Always allow" })).toHaveAttribute(
				"aria-pressed",
				"true"
			)
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps a name to what fits in 63 bytes", async () => {
		expect(MAX_NAME_BYTES).toBe(63);
		expect(fitName("Den")).toBe("Den");
		expect(fitName("x".repeat(70))).toBe("x".repeat(63));
		// Each of these takes 4 bytes, so 15 fit.
		expect(fitName("😀".repeat(20))).toBe("😀".repeat(15));
		expect(new TextEncoder().encode(fitName("é".repeat(40))).length).toBe(62);
		await shown();
		const field = screen.getByLabelText("Device name");
		fireEvent.change(field, { target: { value: "Ж".repeat(40) } });
		expect(field).toHaveValue("Ж".repeat(31));
	});

	it("names its choice of who may control it", async () => {
		await shown();
		expect(screen.getByRole("group", { name: "Remote control" })).toBeInTheDocument();
	});
});
