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
	remoteOpen: vi.fn(() => Promise.resolve()),
	remoteLocalNetworkDenied: vi.fn(() => Promise.resolve(false)),
}));

const limit = vi.hoisted(() => ({ text: null as string | null }));
vi.mock("@/lib/remote-devices", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/remote-devices")>()),
	discoveryLimit: () => limit.text,
}));

const sessions = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("@/hooks/useRemoteTarget", () => ({ useRemoteSessions: () => sessions.list }));

import {
	remoteDisconnect,
	remoteGetSettings,
	remoteLocalNetworkDenied,
	remoteOpen,
	remoteResetIdentity,
	remoteSetSettings,
} from "@/lib/tauri";
import { LOCAL_NETWORK_DENIED } from "@/lib/remote-devices";
import {
	ALWAYS_WARNING,
	NOT_STARTED,
	RESET_DONE,
	RemoteControlSettings,
	SAVE_FAILED,
} from "./RemoteControlSettings";

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
	limit.text = null;
	vi.mocked(remoteSetSettings).mockImplementation(async (s) => ({
		...defaults,
		...s,
		deviceName: s.deviceName,
	}));
});

describe("RemoteControlSettings", () => {
	it("shows nothing where remote control doesn't run", async () => {
		vi.mocked(remoteGetSettings).mockRejectedValue(
			"Remote control isn't available on this device yet."
		);
		const { container } = render(<RemoteControlSettings />);
		await act(async () => {});
		expect(container).toBeEmptyDOMElement();
	});

	it("says so when remote control didn't start", async () => {
		vi.mocked(remoteGetSettings).mockRejectedValue(
			"Remote control didn't start on this device."
		);
		render(<RemoteControlSettings />);
		expect(await screen.findByRole("alert")).toHaveTextContent(NOT_STARTED);
		expect(screen.getByText("Remote control", { selector: "h3,div" })).toBeInTheDocument();
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
		// Each choice says what it means before it's made.
		expect(
			screen.getByText(/asks each time another one wants to control it/)
		).toBeInTheDocument();
		expect(screen.getByText(/with no dialog and no code to compare/)).toBeInTheDocument();
		expect(screen.getByText(/No device can control this one/)).toBeInTheDocument();
		expect(screen.getByLabelText("Device name")).toHaveAttribute("placeholder", "Linux PC");
		expect(screen.getByLabelText("Device name")).toHaveValue("");
		expect(screen.getByText(/Devices already connected stay connected/)).toBeInTheDocument();
		expect(screen.getByText("No device is controlling this one.")).toBeInTheDocument();
	});

	it("says when other devices can find this one, where that depends on the app being open", async () => {
		limit.text = "Only while open.";
		await shown();
		expect(
			screen.getByText(/until you disconnect them\. Only while open\.$/)
		).toBeInTheDocument();
	});

	it("adds nothing about it on a computer", async () => {
		await shown();
		expect(screen.getByText(/until you disconnect them\.$/)).toBeInTheDocument();
	});

	it("starts remote control before it loads the settings", async () => {
		const order: string[] = [];
		vi.mocked(remoteOpen).mockImplementationOnce(async () => {
			order.push("open");
		});
		vi.mocked(remoteGetSettings).mockImplementationOnce(async () => {
			order.push("load");
			return defaults;
		});
		render(<RemoteControlSettings />);
		await screen.findByText("Remote control", { selector: "h3,div" });
		expect(order).toEqual(["open", "load"]);
	});

	it("still loads the settings when starting remote control failed", async () => {
		vi.mocked(remoteOpen).mockRejectedValueOnce("couldn't start");
		await shown();
		expect(
			screen.getByRole("button", { name: "Discoverable on this network" })
		).toBeInTheDocument();
	});

	it("says where to allow the local network when the system refuses it", async () => {
		vi.mocked(remoteLocalNetworkDenied).mockResolvedValueOnce(true);
		await shown();
		expect(await screen.findByRole("status")).toHaveTextContent(LOCAL_NETWORK_DENIED);
	});

	it("says nothing about the local network while it's allowed or unknown", async () => {
		vi.mocked(remoteLocalNetworkDenied).mockRejectedValueOnce("unknown");
		await shown();
		await waitFor(() => expect(remoteLocalNetworkDenied).toHaveBeenCalled());
		// Let the refusal settle, then the settings are still there.
		await act(async () => {});
		expect(screen.queryByText(LOCAL_NETWORK_DENIED)).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(
			screen.getByRole("button", { name: "Discoverable on this network" })
		).toBeInTheDocument();
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

	it("shows a change at once, so a second click before the answer undoes the first", async () => {
		const answers: (() => void)[] = [];
		vi.mocked(remoteSetSettings).mockImplementation(
			(sent) =>
				new Promise((resolve) => answers.push(() => resolve({ ...defaults, ...sent })))
		);
		await shown();
		const button = () => screen.getByRole("button", { name: "Discoverable on this network" });
		fireEvent.click(button());
		expect(button()).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(button());
		expect(button()).toHaveAttribute("aria-pressed", "true");
		await waitFor(() => expect(answers).toHaveLength(1));
		await act(async () => answers[0]());
		await waitFor(() => expect(answers).toHaveLength(2));
		await act(async () => answers[1]());
		expect(vi.mocked(remoteSetSettings).mock.calls.map(([s]) => s.discoverable)).toEqual([
			false,
			true,
		]);
		expect(button()).toHaveAttribute("aria-pressed", "true");
	});

	it("changes who may control it, asking before Always allow", async () => {
		await shown();
		fireEvent.click(screen.getByRole("button", { name: "Never allow" }));
		await act(async () => {});
		expect(remoteSetSettings).toHaveBeenCalledWith({
			discoverable: true,
			remoteControl: "never",
			deviceName: null,
		});
		fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
		const dialog = screen.getByRole("dialog", { name: "Always allow remote control?" });
		expect(dialog).toHaveTextContent(ALWAYS_WARNING);
		expect(ALWAYS_WARNING).toMatch(/Only choose this on a network you trust/);
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(remoteSetSettings).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
		fireEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", { name: "Always allow" })
		);
		expect(screen.queryByRole("dialog")).toBeNull();
		await act(async () => {});
		expect(remoteSetSettings).toHaveBeenLastCalledWith({
			discoverable: true,
			remoteControl: "always",
			deviceName: null,
		});
	});

	it("saves nothing when the choice already made is clicked", async () => {
		await shown();
		fireEvent.click(screen.getByRole("button", { name: "Only when allowed" }));
		await act(async () => {});
		expect(remoteSetSettings).not.toHaveBeenCalled();
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

	it("says when saving failed, and shows what the device runs", async () => {
		vi.mocked(remoteSetSettings).mockRejectedValueOnce("disk full");
		await shown();
		// Never allow holds until Cinette quits, even unsaved.
		vi.mocked(remoteGetSettings).mockResolvedValue({ ...defaults, remoteControl: "never" });
		fireEvent.click(screen.getByRole("button", { name: "Never allow" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED);
		expect(screen.getByRole("button", { name: "Never allow" })).toHaveAttribute(
			"aria-pressed",
			"true"
		);
		fireEvent.click(screen.getByRole("button", { name: "Only when allowed" }));
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});

	it("doesn't send a change that failed and the device dropped with the next save", async () => {
		vi.mocked(remoteSetSettings).mockRejectedValueOnce("disk full");
		await shown();
		// The device answers that it still runs Only when allowed.
		vi.mocked(remoteGetSettings).mockResolvedValue(defaults);
		fireEvent.click(screen.getByRole("button", { name: "Never allow" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED);
		expect(screen.getByRole("button", { name: "Only when allowed" })).toHaveAttribute(
			"aria-pressed",
			"true"
		);
		fireEvent.click(screen.getByRole("button", { name: "Discoverable on this network" }));
		await act(async () => {});
		expect(remoteSetSettings).toHaveBeenLastCalledWith({
			discoverable: false,
			remoteControl: "ask",
			deviceName: null,
		});
	});

	it("keeps showing a newer change while an older one fails", async () => {
		vi.mocked(remoteSetSettings)
			.mockRejectedValueOnce("disk full")
			.mockImplementationOnce(() => new Promise(() => {}));
		await shown();
		vi.mocked(remoteGetSettings).mockResolvedValue(defaults);
		fireEvent.click(screen.getByRole("button", { name: "Never allow" }));
		fireEvent.click(screen.getByRole("button", { name: "Discoverable on this network" }));
		await waitFor(() => expect(remoteSetSettings).toHaveBeenCalledTimes(2));
		expect(
			screen.getByRole("button", { name: "Discoverable on this network" }),
			"the newer change still shows"
		).toHaveAttribute("aria-pressed", "false");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps showing a newer change while an older one fails with no answer", async () => {
		vi.mocked(remoteSetSettings)
			.mockRejectedValueOnce("disk full")
			.mockImplementationOnce(() => new Promise(() => {}));
		await shown();
		vi.mocked(remoteGetSettings).mockRejectedValue("gone");
		fireEvent.click(screen.getByRole("button", { name: "Never allow" }));
		fireEvent.click(screen.getByRole("button", { name: "Discoverable on this network" }));
		await waitFor(() => expect(remoteSetSettings).toHaveBeenCalledTimes(2));
		expect(
			screen.getByRole("button", { name: "Discoverable on this network" })
		).toHaveAttribute("aria-pressed", "false");
	});

	it("builds a save queued behind one that failed on what the device runs then", async () => {
		let failFirst: (e: unknown) => void = () => {};
		vi.mocked(remoteSetSettings).mockImplementationOnce(
			() => new Promise((_, reject) => (failFirst = reject))
		);
		await shown();
		// The device runs Never allow though it couldn't save it.
		vi.mocked(remoteGetSettings).mockResolvedValue({ ...defaults, remoteControl: "never" });
		fireEvent.click(screen.getByRole("button", { name: "Never allow" }));
		fireEvent.click(screen.getByRole("button", { name: "Discoverable on this network" }));
		await waitFor(() => expect(remoteSetSettings).toHaveBeenCalledTimes(1));
		await act(async () => failFirst("disk full"));
		await waitFor(() => expect(remoteSetSettings).toHaveBeenCalledTimes(2));
		expect(remoteSetSettings).toHaveBeenLastCalledWith({
			discoverable: false,
			remoteControl: "never",
			deviceName: null,
		});
	});

	it("keeps a save's choice when a reset that was on its way answers after it", async () => {
		let reset: (s: RemoteSettings) => void = () => {};
		vi.mocked(remoteResetIdentity).mockImplementationOnce(
			() => new Promise((resolve) => (reset = resolve))
		);
		await shown();
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset" }));
		fireEvent.click(screen.getByRole("button", { name: "Never allow" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Never allow" })).toHaveAttribute(
				"aria-pressed",
				"true"
			)
		);
		// The reset's answer carries the settings from before the save.
		await act(async () => reset({ ...defaults, deviceId: "new", defaultName: "Den PC" }));
		expect(screen.getByRole("button", { name: "Never allow" })).toHaveAttribute(
			"aria-pressed",
			"true"
		);
		expect(screen.getByLabelText("Device name")).toHaveAttribute("placeholder", "Den PC");
		fireEvent.click(screen.getByRole("button", { name: "Discoverable on this network" }));
		await waitFor(() => expect(remoteSetSettings).toHaveBeenCalledTimes(2));
		expect(remoteSetSettings).toHaveBeenLastCalledWith({
			discoverable: false,
			remoteControl: "never",
			deviceName: null,
		});
	});

	it("goes back to the last answer when it can't ask the device either", async () => {
		vi.mocked(remoteSetSettings).mockRejectedValueOnce("disk full");
		await shown();
		vi.mocked(remoteGetSettings).mockRejectedValue("gone");
		fireEvent.click(screen.getByRole("button", { name: "Never allow" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED);
		expect(screen.getByRole("button", { name: "Only when allowed" })).toHaveAttribute(
			"aria-pressed",
			"true"
		);
	});

	it("keeps what is typed in the name field while a save is on its way", async () => {
		let finish: () => void = () => {};
		vi.mocked(remoteSetSettings).mockImplementationOnce(
			(sent) => new Promise((resolve) => (finish = () => resolve({ ...defaults, ...sent })))
		);
		await shown();
		const field = screen.getByLabelText("Device name");
		fireEvent.change(field, { target: { value: "Den" } });
		fireEvent.keyDown(field, { key: "Enter" });
		fireEvent.change(field, { target: { value: "Den TV" } });
		await waitFor(() => expect(remoteSetSettings).toHaveBeenCalled());
		await act(async () => finish());
		expect(field).toHaveValue("Den TV");
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
		expect(screen.getByText("Phone").tagName, "the name is set apart").toBe("BDI");
		expect(screen.getByText("Laptop").closest("li")).toHaveTextContent(
			"Laptop · Mac · reconnecting"
		);
		fireEvent.click(screen.getByRole("button", { name: "Disconnect Laptop" }));
		expect(remoteDisconnect).toHaveBeenCalledWith("s2");
	});

	it("tells two devices with one name apart", async () => {
		sessions.list = ["d1abcdefgh", "d2abcdefgh"].map((deviceId, i) => ({
			sessionId: `s${i}`,
			deviceId,
			name: "Phone",
			deviceType: "iphone",
			connected: true,
		}));
		await shown();
		expect(screen.getAllByText(/iPhone · ID d1abcd|iPhone · ID d2abcd/)).toHaveLength(2);
		fireEvent.click(screen.getByRole("button", { name: "Disconnect Phone · ID d2abcd" }));
		expect(remoteDisconnect).toHaveBeenCalledWith("s1");
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
		expect(await screen.findByRole("status")).toHaveTextContent(RESET_DONE);
	});

	it("clears what the last save or reset said once something new is done", async () => {
		vi.mocked(remoteResetIdentity).mockResolvedValue(defaults);
		vi.mocked(remoteSetSettings).mockRejectedValueOnce("disk full");
		await shown();
		const reset = () => {
			fireEvent.click(screen.getByRole("button", { name: "Reset" }));
			fireEvent.click(
				within(screen.getByRole("dialog")).getByRole("button", { name: "Reset" })
			);
		};
		fireEvent.click(screen.getByRole("button", { name: "Never allow" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED);
		reset();
		expect(screen.queryByRole("alert"), "a reset clears a save's error").toBeNull();
		expect(await screen.findByRole("status")).toHaveTextContent(RESET_DONE);
		fireEvent.click(screen.getByRole("button", { name: "Discoverable on this network" }));
		expect(screen.queryByRole("status"), "a save clears a reset's note").toBeNull();
		await act(async () => {});
		reset();
		await screen.findByRole("status");
		vi.mocked(remoteResetIdentity).mockRejectedValueOnce("no key");
		reset();
		expect(screen.queryByRole("status"), "a reset clears the last one's note").toBeNull();
		expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reset");
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
		fireEvent.click(mode("Only when allowed"));
		await act(async () => {});
		await act(async () => answers[0]({ ...defaults, remoteControl: "never" }));
		expect(mode("Never allow"), "a newer save is on its way").toHaveAttribute(
			"aria-pressed",
			"false"
		);
		await waitFor(() => expect(answers).toHaveLength(2));
		await act(async () => answers[1]({ ...defaults, remoteControl: "ask" }));
		expect(mode("Only when allowed")).toHaveAttribute("aria-pressed", "true");
	});

	it("says nothing about an older save that failed", async () => {
		let failFirst: (e: unknown) => void = () => {};
		vi.mocked(remoteSetSettings)
			.mockImplementationOnce(() => new Promise((_, reject) => (failFirst = reject)))
			.mockImplementationOnce(async (sent) => ({ ...defaults, ...sent }));
		await shown();
		fireEvent.click(screen.getByRole("button", { name: "Never allow" }));
		fireEvent.click(screen.getByRole("button", { name: "Only when allowed" }));
		await act(async () => {});
		await act(async () => failFirst("late"));
		await waitFor(() => expect(remoteSetSettings).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Only when allowed" })).toHaveAttribute(
				"aria-pressed",
				"true"
			)
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps a name to what fits in 63 bytes", async () => {
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
