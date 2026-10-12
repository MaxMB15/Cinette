// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { SkipSegment } from "@/lib/types";

/**
 * A skip segment for tests: an intro from 60 to 120 s that SkipDB matched
 * exactly, which the player may skip on its own from 62 to 118 s.
 */
export const makeSegment = (overrides: Partial<SkipSegment> = {}): SkipSegment => ({
	kind: "intro",
	start: 60,
	end: 120,
	source: "skipdb",
	fit: "exact",
	confidence: 0.9,
	offset: 0,
	autoFrom: 62,
	autoTo: 118,
	...overrides,
});
