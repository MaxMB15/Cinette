// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/** The part of Node's `process` this needs. The app's TypeScript config has no Node types. */
declare const process: {
	on: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
	off: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
};

/**
 * Runs `action` and gives the rejections nothing handled while it ran. Node
 * reports them after the microtasks, so this waits for a timer before it stops
 * listening.
 *
 * A `vi.fn` handles every rejection of a promise it returns, so the rejected
 * promise has to come from a plain function or be derived from the `vi.fn`'s.
 */
export const unhandledRejectionsDuring = async (
	action: () => Promise<unknown>
): Promise<unknown[]> => {
	const failed: unknown[] = [];
	const onFailed = (reason: unknown) => failed.push(reason);
	process.on("unhandledRejection", onFailed);
	try {
		await action();
		await new Promise((resolve) => setTimeout(resolve));
	} finally {
		process.off("unhandledRejection", onFailed);
	}
	return failed;
};
