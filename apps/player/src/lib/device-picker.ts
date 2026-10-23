// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * What the device picker shows for each place video can play: the groups,
 * each row's line under the name, which rows can be chosen, and the warning
 * before a route that keeps this device busy.
 *
 * Rows that can't be chosen stay listed, greyed out, with the reason.
 */

import {
	orderDestinations,
	type DestinationKind,
	type DestinationSummary,
} from "@/lib/destination";
import { deviceTypeName } from "@/lib/remote-devices";
import type { PlayBlocker } from "@/lib/route";

/** How the current item would reach a destination, as far as known. */
export type DestinationStatus =
	| "checking"
	| { via: "direct" }
	| { via: "converted"; keep: "on" | "onScreen" }
	| { blocked: PlayBlocker; detail?: string }
	| "unavailable";

export interface PickerEntry extends DestinationSummary {
	status?: DestinationStatus;
	/** The row opens something else, like the system's AirPlay picker,
	 *  instead of being chosen here. */
	opens?: boolean;
	/** Why an unavailable row is, when there's more to say than that. */
	why?: string;
	/** A short id that tells the row from another with the same name. */
	tag?: string;
}

export interface PickerGroup {
	kind: DestinationKind;
	/** Null for this device, which has no heading. */
	heading: string | null;
	entries: PickerEntry[];
}

const HEADINGS: Record<DestinationKind, string | null> = {
	local: null,
	cinette: "Cinette devices",
	cast: "Google Cast",
	airplay: "AirPlay",
};

/** The entries in the picker's order, split into groups by kind. */
export const groupEntries = (entries: readonly PickerEntry[]): PickerGroup[] => {
	const groups: PickerGroup[] = [];
	for (const entry of orderDestinations(entries)) {
		const last = groups[groups.length - 1];
		if (last?.kind === entry.kind) last.entries.push(entry);
		else groups.push({ kind: entry.kind, heading: HEADINGS[entry.kind], entries: [entry] });
	}
	return groups;
};

/** Why an item can't play somewhere, in a few words. */
export const blockerText = (reason: PlayBlocker, detail?: string): string => {
	const named = detail ? ` (${detail})` : "";
	switch (reason) {
		case "container":
			return `Can't play this format${named}`;
		case "videoCodec":
			return `Can't play this video${named}`;
		case "interlaced":
			return "Can't play interlaced video";
		case "hdr":
			return "Can't convert HDR video";
		case "audioCodec":
			return `Can't play this sound${named}`;
		case "audioOnly":
			return "Doesn't play sound on its own";
		case "cors":
			return "The provider doesn't allow it";
		case "unreachable":
			return "Couldn't reach the stream";
		case "notFound":
			return "Doesn't have this";
	}
};

/** The line under a row's name, or null when there's nothing to say. A
 *  row's tag goes at the end. */
export const statusText = (entry: PickerEntry): string | null => {
	const line = lineText(entry);
	if (!entry.tag) return line;
	return line ? `${line} · ${entry.tag}` : entry.tag;
};

const lineText = (entry: PickerEntry): string | null => {
	const { status } = entry;
	if (status === undefined) {
		return entry.kind === "cinette" && entry.deviceType
			? deviceTypeName(entry.deviceType)
			: null;
	}
	if (status === "checking") return "Checking…";
	if (status === "unavailable") return entry.why ?? "Not available";
	if ("blocked" in status) return blockerText(status.blocked, status.detail);
	if (status.via === "direct") return "Plays directly";
	return status.keep === "on" ? "This computer has to stay on" : "Keep Cinette open";
};

/** A row that is checking, blocked or unavailable can't be chosen. */
export const isDisabled = (entry: PickerEntry): boolean => {
	const { status } = entry;
	if (status === undefined) return false;
	if (status === "checking" || status === "unavailable") return true;
	return "blocked" in status;
};

/** The confirm step's text for a route this device converts, or null when
 *  a row goes straight through. */
export const keepWarning = (entry: PickerEntry): string | null => {
	const { status } = entry;
	if (typeof status !== "object" || !("via" in status) || status.via !== "converted") return null;
	return convertWarning(entry.name, status.keep);
};

/** What the user is asked before this device converts for `name`, from
 *  what it has to do meanwhile. */
export const convertWarning = (name: string, keep: "on" | "onScreen"): string =>
	keep === "on"
		? `Casting this to ${name} needs this computer to stay on and connected. Closing the lid ends it.`
		: `Casting this to ${name} needs Cinette to stay open on this device.`;

/** What the player says when the provider turned the login down. */
export const REFUSED_MESSAGE =
	"The provider refused the stream. The login may have expired, or another device may be using it.";

/** What to say when `name` didn't start playing, from the code its load or
 *  route rejected with. Cast and AirPlay answer the same codes. Anything
 *  else gets `fallback`. */
export const tvFailureMessage = (
	name: string,
	error: unknown,
	fallback = `Couldn't play it on ${name}.`
): string => {
	switch (String(error)) {
		case "unreachable":
		case "notFound":
			return `Couldn't reach ${name}.`;
		case "streamUnreachable":
			return "Couldn't reach the stream to convert it.";
		case "refused":
			return REFUSED_MESSAGE;
		case "noConverter":
		case "noEncoder":
		case "unsupported":
			return `This device can't convert this stream for ${name}.`;
		case "noRoute":
			return `This device has no network address ${name} can reach.`;
		case "converterFailed":
			return "Couldn't convert the stream on this device.";
		default:
			return fallback;
	}
};

/** This device's own row. */
export const LOCAL_ENTRY: PickerEntry = { id: "local", kind: "local", name: "This device" };

/** The picker's id for another Cinette device. */
export const cinetteId = (deviceId: string): string => `cinette:${deviceId}`;

/** A device discovery found, as the picker needs it. */
interface FoundDevice {
	deviceId: string;
	name: string;
	deviceType: string;
	controlAllowed: boolean;
	available: boolean;
}

/** The start of a device id, enough to tell two devices with one name apart. */
export const shortId = (deviceId: string): string => `ID ${deviceId.slice(0, 6)}`;

/** This device's row and one for each Cinette device. One that's gone or
 *  set to Never allow is listed as not available. Devices that share a name
 *  show the start of their ids. */
export const cinetteEntries = (devices: readonly FoundDevice[]): PickerEntry[] => {
	const named = new Map<string, number>();
	for (const d of devices) named.set(d.name, (named.get(d.name) ?? 0) + 1);
	return [
		LOCAL_ENTRY,
		...devices.map((d): PickerEntry => ({
			id: cinetteId(d.deviceId),
			kind: "cinette",
			name: d.name,
			deviceType: d.deviceType,
			...(d.available && d.controlAllowed ? {} : { status: "unavailable" as const }),
			...(d.available && !d.controlAllowed ? { why: "Doesn't allow remote control" } : {}),
			...(named.get(d.name)! > 1 ? { tag: shortId(d.deviceId) } : {}),
		})),
	];
};

/**
 * `groups` with each group's rows in the order of `held`, the ids as they
 * stood when the pointer came over the list, so a row that appears or
 * moves meanwhile can't put another under the pointer. Rows `held` doesn't
 * name go after, in their own order.
 */
export const keepOrder = (groups: PickerGroup[], held: readonly string[]): PickerGroup[] => {
	const at = (id: string) => {
		const i = held.indexOf(id);
		return i < 0 ? held.length : i;
	};
	return groups.map((group) => ({
		...group,
		entries: [...group.entries].sort((a, b) => at(a.id) - at(b.id)),
	}));
};
