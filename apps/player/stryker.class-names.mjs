// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// A Stryker plugin that leaves out the mutants that only change class names.
// Those are everything in a className attribute, or in one whose name ends in
// ClassName such as labelClassName, and in the arguments of cn() and cva(). It
// also leaves out the arguments of a variant function, which is a const in the
// same file set to what cva() returns, like buttonVariants. The tests run in
// jsdom, which doesn't load Tailwind's CSS, so a test could only compare class
// strings. stryker.config.mjs turns it on.
//
// Stryker counts these mutants as ignored, for the reason below.
// scripts/stryker-summary.py looks for the same reason, and leaves them out of
// the warnings it prints for a pull request's changed lines.

const REASON = "Only changes class names.";

const CLASS_HELPERS = new Set(["cn", "cva"]);

// className, or a prop that passes class names on to a child, like
// labelClassName.
const CLASS_PROP = /^(?:className|[a-z][A-Za-z0-9]*ClassName)$/;

/** Whether `name` is a const in this file whose value is a call to cva(). */
const isVariantFunction = (path, name) => {
	const binding = path.scope.getBinding(name);
	if (binding?.kind !== "const") {
		return false;
	}
	const { init } = binding.path.node;
	return (
		init?.type === "CallExpression" &&
		init.callee.type === "Identifier" &&
		init.callee.name === "cva"
	);
};

const shouldIgnore = (path) => {
	const { node } = path;
	if (
		node.type === "JSXAttribute" &&
		node.name.type === "JSXIdentifier" &&
		CLASS_PROP.test(node.name.name)
	) {
		return REASON;
	}
	if (
		node.type === "CallExpression" &&
		node.callee.type === "Identifier" &&
		(CLASS_HELPERS.has(node.callee.name) || isVariantFunction(path, node.callee.name))
	) {
		return REASON;
	}
	return undefined;
};

// What declareValuePlugin(PluginKind.Ignore, ...) from @stryker-mutator/api
// returns. The app doesn't list that package, so pnpm doesn't let it import it.
export const strykerPlugins = [{ kind: "Ignore", name: "class-names", value: { shouldIgnore } }];
