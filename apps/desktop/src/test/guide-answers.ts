// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { EpgProgram } from "@/lib/types";

/**
 * A stand-in for `getEpgForLiveChannels` that answers the way the backend does,
 * with every program when no guide ids are given and otherwise only those of
 * the asked-for channels.
 */
export const answerFrom =
	(programs: EpgProgram[]) => (_from: number, _to: number, ids?: readonly string[]) =>
		Promise.resolve(programs.filter((p) => !ids || ids.includes(p.channelId)));
