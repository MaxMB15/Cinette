// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import { flowsToMarkdown } from "./flow-report";

describe("flowsToMarkdown", () => {
	it("sums each flow, then lists its top components and every command", () => {
		const md = flowsToMarkdown(
			[
				{
					flow: "Open",
					commits: 3,
					renders: { App: 3, List: 2, Row: 1 },
					invokes: { get_providers: 1, get_all_channels: 2 },
				},
				{ flow: "Idle", commits: 0, renders: {}, invokes: {} },
			],
			2
		);
		expect(md).toBe(
			[
				"| Flow | Commits | Renders | Backend calls |",
				"|---|---:|---:|---:|",
				"| Open | 3 | 6 | 3 |",
				"| Idle | 0 | 0 | 0 |",
				"",
				"### Open",
				"",
				"| Component | Renders |",
				"|---|---:|",
				"| App | 3 |",
				"| List | 2 |",
				"",
				"| Command | Calls |",
				"|---|---:|",
				"| get_providers | 1 |",
				"| get_all_channels | 2 |",
				"",
				"### Idle",
				"",
				"| Component | Renders |",
				"|---|---:|",
				"",
				"| Command | Calls |",
				"|---|---:|",
			].join("\n")
		);
	});

	it("lists twelve components by default", () => {
		const renders = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`C${i}`, 1]));
		const md = flowsToMarkdown([{ flow: "Many", commits: 1, renders, invokes: {} }]);
		expect(md).toContain("| C11 | 1 |");
		expect(md).not.toContain("| C12 | 1 |");
	});
});
