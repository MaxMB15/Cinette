// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import { saveProgressNow, setProgressSaver } from "./player-progress";

describe("saveProgressNow", () => {
	it("is null with no player", async () => {
		expect(await saveProgressNow()).toBeNull();
	});

	it("saves through the mounted player and gives its channel", async () => {
		const stop = setProgressSaver(async () => "ch-1");
		expect(await saveProgressNow()).toBe("ch-1");
		stop();
		expect(await saveProgressNow()).toBeNull();
	});

	it("is null when saving fails", async () => {
		const stop = setProgressSaver(() => Promise.reject(new Error("down")));
		expect(await saveProgressNow()).toBeNull();
		stop();
	});

	it("keeps a newer saver when an older one is taken back", async () => {
		const stopOld = setProgressSaver(async () => "old");
		const stopNew = setProgressSaver(async () => "new");
		stopOld();
		expect(await saveProgressNow()).toBe("new");
		stopNew();
	});
});
