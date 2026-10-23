// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import {
	CAST_NETWORK_DENIED,
	castControlMessage,
	castEndedMessage,
	castPickerNotice,
	showsCastButton,
	VPN_HINT,
	castEntries,
	castFailureMessage,
	castStatus,
	newerList,
} from "@/lib/cast";
import type { CastReceiver, CastReceiverList } from "@/lib/tauri";

const receiver = (id: string, name: string, available = true): CastReceiver => ({
	id,
	name,
	model: "Chromecast",
	status: null,
	available,
});

const list = (revision: number): CastReceiverList => ({
	revision,
	receivers: [receiver(`cast:${revision}`, "TV")],
	localNetworkDenied: false,
});

describe("newerList", () => {
	it("keeps whichever list is newer, whatever order they came in", () => {
		expect(newerList(null, list(1))).toEqual(list(1));
		expect(newerList(list(2), list(1))).toEqual(list(2));
		expect(newerList(list(1), list(2))).toEqual(list(2));
		const same = list(3);
		expect(newerList(same, list(3))).toBe(same);
	});
});

describe("castStatus", () => {
	it("tells a direct route from a converted one, and says why one can't go", () => {
		expect(castStatus({ ok: true, route: { via: "direct", format: 0 } })).toEqual({
			via: "direct",
		});
		expect(
			castStatus({
				ok: true,
				route: {
					via: "converted",
					format: 1,
					video: "copy",
					audio: "aac",
					output: "matroska",
					keep: "on",
				},
			})
		).toEqual({ via: "converted", keep: "on" });
		expect(castStatus({ ok: false, reason: "container", detail: "avi" })).toEqual({
			blocked: "container",
			detail: "avi",
		});
	});
});

describe("castEntries", () => {
	it("checks each receiver until its route is known, and greys out one that's gone", () => {
		const statuses = new Map([["cast:a", { via: "direct" as const }]]);
		expect(
			castEntries(
				[
					receiver("cast:a", "Lounge"),
					receiver("cast:b", "Den"),
					receiver("cast:c", "Old", false),
				],
				statuses
			)
		).toEqual([
			{ id: "cast:a", kind: "cast", name: "Lounge", status: { via: "direct" } },
			{ id: "cast:b", kind: "cast", name: "Den", status: "checking" },
			{
				id: "cast:c",
				kind: "cast",
				name: "Old",
				status: "unavailable",
				why: "Can't be reached",
			},
		]);
	});
});

describe("castFailureMessage", () => {
	it("says why each kind of failure happened", () => {
		expect(castFailureMessage("TV", "unreachable")).toBe("Couldn't reach TV.");
		expect(castFailureMessage("TV", "notFound")).toBe("Couldn't reach TV.");
		expect(castFailureMessage("TV", "refused")).toBe(
			"The provider refused the stream. The login may have expired."
		);
		for (const code of ["noConverter", "noEncoder", "unsupported"])
			expect(castFailureMessage("TV", code)).toBe(
				"This computer can't convert this stream for TV."
			);
		expect(castFailureMessage("TV", "noRoute")).toBe(
			"This computer has no network address TV can reach."
		);
		expect(castFailureMessage("TV", new Error("x"))).toBe("Couldn't play it on TV.");
	});
});

describe("castEndedMessage", () => {
	it("says why a cast was lost", () => {
		expect(castEndedMessage("TV", null)).toBe("Lost the connection to TV.");
		expect(castEndedMessage("TV", "stopped")).toBe("Lost the connection to TV.");
		expect(castEndedMessage("TV", "appStopped")).toBe("Playback was stopped on TV.");
		expect(castEndedMessage("TV", "launchFailed")).toBe("TV couldn't start the Cast player.");
		for (const reason of ["timeout", "protocol", "connectionLost"] as const)
			expect(castEndedMessage("TV", reason)).toBe("Lost the connection to TV.");
	});
});

describe("castPickerNotice and showsCastButton", () => {
	const lookout = (over: Partial<Parameters<typeof castPickerNotice>[0]> = {}) => ({
		receivers: [receiver("cast:a", "TV")],
		localNetworkDenied: false,
		vpnActive: false,
		...over,
	});

	it("says why the picker can't look, or may miss a device behind a VPN", () => {
		expect(castPickerNotice(lookout())).toBeNull();
		expect(castPickerNotice(lookout({ localNetworkDenied: true, vpnActive: true }))).toBe(
			CAST_NETWORK_DENIED
		);
		expect(castPickerNotice(lookout({ vpnActive: true }))).toBeNull();
		expect(castPickerNotice(lookout({ vpnActive: true, receivers: [] }))).toBe(VPN_HINT);
		expect(CAST_NETWORK_DENIED).toBe(
			"Cinette can't look for Cast devices. Allow it under Local Network in System Settings, Privacy & Security."
		);
		// One receiver that can't be reached is enough.
		expect(
			castPickerNotice(
				lookout({
					vpnActive: true,
					receivers: [receiver("cast:a", "TV"), receiver("cast:b", "Den", false)],
				})
			)
		).toBe(VPN_HINT);
		expect(
			castPickerNotice(
				lookout({ vpnActive: true, receivers: [receiver("cast:a", "TV", false)] })
			)
		).toBe(VPN_HINT);
		expect(castPickerNotice(lookout({ receivers: [] }))).toBeNull();
	});

	it("shows the button only for a receiver, whatever hid the rest", () => {
		expect(showsCastButton(lookout())).toBe(true);
		expect(showsCastButton(lookout({ vpnActive: true, localNetworkDenied: true }))).toBe(true);
		expect(showsCastButton(lookout({ receivers: [] }))).toBe(false);
		expect(showsCastButton(lookout({ receivers: [], vpnActive: true }))).toBe(false);
		expect(showsCastButton(lookout({ receivers: [], localNetworkDenied: true }))).toBe(false);
	});
});

describe("castControlMessage", () => {
	it("explains a load that failed, and anything else as no answer", () => {
		for (const code of [
			"unreachable",
			"notFound",
			"refused",
			"noConverter",
			"noEncoder",
			"unsupported",
			"noRoute",
			"converterFailed",
		])
			expect(castControlMessage("TV", code)).toBe(castFailureMessage("TV", code));
		expect(castControlMessage("TV", "converterFailed")).toBe("Couldn't play it on TV.");
		expect(castControlMessage("TV", "notConnected")).toBe("TV didn't respond.");
	});
});
