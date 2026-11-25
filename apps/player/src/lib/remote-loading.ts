// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * How much of the other device's library came, in packed bytes, and of how
 * much. A library that comes in one piece says nothing until it's there, and
 * an older device never gives the total.
 */
export interface LibraryProgress {
	received: number;
	total: number | null;
}

/** The steps to the other device's library, in order. */
export const LOAD_STEPS = ["link", "get", "open"] as const;

export type LoadStep = (typeof LOAD_STEPS)[number];

/**
 * The step the load is at: the link while it reconnects, getting the library
 * until all of it came, then opening it, which takes this device a moment for
 * a big one.
 */
export const loadStep = (connected: boolean, progress: LibraryProgress | null): LoadStep => {
	if (!connected) return "link";
	const all = progress?.total != null && progress.received >= progress.total;
	return all ? "open" : "get";
};

/** Whether `step` is done, the one the load is at, or still to come. */
export const stepState = (step: LoadStep, at: LoadStep): "done" | "active" | "waiting" => {
	const ahead = LOAD_STEPS.indexOf(step) - LOAD_STEPS.indexOf(at);
	return ahead < 0 ? "done" : ahead === 0 ? "active" : "waiting";
};

const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(1);

/** How much came, like "3.1 of 8.0 MB". It never says more than the total. */
export const loadedText = (received: number, total: number): string =>
	`${megabytes(Math.min(received, total))} of ${megabytes(total)} MB`;
