// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
	CLOSE_DISTANCE,
	EXPAND_DISTANCE,
	FLICK_VELOCITY,
	releaseVelocity,
	sheetReleaseAction,
	useSheetDrag,
} from "./useSheetDrag";

const release = (offset: number, velocity = 0, height = 700, expanded = false) =>
	sheetReleaseAction({ offset, velocity, height, expanded });

describe("sheetReleaseAction", () => {
	it("springs back from a short slow drag down", () => {
		expect(release(CLOSE_DISTANCE - 1)).toBe("settle");
	});

	it("closes after a long slow drag down", () => {
		expect(release(CLOSE_DISTANCE)).toBe("close");
	});

	it("closes a short sheet after a quarter of its height", () => {
		expect(release(79, 0, 320)).toBe("settle");
		expect(release(80, 0, 320)).toBe("close");
	});

	it("falls back to the fixed distance when the height is unknown", () => {
		expect(release(CLOSE_DISTANCE - 1, 0, 0)).toBe("settle");
		expect(release(CLOSE_DISTANCE, 0, 0)).toBe("close");
	});

	it("closes on a quick flick down however short", () => {
		expect(release(10, FLICK_VELOCITY)).toBe("close");
	});

	it("springs back when the drag down ends with a flick up", () => {
		expect(release(CLOSE_DISTANCE * 2, -FLICK_VELOCITY)).toBe("settle");
	});

	it("expands after a drag up or a flick up", () => {
		expect(release(-EXPAND_DISTANCE)).toBe("expand");
		expect(release(-10, -FLICK_VELOCITY)).toBe("expand");
		expect(release(-(EXPAND_DISTANCE - 1))).toBe("settle");
	});

	it("springs back when the drag up ends with a flick down", () => {
		expect(release(-EXPAND_DISTANCE * 2, FLICK_VELOCITY)).toBe("settle");
	});

	it("has nowhere to expand to once expanded", () => {
		expect(release(-EXPAND_DISTANCE * 2, -FLICK_VELOCITY, 700, true)).toBe("settle");
	});

	it("still closes when expanded", () => {
		expect(release(CLOSE_DISTANCE, 0, 700, true)).toBe("close");
	});

	it("does nothing without movement", () => {
		expect(release(0)).toBe("settle");
	});
});

describe("releaseVelocity", () => {
	it("measures the speed over the recent moves", () => {
		const samples = [
			{ y: 0, t: 1000 },
			{ y: 20, t: 1020 },
			{ y: 50, t: 1040 },
		];
		expect(releaseVelocity(samples, 1050)).toBeCloseTo(50 / 40);
	});

	it("is negative when moving up", () => {
		const samples = [
			{ y: 100, t: 0 },
			{ y: 60, t: 40 },
		];
		expect(releaseVelocity(samples, 40)).toBeCloseTo(-1);
	});

	it("ignores moves from before the finger stopped", () => {
		const samples = [
			{ y: 0, t: 0 },
			{ y: 200, t: 50 },
		];
		expect(releaseVelocity(samples, 500)).toBe(0);
	});

	it("is 0 with fewer than two moves", () => {
		expect(releaseVelocity([], 0)).toBe(0);
		expect(releaseVelocity([{ y: 10, t: 0 }], 0)).toBe(0);
	});
});

const Sheet = ({ onClose }: { onClose: () => void }) => {
	const { sheetRef, handleProps } = useSheetDrag({ onClose });
	return (
		<div ref={sheetRef} data-testid="sheet">
			<div {...handleProps}>
				<button onClick={onClose}>Header</button>
				<div role="dialog">Confirm</div>
			</div>
			<div data-testid="list" style={{ overflowY: "auto" }}>
				Programmes
			</div>
		</div>
	);
};

// jsdom has no Touch, so build the event by hand with only what the hook reads.
const touch = (target: Element, type: string, y?: number, x = 0) => {
	const e = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(e, "touches", {
		value: y === undefined ? [] : [{ clientX: x, clientY: y }],
	});
	target.dispatchEvent(e);
	return e;
};

// jsdom has no PointerEvent either, so a mouse event stands in for one.
const pointer = (target: Element, type: string, y: number, buttons = 1) => {
	const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: y, buttons });
	Object.defineProperty(e, "pointerId", { value: 1 });
	Object.defineProperty(e, "pointerType", { value: "mouse" });
	target.dispatchEvent(e);
};

// Presses the mouse on `target` at the first y and moves through the rest.
const mouseDrag = (target: Element, ys: number[]) => {
	let t = 1000;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => t);
	act(() => {
		pointer(target, "pointerdown", ys[0]);
		for (const y of ys.slice(1)) {
			t += 16;
			pointer(target, "pointermove", y);
		}
		pointer(target, "pointerup", ys[ys.length - 1], 0);
	});
	clock.mockRestore();
};

// Touches `target` at the first y and moves through the rest, one every 16 ms.
const drag = (target: Element, ys: number[]) => {
	let t = 1000;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => t);
	let end: Event | undefined;
	act(() => {
		touch(target, "touchstart", ys[0]);
		for (const y of ys.slice(1)) {
			t += 16;
			touch(target, "touchmove", y);
		}
		end = touch(target, "touchend");
	});
	clock.mockRestore();
	return end!;
};

// Makes the list scrollable, scrolled `scrollTop` px down.
const scrollable = (list: HTMLElement, scrollTop: number) => {
	Object.defineProperty(list, "scrollHeight", { value: 500 });
	Object.defineProperty(list, "clientHeight", { value: 100 });
	Object.defineProperty(list, "scrollTop", { value: scrollTop });
};

describe("useSheetDrag", () => {
	afterEach(() => cleanup());
	beforeAll(() => {
		HTMLElement.prototype.setPointerCapture = () => {};
	});

	it("closes after a drag down and drops the tap", () => {
		const onClose = vi.fn();
		const { getByTestId, getByText } = render(<Sheet onClose={onClose} />);
		const end = drag(getByText("Header"), [0, 40, 80, 130]);
		expect(onClose).toHaveBeenCalledOnce();
		expect(end.defaultPrevented).toBe(true);
		expect(getByTestId("sheet").style.transform).toBe("translateY(100%)");
	});

	it("springs back after a short drag that stops", () => {
		const onClose = vi.fn();
		const { getByTestId, getByText } = render(<Sheet onClose={onClose} />);
		drag(getByText("Header"), [0, 10, 20, 30, 30, 30, 30, 30, 30, 30, 30, 30]);
		expect(onClose).not.toHaveBeenCalled();
		expect(getByTestId("sheet").style.transform).toBe("");
	});

	it("leaves a tap alone", () => {
		const onClose = vi.fn();
		const { getByText } = render(<Sheet onClose={onClose} />);
		const end = drag(getByText("Header"), [0, 2]);
		expect(onClose).not.toHaveBeenCalled();
		expect(end.defaultPrevented).toBe(false);
	});

	it("lets scrolled content scroll instead of moving the sheet", () => {
		const onClose = vi.fn();
		const { getByTestId } = render(<Sheet onClose={onClose} />);
		const list = getByTestId("list");
		scrollable(list, 50);
		touch(list, "touchstart", 0);
		const move = touch(list, "touchmove", 200);
		touch(list, "touchend");
		expect(move.defaultPrevented).toBe(false);
		expect(onClose).not.toHaveBeenCalled();
		expect(getByTestId("sheet").style.transform).toBe("");
	});

	it("pulls the sheet down from content scrolled to the top", () => {
		const onClose = vi.fn();
		const { getByTestId } = render(<Sheet onClose={onClose} />);
		const list = getByTestId("list");
		scrollable(list, 0);
		drag(list, [0, 60, 130]);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("expands to full height after a drag up", () => {
		const { getByTestId, getByText } = render(<Sheet onClose={() => {}} />);
		const sheet = getByTestId("sheet");
		scrollable(getByTestId("list"), 0);
		expect(sheet.style.maxHeight).toBe("85vh");
		drag(getByText("Header"), [200, 150, 100, 50]);
		expect(sheet.style.maxHeight).toContain("100vh");
	});

	it("doesn't grow when everything already fits", () => {
		const { getByTestId, getByText } = render(<Sheet onClose={() => {}} />);
		const sheet = getByTestId("sheet");
		const end = drag(getByText("Header"), [200, 150, 100, 50]);
		expect(sheet.style.maxHeight).toBe("85vh");
		expect(end.defaultPrevented).toBe(true);
	});

	it("keeps following a touch whose element a re-render removed", () => {
		const onClose = vi.fn();
		const { getByText } = render(<Sheet onClose={onClose} />);
		const header = getByText("Header");
		act(() => {
			touch(header, "touchstart", 0);
			touch(header, "touchmove", 40);
			header.remove();
			touch(header, "touchmove", 90);
			touch(header, "touchmove", 140);
			touch(header, "touchend");
		});
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("leaves the list free to scroll until the touch clearly pulls down", () => {
		const onClose = vi.fn();
		const { getByTestId } = render(<Sheet onClose={onClose} />);
		const list = getByTestId("list");
		scrollable(list, 0);
		touch(list, "touchstart", 100);
		const still = touch(list, "touchmove", 100);
		const wobble = touch(list, "touchmove", 103);
		const up = touch(list, "touchmove", 40);
		touch(list, "touchend");
		expect(still.defaultPrevented).toBe(false);
		expect(wobble.defaultPrevented).toBe(false);
		expect(up.defaultPrevented).toBe(false);
		expect(onClose).not.toHaveBeenCalled();
		expect(getByTestId("sheet").style.transform).toBe("");
	});

	it("claims a pull down from the top of the list once it passes the slop", () => {
		const { getByTestId } = render(<Sheet onClose={() => {}} />);
		const list = getByTestId("list");
		scrollable(list, 0);
		touch(list, "touchstart", 100);
		const small = touch(list, "touchmove", 103);
		const pull = touch(list, "touchmove", 130);
		touch(list, "touchcancel");
		expect(small.defaultPrevented).toBe(false);
		expect(pull.defaultPrevented).toBe(true);
	});

	it("closes after a mouse drag and drops the click that follows", () => {
		const onClose = vi.fn();
		const { getByText } = render(<Sheet onClose={onClose} />);
		const header = getByText("Header");
		mouseDrag(header, [0, 40, 80, 130]);
		expect(onClose).toHaveBeenCalledOnce();
		act(() => {
			header.click();
		});
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("doesn't drag from a dialog opened in the header", () => {
		const onClose = vi.fn();
		const { getByTestId, getByText } = render(<Sheet onClose={onClose} />);
		mouseDrag(getByText("Confirm"), [0, 40, 80, 130]);
		act(() => {
			touch(getByText("Confirm"), "touchstart", 0);
			touch(getByText("Confirm"), "touchmove", 60);
			touch(getByText("Confirm"), "touchend");
		});
		expect(onClose).not.toHaveBeenCalled();
		expect(getByTestId("sheet").style.transform).toBe("");
	});
});
