// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * What the player needs to cast: the Cast group's rows in the device
 * picker, each with how the current item would get there, and what to say
 * when a cast can't start or ends by itself.
 */

import { tvFailureMessage, type DestinationStatus, type PickerEntry } from "@/lib/device-picker";
import type { RouteDecision } from "@/lib/route";
import type { CastReceiver, CastReceiverList, CastUpdate } from "@/lib/tauri";

/** The newer of two receiver lists. Events and the first reply can arrive
 *  in any order. */
export const newerList = (
	current: CastReceiverList | null,
	next: CastReceiverList
): CastReceiverList => (current && current.revision >= next.revision ? current : next);

/** A route decision as the picker row's status. */
export const castStatus = (decision: RouteDecision): DestinationStatus => {
	if (!decision.ok) return { blocked: decision.reason, detail: decision.detail };
	if (decision.route.via === "converted") return { via: "converted", keep: decision.route.keep };
	return { via: "direct" };
};

/** The Cast group's rows. A receiver that went away or can't be reached is
 *  listed as unavailable. Otherwise its row shows `statuses`, or that it's
 *  still checking. */
export const castEntries = (
	receivers: readonly CastReceiver[],
	statuses: ReadonlyMap<string, DestinationStatus>
): PickerEntry[] =>
	receivers.map((r) => ({
		id: r.id,
		kind: "cast",
		name: r.name,
		status: r.available ? (statuses.get(r.id) ?? "checking") : "unavailable",
		...(r.available ? {} : { why: "Can't be reached" }),
	}));

/** What to say when a cast to `name` was lost, from why it closed. */
export const castEndedMessage = (
	name: string,
	reason: Extract<CastUpdate, { kind: "closed" }>["reason"] | null
): string => {
	switch (reason) {
		case "appStopped":
			return `Playback was stopped on ${name}.`;
		case "launchFailed":
			return `${name} couldn't start the Cast player.`;
		default:
			return `Lost the connection to ${name}.`;
	}
};

/** What the picker says while macOS keeps Cinette off the local network. */
export const CAST_NETWORK_DENIED =
	"Cinette can't look for Cast devices. Allow it under Local Network in System Settings, Privacy & Security.";

/** What a picker says when a VPN may be what hides the devices. */
export const VPN_HINT =
	"A VPN is on. Many VPN apps block devices on this network unless an option such as Allow LAN or Local network sharing is on.";

/** What the Cast picker needs to know to say why it shows what it does. */
interface CastLookout {
	receivers: readonly CastReceiver[];
	localNetworkDenied: boolean;
	vpnActive: boolean;
}

/** The line above the Cast picker's rows, or `null`: why it can't look,
 *  or why it may have found nothing or can't reach a receiver. */
export const castPickerNotice = (cast: CastLookout): string | null => {
	if (cast.localNetworkDenied) return CAST_NETWORK_DENIED;
	const missing = cast.receivers.length === 0 || cast.receivers.some((r) => !r.available);
	if (cast.vpnActive && missing) return VPN_HINT;
	return null;
};

/** Whether the player shows its Cast button: only when there's a receiver
 *  to pick. Settings and the Devices picker say when Cinette can't look. */
export const showsCastButton = (cast: Pick<CastLookout, "receivers">): boolean =>
	cast.receivers.length > 0;

/** What to say when a control for the receiver failed. Play after a long
 *  pause converts again, so it fails as a cast that didn't start does. */
export const castControlMessage = (name: string, error: unknown): string =>
	tvFailureMessage(name, error, `${name} didn't respond.`);
