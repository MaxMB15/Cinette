// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useInsertionEffect, useRef } from "react";

/**
 * A ref holding the newest `value`, for timers, listeners and callbacks that
 * outlive the render they came from. It's the same object on every render, so
 * it never makes an effect run again.
 *
 * The value is copied in once React commits the render, so read it in effects
 * and event handlers rather than while rendering. An insertion effect runs
 * before every layout effect, so a child's layout effect that calls back into
 * its parent already sees the parent's new value.
 */
export const useLatestRef = <T>(value: T): { readonly current: T } => {
	const ref = useRef(value);
	useInsertionEffect(() => {
		ref.current = value;
	});
	return ref;
};
