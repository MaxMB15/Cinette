// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

/**
 * Whether a click on a clickable row landed on a button inside it, such as a
 * pin or a heart. The row leaves those clicks to the button, so the button
 * doesn't have to stop the event before listeners further up see it.
 */
export const isFromInnerButton = (e: { target: EventTarget; currentTarget: Element }): boolean => {
	const button = e.target instanceof Element ? e.target.closest("button") : null;
	return button !== null && e.currentTarget.contains(button);
};
