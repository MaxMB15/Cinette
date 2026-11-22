// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { TvTextEntry } from "./TvTextEntry";

const TITLE = "Server URL";

const open = (initial = "") => {
	const onDone = vi.fn();
	const onCancel = vi.fn();
	render(<TvTextEntry title={TITLE} initial={initial} onCancel={onCancel} onDone={onDone} />);
	return { onDone, onCancel };
};

const field = () => screen.getByRole("textbox", { name: TITLE }) as HTMLInputElement;
const keyOf = (name: string) => screen.getByRole("option", { name });
const activeKey = () => screen.getByRole("option", { selected: true });
const action = (name: string) => screen.getByRole("button", { name });
const type = (...keys: string[]) => keys.forEach((k) => fireEvent.click(keyOf(k)));

afterEach(() => {
	vi.restoreAllMocks();
});

describe("TvTextEntry", () => {
	it("names the screen and the field after what's being typed", () => {
		open();

		expect(screen.getByRole("heading", { name: TITLE })).toBeInTheDocument();
		expect(screen.getByRole("dialog", { name: TITLE })).toBeInTheDocument();
		expect(field()).toBeInTheDocument();
	});

	it("starts from the text it's given", () => {
		open("http://");

		expect(field()).toHaveValue("http://");
	});

	it("puts the cursor on the first key, not in the field, so no system keyboard opens", () => {
		open();

		expect(keyOf("a")).toHaveFocus();
	});

	it("has every key a URL or a password needs, in rows of twelve", () => {
		open();

		const keys = within(screen.getByRole("listbox", { name: "Letters" }))
			.getAllByRole("option")
			.map((k) => k.textContent)
			.join("");
		expect(keys).toBe("abcdefghijklmnopqrstuvwxyz0123456789./:-_@?&=%#+!$*()~,;'\"[]");

		fireEvent.keyDown(activeKey(), { key: "ArrowDown" });
		expect(activeKey()).toHaveTextContent("m");
	});

	it("types the key under the cursor when OK is pressed", () => {
		open("x");

		fireEvent.keyDown(activeKey(), { key: "ArrowRight" });
		fireEvent.keyDown(activeKey(), { key: "Enter" });

		expect(field()).toHaveValue("xb");
	});

	it("types signs as well as letters", () => {
		open();

		type("h", ":", "/", "/");

		expect(field()).toHaveValue("h://");
	});

	it("marks Shift as off to start, and only Shift as a key that stays down", () => {
		open();

		expect(action("Shift")).toHaveAttribute("aria-pressed", "false");
		for (const name of ["Space", "Delete", "Clear", "Done"]) {
			expect(action(name)).not.toHaveAttribute("aria-pressed");
		}
	});

	it("shows and types capitals while Shift is on, for more than one letter", () => {
		open();

		fireEvent.click(action("Shift"));

		expect(action("Shift")).toHaveAttribute("aria-pressed", "true");
		expect(keyOf("A")).toBeInTheDocument();

		type("A", "B");

		expect(field()).toHaveValue("AB");
	});

	it("goes back to small letters when Shift is pressed again", () => {
		open();

		fireEvent.click(action("Shift"));
		fireEvent.click(action("Shift"));
		type("a");

		expect(action("Shift")).toHaveAttribute("aria-pressed", "false");
		expect(field()).toHaveValue("a");
	});

	it("adds a space with Space", () => {
		open("a");

		fireEvent.click(action("Space"));

		expect(field()).toHaveValue("a ");
	});

	it("takes off the last letter with Delete", () => {
		open("abc");

		fireEvent.click(action("Delete"));

		expect(field()).toHaveValue("ab");
	});

	it("empties the field with Clear", () => {
		open("abc");

		fireEvent.click(action("Clear"));

		expect(field()).toHaveValue("");
	});

	it("takes what the remote's microphone or a keyboard puts in the field", () => {
		open("abc");

		fireEvent.change(field(), { target: { value: "spoken" } });
		type("s");

		expect(field()).toHaveValue("spokens");
	});

	it("hands over the text with Done, starting from what it opened with", () => {
		const { onDone, onCancel } = open("http://");

		type("a");
		fireEvent.click(action("Done"));

		expect(onDone).toHaveBeenCalledExactlyOnceWith("http://a");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("cancels on Back without handing over the text", () => {
		const { onDone, onCancel } = open("abc");

		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

		expect(onCancel).toHaveBeenCalledOnce();
		expect(onDone).not.toHaveBeenCalled();
	});

	it("keeps the end of a long URL in view, as it opens and as it grows", () => {
		const width = vi.spyOn(Element.prototype, "scrollWidth", "get").mockReturnValue(640);
		open("http://a-long-address.example.test");

		expect(field().scrollLeft).toBe(640);

		width.mockReturnValue(700);
		type("a");

		expect(field().scrollLeft).toBe(700);
	});

	it("leaves the field's text as typed, with the system's corrections off", () => {
		open();

		expect(field()).toHaveAttribute("type", "text");
		expect(field()).toHaveAttribute("autocomplete", "off");
		expect(field()).toHaveAttribute("autocapitalize", "none");
		expect(field()).toHaveAttribute("autocorrect", "off");
		expect(field()).toHaveAttribute("spellcheck", "false");
	});
});
