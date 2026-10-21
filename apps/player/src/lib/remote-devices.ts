// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/** How remote control names devices and counts down a request. */

import { getPlatform } from "@/lib/platform";
import type { Platform } from "@/lib/types";

const TYPE_NAMES = new Map([
	["mac", "Mac"],
	["linux-pc", "Linux PC"],
	["windows-pc", "Windows PC"],
	["iphone", "iPhone"],
	["ipad", "iPad"],
	["android-phone", "Android phone"],
	["android-tablet", "Android tablet"],
	["android-tv", "Android TV"],
	["fire-tv", "Fire TV"],
]);

/**
 * What the settings add about when other devices can find this one, where
 * that depends on the app being open: on Android, phones and TVs alike.
 */
export const discoveryLimit = (platform: Platform = getPlatform()): string | null =>
	platform === "android" || platform === "tv"
		? "Other devices can only find this one while Cinette is in the foreground."
		: null;

/** A device type as the protocol spells it, like `fire-tv`, in words. */
export const deviceTypeName = (deviceType: string): string =>
	TYPE_NAMES.get(deviceType) ?? "Device";

/** Whether a device of this type is a TV, which the picker lists first. */
export const isTv = (deviceType: string): boolean =>
	deviceType === "android-tv" || deviceType === "fire-tv";

/** Whole seconds left until `expiresAt`, never below 0. Both are
 *  `performance.now()` times. */
export const secondsLeft = (expiresAt: number, now: number): number =>
	Math.max(0, Math.ceil((expiresAt - now) / 1000));

/** A 6-digit code in two groups of three, the way both screens show it. */
export const formatCode = (code: string): string =>
	code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;

/** Why a link ended, as the store keeps it. */
export type Ended = { target: string } | "unreachable" | "lost" | "left";

/** A sentence for a link that ended, or null when this device left. */
export const endedText = (name: string, reason: Ended): string | null => {
	const code = typeof reason === "string" ? reason : reason.target;
	switch (code) {
		case "left":
			return null;
		case "unreachable":
			return `Couldn't reach ${name}. A firewall on that device may be blocking Cinette.`;
		case "denied":
			return `${name} didn't allow it.`;
		case "expired":
			return `${name} didn't answer in time.`;
		case "not_allowed":
			return `${name} doesn't allow remote control.`;
		case "not_discoverable":
			return `${name} isn't taking new connections.`;
		case "revoked":
			return `${name} disconnected this device.`;
		case "busy":
			return `${name} is busy with other requests. Try again in a moment.`;
		case "shutdown":
			return `Cinette closed on ${name}.`;
		case "cancelled":
			return `${name} took a newer connection from this device in place of this one.`;
		case "version":
			return `${name} has a version of Cinette this one can't talk to. Update both.`;
		case "identity_mismatch":
			return `The device that answered isn't ${name}. Nothing was sent to it.`;
		default:
			// Lost, timed out, broke the protocol, or a reason from a newer version.
			return `Lost the connection to ${name}.`;
	}
};

/** The longest device name, in UTF-8 bytes, that goes out whole. */
export const MAX_NAME_BYTES = 63;

/** `typed`, cut to the characters that fit in {@link MAX_NAME_BYTES}. It
 *  cuts by code point, as the core does, so the two agree. */
export const fitName = (typed: string): string => {
	const encoder = new TextEncoder();
	let fitted = "";
	for (const char of typed) {
		if (encoder.encode(fitted + char).length > MAX_NAME_BYTES) break;
		fitted += char;
	}
	return fitted;
};
