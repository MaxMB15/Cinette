// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import {
	Component,
	Profiler,
	createContext,
	forwardRef,
	memo,
	useContext,
	useState,
	type ReactNode,
} from "react";
import { render, fireEvent, screen } from "@testing-library/react";
import { componentName, createRenderCounter, currentTree, type Fiber } from "./render-counts";

const Leaf = () => <span>leaf</span>;
const MemoLeaf = memo(() => <span>memo leaf</span>);
MemoLeaf.displayName = "MemoLeaf";
const Theme = createContext(0);
const ThemeReader = memo(() => <span>theme {useContext(Theme)}</span>);
ThemeReader.displayName = "ThemeReader";

const Counter = ({ children }: { children?: ReactNode }) => {
	const [n, setN] = useState(0);
	return (
		<Theme.Provider value={Math.floor(n / 2)}>
			<button onClick={() => setN(n + 1)}>clicked {n}</button>
			<Leaf />
			<MemoLeaf />
			<ThemeReader />
			{children}
		</Theme.Provider>
	);
};

const Outside = memo(() => <p>outside</p>);
Outside.displayName = "Outside";

/** Renders `ui` under a counting Profiler, the way the app's dev switch does. */
const renderCounted = (ui: ReactNode) => {
	const container = document.body.appendChild(document.createElement("div"));
	const counter = createRenderCounter(container);
	render(
		<Profiler id="test" onRender={counter.onRender}>
			{ui}
		</Profiler>,
		{ container }
	);
	return counter;
};

describe("createRenderCounter", () => {
	it("counts every component that mounts, once each", () => {
		const counter = renderCounted(<Counter />);
		expect(Object.fromEntries(counter.counts())).toEqual({
			Counter: 1,
			Leaf: 1,
			MemoLeaf: 1,
			ThemeReader: 1,
		});
		expect(counter.commits()).toBe(1);
	});

	it("counts only what re-renders after a state change", () => {
		const counter = renderCounted(
			<>
				<Counter />
				<Outside />
			</>
		);
		counter.reset();
		expect(counter.counts()).toEqual([]);
		expect(counter.commits()).toBe(0);

		// The context value goes from 0 to 0, so the memoized reader skips.
		fireEvent.click(screen.getByRole("button"));
		expect(Object.fromEntries(counter.counts())).toEqual({ Counter: 1, Leaf: 1 });

		// Now it goes to 1, and the reader renders for it.
		fireEvent.click(screen.getByRole("button"));
		expect(Object.fromEntries(counter.counts())).toEqual({
			Counter: 2,
			Leaf: 2,
			ThemeReader: 1,
		});
		expect(counter.commits()).toBe(2);
	});

	it("doesn't count the old renders of a subtree React skipped", () => {
		const Sibling = () => {
			const [n, setN] = useState(0);
			return <button onClick={() => setN(n + 1)}>sibling {n}</button>;
		};
		const counter = renderCounted(
			<>
				<Counter />
				<Sibling />
			</>
		);
		counter.reset();
		fireEvent.click(screen.getByRole("button", { name: /sibling/ }));
		expect(Object.fromEntries(counter.counts())).toEqual({ Sibling: 1 });
	});

	it("counts class components and forwardRef components", () => {
		class Old extends Component {
			render() {
				return <b>old</b>;
			}
		}
		const Ref = forwardRef<HTMLSpanElement>((_, ref) => <span ref={ref}>ref</span>);
		Ref.displayName = "Ref";
		const counter = renderCounted(
			<>
				<Old />
				<Ref />
			</>
		);
		expect(Object.fromEntries(counter.counts())).toEqual({ Old: 1, Ref: 1 });
	});

	it("names a nameless component after the nearest named one above it", () => {
		const nameless = [() => <span>a</span>, () => <span>b</span>];
		const [First, Second] = nameless;
		const Outer = () => (
			<div>
				<First />
			</div>
		);
		const counter = renderCounted(
			<>
				<Outer />
				<Second />
			</>
		);
		expect(Object.fromEntries(counter.counts())).toEqual({
			Outer: 1,
			"Anonymous in Outer": 1,
			"Anonymous in Root": 1,
		});
	});

	it("skips a commit when the container holds no React root", () => {
		const counter = createRenderCounter(document.createElement("div"));
		counter.onRender("x", "mount", 0, 0, 0, 0);
		expect(counter.commits()).toBe(0);
	});
});

describe("currentTree", () => {
	it("finds the tree on screen", () => {
		const { container } = render(<Leaf />);
		const tree = currentTree(container);
		expect(tree?.tag).toBe(3);
		expect(componentName(tree!.child!)).toBe("Leaf");
	});

	it("passes over other properties on the element", () => {
		const container = document.body.appendChild(document.createElement("div"));
		Object.assign(container, { earlierProperty: { stateNode: null } });
		render(<Leaf />, { container });
		expect(componentName(currentTree(container)!.child!)).toBe("Leaf");
	});

	it("is null for an element with no root", () => {
		expect(currentTree(document.createElement("div"))).toBeNull();
	});
});

describe("componentName", () => {
	const fiber = (tag: number, type: unknown): Fiber => ({
		tag,
		type,
		flags: 0,
		child: null,
		sibling: null,
		alternate: null,
	});

	it("prefers the display name", () => {
		const f = Object.assign(() => null, { displayName: "Shown" });
		expect(componentName(fiber(0, f))).toBe("Shown");
	});

	it("uses the function's name", () => {
		const Named = () => null;
		expect(componentName(fiber(0, Named))).toBe("Named");
	});

	it("reads a forwardRef's render function", () => {
		expect(componentName(fiber(11, { render: { name: "Inner" } }))).toBe("Inner");
		expect(componentName(fiber(11, { render: { displayName: "Given", name: "Inner" } }))).toBe(
			"Given"
		);
		expect(componentName(fiber(11, { displayName: "Outer", render: { name: "Inner" } }))).toBe(
			"Outer"
		);
	});

	it("doesn't read a render function outside forwardRef", () => {
		expect(componentName(fiber(0, { render: { name: "Inner" } }))).toBe("");
	});

	it("is empty for a nameless component", () => {
		expect(componentName(fiber(0, null))).toBe("");
		expect(componentName(fiber(11, {}))).toBe("");
		expect(componentName(fiber(11, null))).toBe("");
	});
});
