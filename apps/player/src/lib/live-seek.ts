// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { formatTime } from "./format";

/**
 * The furthest a live stream has played: its position in seconds, and when
 * mpv reported it, in `performance.now()` milliseconds.
 */
export interface LiveAnchor {
	position: number;
	at: number;
}

/** How many seconds behind the live edge still count as live. */
export const LIVE_SLACK = 3;

/**
 * Where the live edge is at `at`. The broadcast goes on at its own pace
 * while the player pauses, seeks back or waits for the stream.
 */
export const liveEdge = (anchor: LiveAnchor, at: number): number =>
	anchor.position + (at - anchor.at) / 1000;

/**
 * Moves the anchor up to a position that has caught up with the live edge, as
 * one does while it plays live, and keeps it otherwise.
 */
export const nextAnchor = (anchor: LiveAnchor | null, sample: LiveAnchor): LiveAnchor =>
	anchor && sample.position <= liveEdge(anchor, sample.at) ? anchor : sample;

/** How many seconds behind the live edge `position` is at `at`. */
export const liveBehind = (anchor: LiveAnchor | null, position: number, at: number): number =>
	anchor ? Math.max(0, liveEdge(anchor, at) - position) : 0;

/** How far behind live, as "−0:40". */
export const formatBehind = (seconds: number): string => `−${formatTime(seconds)}`;
