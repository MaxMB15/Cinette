// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
} from "react";

/** Height cap of a sheet when it opens, and after a drag up expands it. */
const SHEET_HEIGHT = "85vh";
const SHEET_FULL_HEIGHT = "calc(100vh - env(safe-area-inset-top) - 0.5rem)";

/** Movement in px before a touch counts as a drag rather than a tap. */
const DRAG_SLOP = 6;
/** Only moves in the last this many ms count towards the release speed. */
const VELOCITY_WINDOW_MS = 100;

/** Release speed in px/ms that counts as a flick. */
export const FLICK_VELOCITY = 0.5;
/** A slow drag down closes the sheet past this many px, or a quarter of its height if less. */
export const CLOSE_DISTANCE = 120;
/** A slow drag up expands the sheet past this many px. */
export const EXPAND_DISTANCE = 60;

export type SheetRelease = "close" | "expand" | "settle";

export interface DragSample {
	y: number;
	t: number;
}

/**
 * Speed in px/ms (positive is down) over the moves in the last
 * VELOCITY_WINDOW_MS before `now`. 0 when the finger had stopped.
 */
export const releaseVelocity = (samples: DragSample[], now: number): number => {
	const recent = samples.filter((s) => now - s.t <= VELOCITY_WINDOW_MS);
	if (recent.length < 2) return 0;
	const first = recent[0];
	const last = recent[recent.length - 1];
	const dt = last.t - first.t;
	return dt > 0 ? (last.y - first.y) / dt : 0;
};

/**
 * What a sheet does when the finger lifts. `offset` is how far it was dragged
 * in px and `velocity` the release speed in px/ms, both positive downwards.
 * `height` is the sheet's height in px.
 */
export const sheetReleaseAction = ({
	offset,
	velocity,
	height,
	expanded,
}: {
	offset: number;
	velocity: number;
	height: number;
	expanded: boolean;
}): SheetRelease => {
	if (offset > 0) {
		if (velocity <= -FLICK_VELOCITY) return "settle";
		if (velocity >= FLICK_VELOCITY) return "close";
		const closeAt = height > 0 ? Math.min(CLOSE_DISTANCE, height / 4) : CLOSE_DISTANCE;
		return offset >= closeAt ? "close" : "settle";
	}
	if (offset < 0 && !expanded) {
		if (velocity >= FLICK_VELOCITY) return "settle";
		if (velocity <= -FLICK_VELOCITY) return "expand";
		return -offset >= EXPAND_DISTANCE ? "expand" : "settle";
	}
	return "settle";
};

interface Gesture {
	startX: number;
	startY: number;
	// "pending" until the move is big enough to tell a drag from a tap or a scroll.
	mode: "pending" | "drag" | "ignore";
	// The scrollable element the touch started in, if any.
	scroller: Element | null;
	// Whether a drag up can grow the sheet, decided when the drag starts.
	canExpand: boolean;
	height: number;
	offset: number;
	samples: DragSample[];
	// Set for a mouse, which goes through pointer events. Touch uses touch events.
	pointerId: number | null;
}

const scrollsY = (el: Element): boolean => {
	if (el.scrollHeight <= el.clientHeight) return false;
	const { overflowY } = getComputedStyle(el);
	return overflowY === "auto" || overflowY === "scroll";
};

const findScroller = (target: EventTarget | null, sheet: Element): Element | null => {
	let el = target instanceof Element ? target : null;
	while (el && el !== sheet) {
		if (scrollsY(el)) return el;
		el = el.parentElement;
	}
	return null;
};

// True when the sheet cuts off some of its content, either by clipping it or
// in a scrolling list, so growing it shows more.
const hidesContent = (sheet: Element): boolean =>
	sheet.scrollHeight > sheet.clientHeight ||
	Array.from(sheet.querySelectorAll("*")).some(scrollsY);

// A dialog opened from inside the sheet, such as a download's confirm, isn't
// part of it for dragging.
const inDialog = (target: EventTarget | null, container: Element): boolean => {
	const dialog = target instanceof Element ? target.closest('[role="dialog"]') : null;
	return dialog !== null && container.contains(dialog);
};

// After a mouse drag the browser still clicks whatever the drag started on,
// such as the close button. This drops that click.
const dropNextClick = () => {
	const drop = (e: MouseEvent) => {
		e.stopPropagation();
		e.preventDefault();
	};
	window.addEventListener("click", drop, { capture: true, once: true });
	// The click comes in the same task as the pointerup, if at all.
	setTimeout(() => window.removeEventListener("click", drop, { capture: true }), 0);
};

// Down slides the sheet, up grows it towards full height. Written straight to
// the element so a drag doesn't re-render the pane on every move.
const paint = (sheet: HTMLElement, offset: number, expanded: boolean) => {
	const pull = expanded ? 0 : Math.max(0, -offset);
	sheet.style.transform = offset > 0 ? `translateY(${offset}px)` : "";
	sheet.style.maxHeight = expanded
		? SHEET_FULL_HEIGHT
		: pull > 0
			? `min(calc(${SHEET_HEIGHT} + ${pull}px), ${SHEET_FULL_HEIGHT})`
			: SHEET_HEIGHT;
};

/**
 * Lets a bottom sheet be dragged like an iOS sheet. A drag down follows the
 * finger and closes the sheet when released far enough or with a flick, and
 * a drag up expands it to full height. In scrollable content only a pull down
 * from the top moves the sheet; anything else scrolls.
 *
 * Put `sheetRef` on the sheet, which gets its max height from here, and
 * spread `handleProps` on the handle and header so a mouse can drag them too.
 * The sheet's CSS transition animates the release. Give scrolling content in
 * the sheet `overscroll-y-none`, so a pull down from its top can't also
 * bounce the content.
 */
export const useSheetDrag = ({
	onClose,
	enabled = true,
}: {
	onClose: () => void;
	enabled?: boolean;
}) => {
	const sheetRef = useRef<HTMLDivElement>(null);
	const gestureRef = useRef<Gesture | null>(null);
	const [expanded, setExpanded] = useState(false);
	const latest = useRef({ onClose, enabled, expanded });
	useEffect(() => {
		latest.current = { onClose, enabled, expanded };
	});

	useLayoutEffect(() => {
		if (sheetRef.current) paint(sheetRef.current, 0, expanded);
	}, [expanded]);

	const begin = useCallback(
		(x: number, y: number, scroller: Element | null, pointerId: number | null) => {
			const sheet = sheetRef.current;
			if (!sheet || !latest.current.enabled) return;
			gestureRef.current = {
				startX: x,
				startY: y,
				mode: "pending",
				scroller,
				canExpand: false,
				height: sheet.offsetHeight,
				offset: 0,
				samples: [],
				pointerId,
			};
		},
		[]
	);

	// True while the move belongs to the sheet, so the page shouldn't scroll.
	const move = useCallback((x: number, y: number): boolean => {
		const g = gestureRef.current;
		const sheet = sheetRef.current;
		if (!g || !sheet || g.mode === "ignore") return false;
		const dx = x - g.startX;
		const dy = y - g.startY;
		if (g.mode === "pending") {
			if (Math.abs(dx) > Math.abs(dy)) {
				if (Math.abs(dx) >= DRAG_SLOP) g.mode = "ignore";
				return false;
			}
			if (g.scroller) {
				if (dy < 0 || g.scroller.scrollTop > 0) {
					g.mode = "ignore";
					return false;
				}
				// Not clearly a pull down yet. WebKit lets the first touchmove decide
				// whether the content can scroll for the rest of the touch, so
				// claiming a small wobble down would stop a scroll that follows it.
				if (dy < DRAG_SLOP) return false;
			}
			if (Math.abs(dy) < DRAG_SLOP) return true;
			g.mode = "drag";
			g.canExpand = !g.scroller && !latest.current.expanded && hidesContent(sheet);
			sheet.style.transition = "none";
		}
		const { expanded } = latest.current;
		g.offset = g.canExpand ? dy : Math.max(0, dy);
		const now = performance.now();
		g.samples.push({ y, t: now });
		while (g.samples.length > 2 && now - g.samples[0].t > VELOCITY_WINDOW_MS) {
			g.samples.shift();
		}
		paint(sheet, g.offset, expanded);
		return true;
	}, []);

	// True when the gesture was a drag, so the tap under the finger should be dropped.
	const end = useCallback((cancelled: boolean): boolean => {
		const g = gestureRef.current;
		const sheet = sheetRef.current;
		gestureRef.current = null;
		if (!g || !sheet || g.mode !== "drag") return false;
		const { expanded, onClose } = latest.current;
		const action = cancelled
			? "settle"
			: sheetReleaseAction({
					offset: g.offset,
					velocity: releaseVelocity(g.samples, performance.now()),
					height: g.height,
					expanded,
				});
		sheet.style.transition = "";
		if (action === "close") {
			sheet.style.transform = "translateY(100%)";
			onClose();
		} else {
			paint(sheet, 0, expanded || action === "expand");
			if (action === "expand") setExpanded(true);
		}
		return true;
	}, []);

	// Touch listeners go on the element because React's touchmove is passive,
	// and only a non-passive listener can stop the content scrolling.
	useEffect(() => {
		const sheet = sheetRef.current;
		if (!sheet) return;
		// A touch's events keep going to the element it started on, even after
		// a re-render removes that element, and then they no longer reach the
		// sheet. So the touched element gets the listeners too, and an event
		// that reaches both is handled once.
		const handled = new WeakSet<Event>();
		const firstTime = (e: Event) => {
			if (handled.has(e)) return false;
			handled.add(e);
			return true;
		};
		let touched: EventTarget | null = null;

		const onTouchMove = (e: TouchEvent) => {
			if (!firstTime(e)) return;
			const t = e.touches[0];
			if (t && move(t.clientX, t.clientY) && e.cancelable) e.preventDefault();
		};
		const onTouchEnd = (e: TouchEvent) => {
			if (!firstTime(e)) return;
			release();
			if (end(false) && e.cancelable) e.preventDefault();
		};
		const onTouchCancel = (e: TouchEvent) => {
			if (!firstTime(e)) return;
			release();
			end(true);
		};
		const listen = (target: EventTarget) => {
			target.addEventListener("touchmove", onTouchMove as EventListener, { passive: false });
			target.addEventListener("touchend", onTouchEnd as EventListener, { passive: false });
			target.addEventListener("touchcancel", onTouchCancel as EventListener);
		};
		const unlisten = (target: EventTarget) => {
			target.removeEventListener("touchmove", onTouchMove as EventListener);
			target.removeEventListener("touchend", onTouchEnd as EventListener);
			target.removeEventListener("touchcancel", onTouchCancel as EventListener);
		};
		const release = () => {
			if (touched && touched !== sheet) unlisten(touched);
			touched = null;
		};

		const onTouchStart = (e: TouchEvent) => {
			release();
			if (e.touches.length !== 1) {
				end(true);
				return;
			}
			if (inDialog(e.target, sheet)) return;
			const t = e.touches[0];
			begin(t.clientX, t.clientY, findScroller(e.target, sheet), null);
			if (gestureRef.current && e.target && e.target !== sheet) {
				touched = e.target;
				listen(touched);
			}
		};
		sheet.addEventListener("touchstart", onTouchStart, { passive: true });
		listen(sheet);
		return () => {
			release();
			sheet.removeEventListener("touchstart", onTouchStart);
			unlisten(sheet);
		};
	}, [begin, move, end]);

	const ownsPointer = (e: ReactPointerEvent) => gestureRef.current?.pointerId === e.pointerId;

	const handleProps = {
		onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
			if (e.pointerType !== "mouse" || e.button !== 0) return;
			if (inDialog(e.target, e.currentTarget)) return;
			begin(e.clientX, e.clientY, null, e.pointerId);
		},
		onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
			const g = gestureRef.current;
			if (!g || !ownsPointer(e)) return;
			// The button came up somewhere we didn't hear about.
			if ((e.buttons & 1) === 0) {
				end(true);
				return;
			}
			const wasPending = g.mode === "pending";
			move(e.clientX, e.clientY);
			if (wasPending && g.mode === "drag") e.currentTarget.setPointerCapture(e.pointerId);
		},
		onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
			if (ownsPointer(e) && end(false)) dropNextClick();
		},
		onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => {
			if (ownsPointer(e)) end(true);
		},
	};

	return { sheetRef, handleProps };
};
