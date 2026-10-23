// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useSyncExternalStore } from "react";
import type { PlaybackDestination, PlaybackState } from "@/lib/destination";

// Stryker disable next-line ArrowFunction: React skips an unsubscribe that isn't a function, and this one does nothing.
const noState = () => () => {};
// Stryker disable next-line ArrowFunction: Callers only read the state while there's a destination, which has its own snapshot.
const getNull = () => null;

/** `destination`'s state, kept up to date, or `null` without one. A
 *  destination that's there always has a state. */
export const useDestinationState = ((destination: PlaybackDestination | null) =>
	// The React Compiler can't compile `?.` with `??` in these arguments.
	useSyncExternalStore(
		destination ? destination.subscribe : noState,
		destination ? destination.getState : getNull
	)) as {
	(destination: PlaybackDestination): PlaybackState;
	(destination: PlaybackDestination | null): PlaybackState | null;
};
