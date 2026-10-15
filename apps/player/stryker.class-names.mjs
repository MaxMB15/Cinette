// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// A Stryker plugin that leaves out the mutants that only change class names.
// Those are everything in a className attribute and in the arguments of cn()
// and cva(). The tests run in jsdom, which doesn't load Tailwind's CSS, so a
// test could only compare class strings. stryker.config.mjs turns it on.
//
// Stryker counts these mutants as ignored, for the reason below.
// scripts/stryker-summary.py looks for the same reason, and leaves them out of
// the warnings it prints for a pull request's changed lines.

const REASON = "Only changes class names.";

const CLASS_HELPERS = new Set(["cn", "cva"]);

const shouldIgnore = (path) => {
	const { node } = path;
	if (
		node.type === "JSXAttribute" &&
		node.name.type === "JSXIdentifier" &&
		node.name.name === "className"
	) {
		return REASON;
	}
	if (
		node.type === "CallExpression" &&
		node.callee.type === "Identifier" &&
		CLASS_HELPERS.has(node.callee.name)
	) {
		return REASON;
	}
	return undefined;
};

// What declareValuePlugin(PluginKind.Ignore, ...) from @stryker-mutator/api
// returns. The app doesn't list that package, so pnpm doesn't let it import it.
export const strykerPlugins = [{ kind: "Ignore", name: "class-names", value: { shouldIgnore } }];
