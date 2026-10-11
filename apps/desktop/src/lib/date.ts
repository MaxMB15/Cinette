// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/** The current Unix time in whole seconds, the unit EPG times use. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const parseDateMs = (value: string | null | undefined): number => {
	if (!value) return 0;
	const ms = Date.parse(value);
	return isNaN(ms) ? 0 : ms;
};
