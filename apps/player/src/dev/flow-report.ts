// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/** What one measured flow rendered and called. */
export interface FlowResult {
	flow: string;
	commits: number;
	renders: Record<string, number>;
	invokes: Record<string, number>;
}

declare module "vitest" {
	interface TaskMeta {
		/** The measured flows, which vitest.perf.config.ts prints. */
		flows?: FlowResult[];
	}
}

const total = (counts: Record<string, number>) =>
	Object.values(counts).reduce((sum, n) => sum + n, 0);

/**
 * The results as Markdown: a summary table, then for each flow its `top`
 * most rendered components and every backend command it called.
 */
export const flowsToMarkdown = (rows: FlowResult[], top = 12): string => {
	const lines = ["| Flow | Commits | Renders | Backend calls |", "|---|---:|---:|---:|"];
	for (const r of rows) {
		lines.push(`| ${r.flow} | ${r.commits} | ${total(r.renders)} | ${total(r.invokes)} |`);
	}
	for (const r of rows) {
		lines.push("", `### ${r.flow}`, "", "| Component | Renders |", "|---|---:|");
		for (const [name, n] of Object.entries(r.renders).slice(0, top)) {
			lines.push(`| ${name} | ${n} |`);
		}
		lines.push("", "| Command | Calls |", "|---|---:|");
		for (const [name, n] of Object.entries(r.invokes)) lines.push(`| ${name} | ${n} |`);
	}
	return lines.join("\n");
};
