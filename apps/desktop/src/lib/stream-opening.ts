// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// Decides when the player shows its "Opening stream" spinner: from the moment
// a load starts until the stream is actually playing. Some servers take a
// minute or more to answer, and without it the player is just a black screen.
// A pause doesn't hide it. mpv goes on opening the stream while paused and
// shows its first frame when that's ready, which ends the spinner.

export interface StreamOpeningInput {
	/** `mpvLoad` is still in flight. */
	loadPending: boolean;
	currentUrl: string | null;
	/** From the mpv plugin: the current load has opened and started playing. */
	playbackStarted: boolean;
	/** The renderer has drawn the first frame of the current load. */
	firstFrameReady: boolean;
	/** `mpvLoad` rejected. The player shows the error instead. */
	error: string | null;
	/** The stream failed to open, or the reconnect monitor gave up. */
	failed: boolean;
	/** The reconnect monitor is reloading the stream and shows its own banner. */
	reconnecting: boolean;
}

export const isOpeningStream = ({
	loadPending,
	currentUrl,
	playbackStarted,
	firstFrameReady,
	error,
	failed,
	reconnecting,
}: StreamOpeningInput): boolean => {
	// Failures and reconnects have their own UI, which outranks this one.
	if (error || failed || reconnecting) return false;
	// Polled state can still describe the previous stream until the load returns.
	if (loadPending) return true;
	if (!currentUrl) return false;
	return !playbackStarted && !firstFrameReady;
};
