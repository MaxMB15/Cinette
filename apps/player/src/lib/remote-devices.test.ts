// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi } from "vitest";
import { platform as osPlatform } from "@tauri-apps/plugin-os";
import {
	deviceTypeName,
	discoveryLimit,
	LOCAL_NETWORK_DENIED,
	LOCAL_NETWORK_DENIED_IOS,
	localNetworkDenied,
	endedText,
	fitName,
	formatCode,
	isTv,
	MAX_NAME_BYTES,
	secondsLeft,
} from "./remote-devices";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: vi.fn() }));

describe("localNetworkDenied", () => {
	it("names iOS's Settings on iOS and System Settings elsewhere", () => {
		expect(localNetworkDenied("ios")).toBe(LOCAL_NETWORK_DENIED_IOS);
		expect(localNetworkDenied("macos")).toBe(LOCAL_NETWORK_DENIED);
		expect(LOCAL_NETWORK_DENIED).toBe(
			"Cinette can't look for other devices. Allow it under Local Network in System Settings, Privacy & Security."
		);
		expect(LOCAL_NETWORK_DENIED_IOS).toBe(
			"Cinette can't look for other devices. Allow it in Settings, Privacy & Security, Local Network."
		);
	});
});

describe("discoveryLimit", () => {
	it("says phones, tablets and TVs are only found while you're using Cinette", () => {
		const note = "Other devices can only find this one while you're using Cinette.";
		expect(discoveryLimit("android")).toBe(note);
		expect(discoveryLimit("tv")).toBe(note);
		expect(discoveryLimit("ios")).toBe(note);
	});

	it("says nothing on a computer, which only has to be running", () => {
		expect(discoveryLimit("macos")).toBeNull();
		expect(discoveryLimit("linux")).toBeNull();
	});

	it("asks the platform when given none", () => {
		vi.mocked(osPlatform).mockReturnValue("android");
		expect(discoveryLimit()).not.toBeNull();
	});
});

describe("deviceTypeName", () => {
	it("names every type the protocol has", () => {
		expect(
			[
				"mac",
				"linux-pc",
				"windows-pc",
				"iphone",
				"ipad",
				"android-phone",
				"android-tablet",
				"android-tv",
				"fire-tv",
			].map(deviceTypeName)
		).toEqual([
			"Mac",
			"Linux PC",
			"Windows PC",
			"iPhone",
			"iPad",
			"Android phone",
			"Android tablet",
			"Android TV",
			"Fire TV",
		]);
	});

	it("calls a type from a newer version a device", () => {
		expect(deviceTypeName("other")).toBe("Device");
		expect(deviceTypeName("toString")).toBe("Device");
	});
});

describe("isTv", () => {
	it("is true for Android TV and Fire TV only", () => {
		expect(isTv("android-tv")).toBe(true);
		expect(isTv("fire-tv")).toBe(true);
		expect(isTv("mac")).toBe(false);
		expect(isTv("android-tablet")).toBe(false);
	});
});

describe("secondsLeft", () => {
	it("rounds up to whole seconds and stops at 0", () => {
		expect(secondsLeft(30_000, 0)).toBe(30);
		expect(secondsLeft(30_000, 100)).toBe(30);
		expect(secondsLeft(30_000, 1_000)).toBe(29);
		expect(secondsLeft(30_000, 29_999)).toBe(1);
		expect(secondsLeft(30_000, 30_000)).toBe(0);
		expect(secondsLeft(30_000, 45_000)).toBe(0);
	});
});

describe("formatCode", () => {
	it("splits six digits into two groups", () => {
		expect(formatCode("042917")).toBe("042 917");
	});

	it("leaves anything else as it is", () => {
		expect(formatCode("12345")).toBe("12345");
		expect(formatCode("1234567")).toBe("1234567");
	});
});

describe("endedText", () => {
	it("says nothing when this device left", () => {
		expect(endedText("TV", "left")).toBeNull();
	});

	it("explains every other ending", () => {
		const cases: [Parameters<typeof endedText>[1], string][] = [
			["lost", "Lost the connection to TV."],
			[{ target: "denied" }, "TV didn't allow it."],
			[{ target: "expired" }, "TV didn't answer in time."],
			[{ target: "not_allowed" }, "TV doesn't allow remote control."],
			[{ target: "not_discoverable" }, "TV isn't taking new connections."],
			[{ target: "revoked" }, "TV disconnected this device."],
			[{ target: "busy" }, "TV is busy with other requests. Try again in a moment."],
			[{ target: "shutdown" }, "Cinette closed on TV."],
			[
				{ target: "cancelled" },
				"TV took a newer connection from this device in place of this one.",
			],
			[
				{ target: "version" },
				"TV has a version of Cinette this one can't talk to. Update both.",
			],
			[
				{ target: "identity_mismatch" },
				"The device that answered isn't TV. Nothing was sent to it.",
			],
			[{ target: "timeout" }, "Lost the connection to TV."],
			[{ target: "protocol" }, "Lost the connection to TV."],
		];
		for (const [reason, text] of cases) expect(endedText("TV", reason)).toBe(text);
	});

	it("names the Local Network setting on systems that ask for it", () => {
		expect(endedText("TV", "unreachable", "macos")).toBe(
			"Couldn't reach TV. Check that Cinette is allowed under Local Network in System Settings, Privacy & Security. A firewall on that device may also be blocking it."
		);
		expect(endedText("TV", "unreachable", "ios")).toBe(
			"Couldn't reach TV. Check that Cinette is allowed in Settings, Privacy & Security, Local Network. A firewall on that device may also be blocking it."
		);
	});

	it("names only a firewall on systems that don't", () => {
		const text = "Couldn't reach TV. A firewall on that device may be blocking Cinette.";
		expect(endedText("TV", "unreachable", "linux")).toBe(text);
		expect(endedText("TV", "unreachable", "android")).toBe(text);
	});

	it("asks the platform when given none", () => {
		vi.mocked(osPlatform).mockReturnValue("ios");
		expect(endedText("TV", "unreachable")).toBe(endedText("TV", "unreachable", "ios"));
	});
});

describe("fitName", () => {
	it("keeps a name to what fits in 63 bytes", () => {
		expect(MAX_NAME_BYTES).toBe(63);
		expect(fitName("Den")).toBe("Den");
		expect(fitName("x".repeat(70))).toBe("x".repeat(63));
		expect(fitName("x".repeat(63))).toBe("x".repeat(63));
		expect(fitName("😀".repeat(20))).toBe("😀".repeat(15));
		expect(new TextEncoder().encode(fitName("é".repeat(40))).length).toBe(62);
	});
});
