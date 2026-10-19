// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import { createTally } from "./tally";

describe("createTally", () => {
	it("lists the counts largest first, then by name", () => {
		const tally = createTally();
		for (const name of ["b", "a", "c", "c", "b", "c"]) tally.add(name);
		tally.add("d");
		expect(tally.entries()).toEqual([
			["c", 3],
			["b", 2],
			["a", 1],
			["d", 1],
		]);
	});

	it("starts again from nothing after a reset", () => {
		const tally = createTally();
		tally.add("a");
		tally.reset();
		expect(tally.entries()).toEqual([]);
		tally.add("a");
		expect(tally.entries()).toEqual([["a", 1]]);
	});
});
