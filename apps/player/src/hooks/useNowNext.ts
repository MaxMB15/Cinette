// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState } from "react";
import { useChannels } from "@/hooks/useChannels";
import { useGuidePrograms } from "@/hooks/useGuidePrograms";
import { useNow } from "@/hooks/useNow";
import { coversWindow, guideRangeFor, type TimeRange } from "@/lib/epg-window";
import type { Channel, EpgProgram } from "@/lib/types";

/** What's on a channel now and after it. */
export interface NowNext {
	now: EpgProgram | null;
	next: EpgProgram | null;
}

// Stryker disable next-line ArrayDeclaration: anything in it has no times, so it's neither on now, next nor still to come, and the lists come out the same.
const NO_PROGRAMS: readonly EpgProgram[] = [];

/** The program on at `at` and the one after, from a channel's programs in time order. */
export const nowAndNext = (programs: readonly EpgProgram[], at: number): NowNext => {
	const index = programs.findIndex((p) => p.startTime <= at && at < p.endTime);
	if (index >= 0) return { now: programs[index], next: programs[index + 1] ?? null };
	return { now: null, next: programs.find((p) => p.startTime > at) ?? null };
};

/** How far through its time a program is, from 0 to 1. */
export const programProgress = (program: EpgProgram, at: number): number =>
	Math.max(0, Math.min(1, (at - program.startTime) / (program.endTime - program.startTime)));

/**
 * Reads what's on from the guide of every live channel, loaded once and
 * cached. It loads the hours around now, and on up to `until` for a grid that
 * shows what's on later.
 */
export const useNowNext = (until?: number) => {
	const { channels, guideVersion } = useChannels();
	const now = useNow();
	const end = until ?? now;
	const [range, setRange] = useState<TimeRange | null>(null);
	if (!(range && coversWindow(range, now, end))) setRange(guideRangeFor(now, now, end));
	const { programs } = useGuidePrograms(
		range,
		channels.length > 0 ? "all" : null,
		`${channels.length}:${guideVersion}`
	);
	const programsOf = (channel: Channel): readonly EpgProgram[] =>
		(channel.tvgId && programs.get(channel.tvgId)) || NO_PROGRAMS;
	return {
		now,
		/** All of the channel's programs the guide has loaded, in time order, the ones already over too. */
		programsOf,
		nowNextOf: (channel: Channel): NowNext => nowAndNext(programsOf(channel), now),
		/** The channel's programs that haven't ended yet, in time order. */
		scheduleOf: (channel: Channel): readonly EpgProgram[] =>
			programsOf(channel).filter((p) => p.endTime > now),
	};
};
