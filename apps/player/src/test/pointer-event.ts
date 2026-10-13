// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterAll, beforeAll } from "vitest";

/**
 * jsdom's PointerEvent starts from the spec's defaults, pointer 0 with no
 * type. This mouse event carries the pointer fields as well. Unless the test
 * says otherwise, it comes from the first mouse.
 */
export class TestPointerEvent extends MouseEvent {
	readonly pointerId: number;
	readonly pointerType: string;
	readonly isPrimary: boolean;
	constructor(type: string, init: PointerEventInit = {}) {
		super(type, init);
		this.pointerId = init.pointerId ?? 1;
		this.pointerType = init.pointerType ?? "mouse";
		this.isPrimary = init.isPrimary ?? true;
	}
}

/**
 * Makes `TestPointerEvent` the window's PointerEvent for the tests in the
 * file or describe block that calls it, then puts the old one back.
 */
export const installPointerEvent = () => {
	let saved: typeof PointerEvent;
	beforeAll(() => {
		saved = window.PointerEvent;
		window.PointerEvent = TestPointerEvent as typeof PointerEvent;
	});
	afterAll(() => {
		window.PointerEvent = saved;
	});
};
