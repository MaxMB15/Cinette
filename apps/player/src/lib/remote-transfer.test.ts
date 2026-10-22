// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import {
	consentBody,
	consentTitle,
	isLocalFile,
	listOf,
	nextSendState,
	providersAddedText,
	providerResultText,
	refusalText,
	type SendState,
} from "./remote-transfer";
import type { RemoteAsked, RemoteTransferNotice } from "./tauri";

const ALL = { history: true, favorites: true, pins: true };

const providers = (...names: string[]): RemoteAsked => ({
	kind: "providers",
	providers: names.map((name) => ({ name, kind: "xtream" })),
});

describe("consentTitle", () => {
	const title = (asked: RemoteAsked | undefined) => consentTitle(asked).join("Mac");

	it("asks about control without a transfer", () => {
		expect(title(undefined)).toBe("Allow “Mac” to control this device?");
	});

	it("counts providers", () => {
		expect(title(providers("Home"))).toBe("Add a provider from “Mac”?");
		expect(title(providers("Home", "Sports"))).toBe("Add 2 providers from “Mac”?");
	});

	it("says which way history goes", () => {
		expect(title({ kind: "history", direction: "send", what: ALL })).toBe(
			"Add history from “Mac” to this device?"
		);
		expect(title({ kind: "history", direction: "import", what: ALL })).toBe(
			"Let “Mac” copy this device's history?"
		);
	});
});

describe("listOf", () => {
	it("joins with commas and a last and", () => {
		expect(listOf([])).toBe("");
		expect(listOf(["a"])).toBe("a");
		expect(listOf(["a", "b"])).toBe("a and b");
		expect(listOf(["a", "b", "c"])).toBe("a, b and c");
	});
});

describe("consentBody", () => {
	it("explains control", () => {
		expect(consentBody("Mac", undefined)).toBe(
			"Mac on your network. It will be able to play, pause and choose what plays here, and see what this device can play. Only allow it if the code matches the one on that device."
		);
	});

	it("names the providers and says their logins come too", () => {
		expect(consentBody("Mac", providers("Home"))).toBe(
			"“Home”, with its login, will be saved on this device as its own. Only allow it if the code matches the one on that device."
		);
		expect(consentBody("Mac", providers("Home", "Sports"))).toBe(
			"“Home” and “Sports”, with their logins, will be saved on this device as its own. Only allow it if the code matches the one on that device."
		);
	});

	it("lists what history is added, with counts when it has them", () => {
		expect(
			consentBody("Mac", {
				kind: "history",
				direction: "send",
				what: ALL,
				counts: { history: 120, positions: 3, favorites: 15, pins: 4 },
			})
		).toBe(
			"Its watch history (120), favorites (15) and pinned groups (4) will be added to this device's own. Nothing here is deleted. Only allow it if the code matches the one on that device."
		);
	});

	it("lists only what was picked to copy", () => {
		expect(
			consentBody("Mac", {
				kind: "history",
				direction: "import",
				what: { history: false, favorites: true, pins: false },
			})
		).toBe(
			"It will get a copy of this device's favorites. Provider logins aren't part of it. Only allow it if the code matches the one on that device."
		);
		expect(
			consentBody("Mac", {
				kind: "history",
				direction: "import",
				what: { history: true, favorites: false, pins: true },
			})
		).toContain("watch history and pinned groups.");
	});
});

describe("refusalText", () => {
	it("turns each code into a sentence", () => {
		expect(refusalText("TV", "denied")).toBe("TV said no.");
		expect(refusalText("TV", "expired")).toBe("No one answered on TV in time.");
		expect(refusalText("TV", "busy")).toBe(
			"TV is busy with another request. Try again in a moment."
		);
		expect(refusalText("TV", "cancelled")).toBe("It was cancelled.");
		expect(refusalText("TV", "unsupported")).toBe(
			"TV can't take this. It may need a newer Cinette."
		);
		expect(refusalText("TV", "failed")).toBe("It didn't work. Nothing was changed on TV.");
	});
});

describe("providerResultText", () => {
	it("says what became of each provider", () => {
		expect(providerResultText({ name: "Home", outcome: "added" }, "TV")).toBe("Added");
		expect(
			providerResultText({ name: "Home", outcome: "added", savedAs: "Home (from Mac)" }, "TV")
		).toBe("Added as “Home (from Mac)”");
		expect(providerResultText({ name: "Home", outcome: "exists" }, "TV")).toBe("Already on TV");
		expect(
			providerResultText({ name: "Home", outcome: "failed", error: "It didn't load." }, "TV")
		).toBe("It didn't load.");
		expect(providerResultText({ name: "Home", outcome: "failed" }, "TV")).toBe(
			"Couldn't add it on TV"
		);
		expect(providerResultText({ name: "Home", outcome: "unknown" }, "TV")).toBe("Unknown");
	});
});

describe("nextSendState", () => {
	const notice = (rest: object) => ({ deviceId: "d", link: 1, ...rest }) as RemoteTransferNotice;

	it("waits for the other device once it asks its user", () => {
		expect(
			nextSendState(
				{ step: "asking" },
				notice({ step: "pending", expiresInMs: 30000 }),
				"TV",
				5
			)
		).toEqual({ step: "waiting", expiresAt: 30005 });
	});

	it("says why it was refused", () => {
		expect(
			nextSendState(
				{ step: "waiting", expiresAt: 1 },
				notice({ step: "refused", code: "denied" }),
				"TV",
				0
			)
		).toEqual({ step: "failed", message: "TV said no." });
	});

	it("saves, then shows the results", () => {
		const saving = nextSendState(
			{ step: "waiting", expiresAt: 1 },
			notice({ step: "progress", transfer: "t", progress: { state: "saving" } }),
			"TV",
			0
		);
		expect(saving).toEqual({ step: "saving" });
		const results = [{ name: "Home", outcome: "added" as const }];
		expect(
			nextSendState(
				saving,
				notice({
					step: "progress",
					transfer: "t",
					progress: { state: "providersDone", data: results },
				}),
				"TV",
				0
			)
		).toEqual({ step: "done", results });
	});

	it("fails with the transfer's own code", () => {
		expect(
			nextSendState(
				{ step: "saving" },
				notice({
					step: "progress",
					transfer: "t",
					progress: { state: "failed", data: "expired" },
				}),
				"TV",
				0
			)
		).toEqual({ step: "failed", message: "No one answered on TV in time." });
	});

	it("ignores notices before asking and after the end", () => {
		const pending = notice({ step: "pending", expiresInMs: 1 });
		for (const state of [
			{ step: "choosing" },
			{ step: "done", results: [] },
			{ step: "failed", message: "x" },
		] as SendState[]) {
			expect(nextSendState(state, pending, "TV", 0)).toBe(state);
		}
	});
});

describe("isLocalFile", () => {
	it("is an M3U playlist with a file address", () => {
		expect(isLocalFile({ type: "m3u", url: " file:///home/me/a.m3u" })).toBe(true);
		expect(isLocalFile({ type: "m3u", url: "http://lists.example/a.m3u" })).toBe(false);
		expect(isLocalFile({ type: "xtream", url: "file:///x" })).toBe(false);
	});
});

describe("providersAddedText", () => {
	it("names what was added and where it came from", () => {
		expect(providersAddedText({ from: "Mac", names: ["Home"] })).toBe("Added “Home” from Mac.");
		expect(providersAddedText({ from: "Mac", names: ["Home", "Sports"] })).toBe(
			"Added 2 providers from Mac: “Home” and “Sports”."
		);
	});
});
