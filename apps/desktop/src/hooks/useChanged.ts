// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState } from "react";

/**
 * Whether `value` differs from the one the last render saw. The first render
 * doesn't count as a change. Values are compared with `Object.is`.
 *
 * On the render that returns true, the caller can reset state that belonged
 * to the old value. React then renders again straight away, before anything
 * reaches the screen, where a reset in an effect would show the old state for
 * a frame and cost another commit.
 */
export const useChanged = (value: unknown): boolean => {
	const [last, setLast] = useState(value);
	if (Object.is(last, value)) return false;
	setLast(value);
	return true;
};
