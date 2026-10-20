// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import {
	blockerText,
	cinetteEntries,
	keepOrder,
	shortId,
	cinetteId,
	LOCAL_ENTRY,
	groupEntries,
	isDisabled,
	keepWarning,
	statusText,
	type PickerEntry,
} from "./device-picker";

const local: PickerEntry = { id: "local", kind: "local", name: "This device" };
const tv: PickerEntry = {
	id: "cinette:tv",
	kind: "cinette",
	name: "Living Room",
	deviceType: "fire-tv",
};
const mac: PickerEntry = { id: "cinette:mac", kind: "cinette", name: "Den", deviceType: "mac" };
const chromecast: PickerEntry = { id: "cast:1", kind: "cast", name: "Bedroom TV" };
const airplay: PickerEntry = { id: "airplay:1", kind: "airplay", name: "Samsung", opens: true };

describe("groupEntries", () => {
	it("orders the groups and gives each but this device a heading", () => {
		const groups = groupEntries([airplay, chromecast, mac, tv, local]);
		expect(groups.map((g) => [g.kind, g.heading, g.entries.map((e) => e.id)])).toEqual([
			["local", null, ["local"]],
			["cinette", "Cinette devices", ["cinette:tv", "cinette:mac"]],
			["cast", "Google Cast", ["cast:1"]],
			["airplay", "AirPlay", ["airplay:1"]],
		]);
	});

	it("leaves out groups with nothing in them", () => {
		expect(groupEntries([local, chromecast]).map((g) => g.kind)).toEqual(["local", "cast"]);
		expect(groupEntries([])).toEqual([]);
	});
});

describe("statusText", () => {
	it("names a Cinette device's type when there's no status", () => {
		expect(statusText(tv)).toBe("Fire TV");
		expect(statusText({ ...tv, deviceType: undefined })).toBeNull();
		expect(statusText(local)).toBeNull();
		expect(statusText({ ...chromecast, deviceType: "mac" })).toBeNull();
	});

	it("says how the item would get there", () => {
		const text = (status: PickerEntry["status"]) => statusText({ ...chromecast, status });
		expect(text("checking")).toBe("Checking…");
		expect(text("unavailable")).toBe("Not available");
		expect(text({ via: "direct" })).toBe("Plays directly");
		expect(text({ via: "converted", keep: "on" })).toBe("This computer has to stay on");
		expect(text({ via: "converted", keep: "onScreen" })).toBe("Keep Cinette open");
		expect(text({ blocked: "audioCodec", detail: "dts" })).toBe("Can't play this sound (dts)");
	});
});

describe("blockerText", () => {
	it("says why for every blocker, naming the format when known", () => {
		expect(blockerText("container", "mkv")).toBe("Can't play this format (mkv)");
		expect(blockerText("container")).toBe("Can't play this format");
		expect(blockerText("videoCodec", "mpeg2")).toBe("Can't play this video (mpeg2)");
		expect(blockerText("interlaced")).toBe("Can't play interlaced video");
		expect(blockerText("audioCodec")).toBe("Can't play this sound");
		expect(blockerText("audioOnly")).toBe("Doesn't play sound on its own");
		expect(blockerText("cors")).toBe("The provider doesn't allow it");
		expect(blockerText("unreachable")).toBe("Couldn't reach the stream");
		expect(blockerText("notFound")).toBe("Doesn't have this");
	});
});

describe("isDisabled", () => {
	it("disables rows that are checking, blocked or unavailable", () => {
		const disabled = (status: PickerEntry["status"]) => isDisabled({ ...chromecast, status });
		expect(disabled(undefined)).toBe(false);
		expect(disabled({ via: "direct" })).toBe(false);
		expect(disabled({ via: "converted", keep: "on" })).toBe(false);
		expect(disabled("checking")).toBe(true);
		expect(disabled("unavailable")).toBe(true);
		expect(disabled({ blocked: "cors" })).toBe(true);
	});
});

describe("keepWarning", () => {
	it("warns only before a converted route", () => {
		expect(keepWarning({ ...chromecast, status: { via: "converted", keep: "on" } })).toBe(
			"Casting this to Bedroom TV needs this computer to stay on and connected. Closing the lid ends it."
		);
		expect(keepWarning({ ...chromecast, status: { via: "converted", keep: "onScreen" } })).toBe(
			"Casting this to Bedroom TV needs Cinette to stay open on this device."
		);
		for (const status of [
			undefined,
			"checking",
			"unavailable",
			{ via: "direct" },
			{ blocked: "cors" },
		] as PickerEntry["status"][]) {
			expect(keepWarning({ ...chromecast, status })).toBeNull();
		}
	});
});

describe("shortId and tags", () => {
	it("shows the start of the id after the row's line", () => {
		expect(shortId("abcdefghij")).toBe("ID abcdef");
		expect(statusText({ ...tv, tag: "ID abcdef" })).toBe("Fire TV · ID abcdef");
		expect(statusText({ ...tv, deviceType: undefined, tag: "ID abcdef" })).toBe("ID abcdef");
		expect(statusText({ ...tv, status: "unavailable", tag: "ID x" })).toBe(
			"Not available · ID x"
		);
	});
});

describe("keepOrder", () => {
	it("keeps rows where they were and puts new ones after", () => {
		const row = (id: string): PickerEntry => ({ id, kind: "cinette", name: id });
		const groups = groupEntries([
			LOCAL_ENTRY,
			row("cinette:a"),
			row("cinette:new"),
			row("cinette:b"),
		]);
		const kept = keepOrder(groups, ["local", "cinette:b", "cinette:a"]);
		expect(kept.map((g) => g.entries.map((e) => e.id))).toStrictEqual([
			["local"],
			["cinette:b", "cinette:a", "cinette:new"],
		]);
		expect(kept[1].heading).toBe("Cinette devices");
		// The first id held stays first too.
		expect(
			keepOrder(groups, ["cinette:b", "cinette:a"])[1].entries.map((e) => e.id)
		).toStrictEqual(["cinette:b", "cinette:a", "cinette:new"]);
		expect(
			groups[1].entries.map((e) => e.id),
			"the groups given stay as they were"
		).toStrictEqual(["cinette:a", "cinette:b", "cinette:new"]);
	});
});

describe("cinetteEntries", () => {
	it("lists this device first, then each Cinette device", () => {
		const device = {
			deviceId: "tv",
			name: "Living Room",
			deviceType: "fire-tv",
			controlAllowed: true,
			available: true,
		};
		expect(
			cinetteEntries([
				device,
				{ ...device, deviceId: "gone", available: false },
				{ ...device, deviceId: "never", controlAllowed: false },
			])
		).toStrictEqual([
			{ id: "local", kind: "local", name: "This device" },
			{
				id: "cinette:tv",
				kind: "cinette",
				name: "Living Room",
				deviceType: "fire-tv",
				tag: "ID tv",
			},
			{
				id: "cinette:gone",
				kind: "cinette",
				name: "Living Room",
				deviceType: "fire-tv",
				status: "unavailable",
				tag: "ID gone",
			},
			{
				id: "cinette:never",
				kind: "cinette",
				name: "Living Room",
				deviceType: "fire-tv",
				status: "unavailable",
				why: "Doesn't allow remote control",
				tag: "ID never",
			},
		]);
		// A name of its own needs no id.
		expect(cinetteEntries([device])[1]).toStrictEqual({
			id: "cinette:tv",
			kind: "cinette",
			name: "Living Room",
			deviceType: "fire-tv",
		});
		expect(cinetteId("x")).toBe("cinette:x");
		expect(LOCAL_ENTRY.id).toBe("local");
	});
});
