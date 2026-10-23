// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * Copying history and sending providers between Cinette devices: what the
 * dialogs say, and how a send moves along on the device that asked.
 */

import { getPlatform, isMobilePlatform } from "@/lib/platform";
import type { Platform, Provider } from "@/lib/types";
import type {
	ProviderResult,
	RemoteAsked,
	RemoteProvidersAdded,
	TransferCounts,
	TransferReport,
	TransferTally,
	TransferWhat,
	RemoteErrorCode,
	RemoteTransferNotice,
} from "@/lib/tauri";

/** The consent dialog's title, as the words before and after the asking
 *  device's name, which the dialog shows apart so it reads right in any
 *  script. */
export const consentTitle = (asked: RemoteAsked | undefined): [string, string] => {
	if (!asked) return ["Allow “", "” to control this device?"];
	if (asked.kind === "providers") {
		return asked.providers.length === 1
			? ["Add a provider from “", "”?"]
			: [`Add ${asked.providers.length} providers from “`, "”?"];
	}
	return asked.direction === "send"
		? ["Add history from “", "” to this device?"]
		: ["Let “", "” copy this device's history?"];
};

/** "a, b and c". */
export const listOf = (items: string[]): string => {
	if (items.length <= 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
};

/** What a history request covers, as words. */
const parts = (asked: Extract<RemoteAsked, { kind: "history" }>): string => {
	const counted = (label: string, n: number | undefined) =>
		n === undefined ? label : `${label} (${n})`;
	const c = asked.counts;
	const list: string[] = [];
	if (asked.what.history) list.push(counted("watch history", c?.history));
	if (asked.what.favorites) list.push(counted("favorites", c?.favorites));
	if (asked.what.pins) list.push(counted("pinned groups", c?.pins));
	return listOf(list);
};

/** The consent dialog's explanation, under the title. */
export const consentBody = (deviceType: string, asked: RemoteAsked | undefined): string => {
	if (!asked) {
		return `${deviceType} on your network. It will be able to play, pause and choose what plays here, and see what this device can play. Only allow it if the code matches the one on that device. Deny blocks it until you unblock it in Settings.`;
	}
	if (asked.kind === "providers") {
		const names = listOf(asked.providers.map((p) => `“${p.name}”`));
		return `${names}, with ${asked.providers.length === 1 ? "its login" : "their logins"}, will be saved on this device as its own. Only allow it if the code matches the one on that device.`;
	}
	return asked.direction === "send"
		? `Its ${parts(asked)} will be added to this device's own. Nothing here is deleted. Only allow it if the code matches the one on that device.`
		: `It will get a copy of this device's ${parts(asked)}. Provider logins aren't part of it. Only allow it if the code matches the one on that device.`;
};

/**
 * What a transfer sheet adds on a phone, tablet or TV while it waits or
 * moves data: the system may stop an app that's left, and a transfer that
 * stops writes nothing. iOS gives a transfer about 30 seconds after the app
 * is left. Computers keep it running.
 */
export const stayOpenNote = (platform: Platform = getPlatform()): string | null =>
	isMobilePlatform(platform)
		? "Keep Cinette open until it's done. If it stops, nothing is changed on either device."
		: null;

/** Why another device didn't take a transfer, as a sentence. */
export const refusalText = (name: string, code: RemoteErrorCode): string => {
	switch (code) {
		case "denied":
			return `${name} said no.`;
		case "expired":
			return `No one answered on ${name} in time.`;
		case "busy":
			return `${name} is busy with another request. Try again in a moment.`;
		case "cancelled":
			return "It was cancelled.";
		case "unsupported":
			return `${name} can't take this. It may need a newer Cinette.`;
		case "too_large":
			return `That's more than one transfer can carry. Nothing was changed on ${name}.`;
		default:
			return `It didn't work. Nothing was changed on ${name}.`;
	}
};

/** One sent provider's line in the result. */
export const providerResultText = (result: ProviderResult, device: string): string => {
	switch (result.outcome) {
		case "added":
			return result.savedAs ? `Added as “${result.savedAs}”` : "Added";
		case "exists":
			return `Already on ${device}`;
		case "failed":
			return result.error ?? `Couldn't add it on ${device}`;
		default:
			return "Unknown";
	}
};

/** Where sending providers stands on the device that asked. */
export type SendState =
	| { step: "choosing" }
	| { step: "asking" }
	| { step: "waiting"; expiresAt: number }
	| { step: "saving" }
	| { step: "done"; results: ProviderResult[] }
	| { step: "failed"; message: string };

/** The send after a `remote://transfer` notice for its link. `now` is
 *  `performance.now()`. */
export const nextSendState = (
	state: SendState,
	notice: RemoteTransferNotice,
	device: string,
	now: number
): SendState => {
	// Before asking, or once it's over, nothing changes it.
	if (state.step === "choosing" || state.step === "done" || state.step === "failed") return state;
	switch (notice.step) {
		case "pending":
			return { step: "waiting", expiresAt: now + notice.expiresInMs };
		case "refused":
			return { step: "failed", message: refusalText(device, notice.code) };
		// History transfer steps, which a send never gets.
		case "preview":
		case "granted":
			return state;
		case "progress": {
			const progress = notice.progress;
			if (progress.state === "providersDone") return { step: "done", results: progress.data };
			if (progress.state === "failed")
				return { step: "failed", message: refusalText(device, progress.data) };
			return { step: "saving" };
		}
	}
};

/** A playlist that's a file on this device, which no other device can open. */
export const isLocalFile = (provider: Pick<Provider, "type" | "url">): boolean =>
	provider.type === "m3u" && provider.url.trim().startsWith("file:");

/** What this device says when another one's providers were saved here. */
export const providersAddedText = ({ from, names }: RemoteProvidersAdded): string => {
	const quoted = names.map((n) => `“${n}”`);
	return names.length === 1
		? `Added ${quoted[0]} from ${from}.`
		: `Added ${names.length} providers from ${from}: ${listOf(quoted)}.`;
};

/** What a history transfer would copy, with how many of each when known. */
export const countsText = (what: TransferWhat, counts?: TransferCounts): string => {
	const counted = (label: string, n: number | undefined) =>
		n === undefined ? label : `${label} (${n})`;
	const list: string[] = [];
	if (what.history) {
		list.push(counted("watch history", counts?.history));
		list.push(counted("saved places", counts?.positions));
	}
	if (what.favorites) list.push(counted("favorites", counts?.favorites));
	if (what.pins) list.push(counted("pinned groups", counts?.pins));
	return listOf(list);
};

/** Shown before a history transfer, on the device that asks. It names the
 *  device the history goes to. */
export const historyPrivacy = (direction: "send" | "import", device: string): string => {
	const to = direction === "send" ? device : "this device";
	const from = direction === "send" ? "this device" : device;
	return `Watch history, playback positions, favorites and pinned groups are copied between your devices over the encrypted connection. Provider logins, API keys and passwords aren't part of it. Copied history becomes part of ${to}'s own history. Cinette has no accounts, so it stays on ${to} and doesn't sync anywhere else. Nothing is deleted on ${from}.`;
};

/** One line of a history transfer's result, or null when nothing happened. */
const tallyLine = (label: string, t: TransferTally): string | null => {
	const parts: string[] = [];
	if (t.added) parts.push(`${t.added} added`);
	if (t.updated) parts.push(`${t.updated} updated`);
	if (t.unchanged) parts.push(`${t.unchanged} already there`);
	return parts.length ? `${label}: ${parts.join(", ")}` : null;
};

/** What a history transfer did, a line for each kind it changed or checked. */
export const reportLines = (report: TransferReport): string[] => {
	const lines = [
		tallyLine("Watch history", report.history),
		tallyLine("Saved places", report.positions),
		tallyLine("Favorites", report.favorites),
		tallyLine("Pinned groups", report.pins),
	].filter((line): line is string => line !== null);
	return lines.length ? lines : ["Nothing to copy."];
};

/** How many unmatched items the result lists. */
export const UNMATCHED_SHOWN = 20;

/** The unmatched items to list, and a line for the rest, if any. */
export const unmatchedLines = (
	report: TransferReport
): { items: string[]; more: string | null } => {
	const items = report.unmatched
		.slice(0, UNMATCHED_SHOWN)
		.map((u) =>
			u.reason === "ambiguous"
				? `${u.name} (more than one match)`
				: u.reason === "invalid"
					? `${u.name} (its details didn't make sense)`
					: u.name
		);
	const rest = report.unmatchedTotal - items.length;
	return { items, more: rest > 0 ? `and ${rest} more` : null };
};

/** Where a history transfer stands on the device that asked. */
export type HistoryState =
	| { step: "choosing" }
	| { step: "asking" }
	| { step: "waiting"; expiresAt: number }
	| { step: "preview"; transfer: string; counts: TransferCounts }
	| { step: "starting" }
	| { step: "moving"; done: number; total: number | null }
	| { step: "saving" }
	| { step: "done"; report: TransferReport }
	| { step: "failed"; message: string };

/** The transfer after a `remote://transfer` notice for its link. `now` is
 *  `performance.now()`. */
export const nextHistoryState = (
	state: HistoryState,
	notice: RemoteTransferNotice,
	device: string,
	now: number
): HistoryState => {
	if (state.step === "choosing" || state.step === "done" || state.step === "failed") return state;
	switch (notice.step) {
		case "pending":
			return { step: "waiting", expiresAt: now + notice.expiresInMs };
		case "refused":
			return { step: "failed", message: refusalText(device, notice.code) };
		case "preview":
			return { step: "preview", transfer: notice.transfer, counts: notice.counts };
		// Allowed: the export is being made, which can take a moment.
		case "granted":
			return { step: "moving", done: 0, total: null };
		case "progress": {
			const p = notice.progress;
			switch (p.state) {
				case "sending":
					return { step: "moving", done: p.data.done, total: p.data.total };
				case "receiving":
					return { step: "moving", done: p.data.received, total: null };
				case "saving":
					return { step: "saving" };
				case "done":
					return { step: "done", report: p.data as TransferReport };
				case "failed":
					return { step: "failed", message: refusalText(device, p.data) };
				default:
					return state;
			}
		}
	}
};
