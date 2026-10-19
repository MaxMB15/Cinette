// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// Counts how many times each component renders, for measuring only.
//
// This reads React's internal fiber tree, which React doesn't promise to keep
// the same, the way React DevTools does. A `<Profiler>` around the app calls
// `onRender` after every commit. The counter then walks the fibers that
// commit worked on, and counts each component whose function ran. A subtree
// React skipped keeps its old fibers, so the walk stops there.

import type { ProfilerOnRenderCallback } from "react";
import { createTally, type Tally } from "./tally";

/** The parts of a React fiber the counter reads. */
export interface Fiber {
	tag: number;
	type: unknown;
	flags: number;
	child: Fiber | null;
	sibling: Fiber | null;
	alternate: Fiber | null;
}

// React's fiber tags for the components that run code of their own. A memo()
// wrapper (tag 14) is left out, since the component inside it has a fiber of
// its own.
const FUNCTION_COMPONENT = 0;
const CLASS_COMPONENT = 1;
const FORWARD_REF = 11;
const SIMPLE_MEMO_COMPONENT = 15;
const COMPONENT_TAGS = new Set([
	FUNCTION_COMPONENT,
	CLASS_COMPONENT,
	FORWARD_REF,
	SIMPLE_MEMO_COMPONENT,
]);

/** React sets this flag on a fiber whose component ran in the current render. */
const PERFORMED_WORK = 1;

type Named = { displayName?: string; name?: string; render?: Named };

/** The component's name, as React DevTools shows it, or "" when it has none. */
export const componentName = (fiber: Fiber): string => {
	const type = fiber.type as Named | null;
	const name =
		type?.displayName ||
		(fiber.tag === FORWARD_REF ? type?.render?.displayName || type?.render?.name : type?.name);
	return name || "";
};

/**
 * Adds each component the last commit rendered under `fiber`, `fiber`
 * included. A component with no name counts as "Anonymous in <Owner>", after
 * the nearest named component above it, which `owner` passes down.
 */
export const countRendered = (fiber: Fiber, tally: Tally, owner = "Root"): void => {
	const isComponent = COMPONENT_TAGS.has(fiber.tag);
	const name = isComponent ? componentName(fiber) : "";
	if (isComponent && (fiber.flags & PERFORMED_WORK) !== 0) {
		tally.add(name || `Anonymous in ${owner}`);
	}
	// When React skips a subtree, the fiber keeps the children it had before,
	// which hold the flags of an older render.
	if (fiber.alternate !== null && fiber.alternate.child === fiber.child) return;
	for (let child = fiber.child; child !== null; child = child.sibling) {
		countRendered(child, tally, name || owner);
	}
};

/** The tree on screen in the React root mounted in `container`. */
export const currentTree = (container: Element): Fiber | null => {
	const key = Object.keys(container).find((k) => k.startsWith("__reactContainer$"));
	if (key === undefined) return null;
	const hostRoot = (container as unknown as Record<string, { stateNode: { current: Fiber } }>)[
		key
	];
	return hostRoot.stateNode.current;
};

export interface RenderCounter {
	/** Pass to a `<Profiler>` that wraps everything rendered into `container`. */
	onRender: ProfilerOnRenderCallback;
	/** Renders per component since the last reset, most first. */
	counts: () => [string, number][];
	/** How many commits the counts cover. */
	commits: () => number;
	reset: () => void;
}

/** Counts the renders of the React root mounted in `container`. */
export const createRenderCounter = (container: Element): RenderCounter => {
	const tally = createTally();
	let commits = 0;
	return {
		onRender: () => {
			const tree = currentTree(container);
			if (tree === null) return;
			commits += 1;
			countRendered(tree, tally);
		},
		counts: tally.entries,
		commits: () => commits,
		reset: () => {
			tally.reset();
			commits = 0;
		},
	};
};
