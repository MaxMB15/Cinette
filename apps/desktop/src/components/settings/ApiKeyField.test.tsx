// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { createRef, type ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiKeyState } from "@/hooks/useApiKey";
import { ApiKeyField } from "./ApiKeyField";

/** A field with nothing typed or saved, whose actions do nothing. */
const makeField = (state: Partial<ApiKeyState> = {}): ApiKeyState => ({
	value: "",
	saved: "",
	loadFailed: false,
	saveStatus: "idle",
	testStatus: "idle",
	dirty: false,
	setValue: vi.fn(),
	save: vi.fn().mockResolvedValue(undefined),
	test: vi.fn().mockResolvedValue(undefined),
	...state,
});

const renderField = (
	state: Partial<ApiKeyState> = {},
	props: Partial<ComponentProps<typeof ApiKeyField>> = {}
) => {
	const field = makeField(state);
	render(
		<ApiKeyField
			name="Acme"
			field={field}
			placeholder="Enter Acme API key…"
			getKey={{ url: "https://example.com/keys", text: "Get a key at example.com" }}
			{...props}
		/>
	);
	return field;
};

const input = () => screen.getByLabelText("Acme API key");
const saveButton = () =>
	screen.getByRole("button", { name: /^(Save|Remove|Saving|Saved|Removed)/ });
const testButton = () => screen.getByRole("button", { name: /^(Test|Testing)/ });

describe("ApiKeyField", () => {
	it("labels the field and describes it with its description and status", () => {
		renderField(
			{ testStatus: "invalid", value: "typed-key" },
			{ description: "Finds things." }
		);

		expect(input()).toHaveAttribute("type", "password");
		expect(input()).toHaveAttribute("placeholder", "Enter Acme API key…");
		expect(input()).toHaveValue("typed-key");
		expect(input()).toHaveAccessibleDescription("Finds things. Invalid key");
	});

	it("describes the field with its status alone when it has no description", () => {
		renderField({ testStatus: "invalid", value: "typed-key" });
		expect(input()).toHaveAccessibleDescription("Invalid key");
	});

	it("turns off the browser's help with what's typed", () => {
		renderField();
		expect(input()).toHaveAttribute("autocomplete", "off");
		expect(input()).toHaveAttribute("autocapitalize", "none");
		expect(input()).toHaveAttribute("autocorrect", "off");
		expect(input()).toHaveAttribute("spellcheck", "false");
	});

	it("passes typing on to the field", () => {
		const field = renderField();
		fireEvent.change(input(), { target: { value: "typed-key" } });
		expect(field.setValue).toHaveBeenCalledExactlyOnceWith("typed-key");
	});

	it("shows and hides the key", () => {
		renderField({ value: "typed-key" });
		const toggle = screen.getByRole("button", { name: "Show Acme API key" });
		expect(toggle).toHaveAttribute("aria-pressed", "false");

		fireEvent.click(toggle);
		expect(input()).toHaveAttribute("type", "text");
		expect(toggle).toHaveAttribute("aria-pressed", "true");

		fireEvent.click(toggle);
		expect(input()).toHaveAttribute("type", "password");
		expect(toggle).toHaveAttribute("aria-pressed", "false");
	});

	it("hands its input to the ref it's given", () => {
		const ref = createRef<HTMLInputElement>();
		renderField({}, { inputRef: ref });
		expect(ref.current).toBe(input());
	});
});

describe("ApiKeyField Save", () => {
	it.each([
		["nothing has changed", {}, "Save Acme API key", false],
		[
			"the field differs from the saved key",
			{ dirty: true, value: "new-key" },
			"Save Acme API key",
			true,
		],
		[
			"the field is cleared while a key is saved",
			{ dirty: true, saved: "old-key" },
			"Remove Acme API key",
			true,
		],
		[
			"the field holds only spaces while a key is saved",
			{ dirty: true, value: "  ", saved: "old-key" },
			"Remove Acme API key",
			true,
		],
		[
			"the field is blank and the saved key can't be read",
			{ dirty: true, loadFailed: true },
			"Remove Acme API key",
			true,
		],
		[
			"the field holds a key and the saved key can't be read",
			{ dirty: true, value: "new-key", loadFailed: true },
			"Save Acme API key",
			true,
		],
		["a save just worked", { saveStatus: "saved" }, "Saved", true],
		["a removal just worked", { saveStatus: "removed" }, "Removed", true],
	] as const)("is called %s", (_, state, name, available) => {
		renderField(state);
		const button = screen.getByRole("button", { name });
		expect(button).toHaveAttribute("type", "submit");
		// It stays enabled either way, so it never drops focus.
		expect(button).toBeEnabled();
		if (available) {
			expect(button).not.toHaveAttribute("aria-disabled");
			expect(button).not.toHaveClass("opacity-50");
		} else {
			expect(button).toHaveAttribute("aria-disabled", "true");
			// Dim like a disabled button, but bright while focused so the ring shows.
			expect(button).toHaveClass("opacity-50", "cursor-default", "focus-visible:opacity-100");
		}
	});

	it("says Saving and tells screen readers it's busy while a save runs", () => {
		renderField({ dirty: true, value: "new-key", saveStatus: "saving" });
		expect(saveButton()).toHaveTextContent("Saving…");
		expect(saveButton()).toBeEnabled();
		expect(saveButton()).toHaveAttribute("aria-disabled", "true");
	});

	it("saves when the form is sent, as Enter in the field does, and stays on the page", () => {
		const field = renderField({ dirty: true, value: "new-key" });
		// fireEvent returns false when the default action was stopped.
		expect(fireEvent.submit(input())).toBe(false);
		expect(field.save).toHaveBeenCalledOnce();
	});

	it("saves again while Saved shows, so the button keeps focus", () => {
		const field = renderField({ saveStatus: "saved" });
		fireEvent.click(saveButton());
		expect(field.save).toHaveBeenCalledOnce();
	});

	it("doesn't save when nothing has changed, from Enter or the button", () => {
		const field = renderField({ value: "saved-key", saved: "saved-key" });
		expect(fireEvent.submit(input())).toBe(false);
		fireEvent.click(saveButton());
		expect(field.save).not.toHaveBeenCalled();
	});
});

describe("ApiKeyField Test", () => {
	it("can't check a blank field", () => {
		renderField({ value: "   " });
		expect(screen.getByRole("button", { name: "Test Acme API key" })).toBeDisabled();
	});

	it("checks what's typed", () => {
		const field = renderField({ value: "typed-key" });
		fireEvent.click(screen.getByRole("button", { name: "Test Acme API key" }));
		expect(field.test).toHaveBeenCalledOnce();
		expect(field.save).not.toHaveBeenCalled();
	});

	it("says Testing while the check runs and tells screen readers it's busy", () => {
		renderField({ value: "typed-key", testStatus: "testing" });
		expect(testButton()).toHaveTextContent("Testing…");
		expect(testButton()).toHaveAttribute("aria-disabled", "true");
		expect(screen.getByRole("status")).toHaveTextContent("Checking the key");
	});
});

describe("ApiKeyField status", () => {
	it.each([
		["a save failed", { saveStatus: "error" }, "Couldn't save the key. Try again."],
		["a save is running", { saveStatus: "saving" }, "Saving the key"],
		["the key is valid", { testStatus: "valid" }, "Valid key"],
		["the key is invalid", { testStatus: "invalid" }, "Invalid key"],
		[
			"the check failed",
			{ testStatus: "unreachable" },
			"Couldn't check the key. Check your connection and try again.",
		],
		["the saved key can't be read", { loadFailed: true }, "Couldn't read the saved key"],
		["a save worked", { saveStatus: "saved" }, "Key saved"],
		["a removal worked", { saveStatus: "removed" }, "Key removed"],
		[
			"a save failed after a check",
			{ saveStatus: "error", testStatus: "valid" },
			"Couldn't save the key. Try again.",
		],
		[
			"a check came back after a failed read",
			{ loadFailed: true, testStatus: "invalid" },
			"Invalid key",
		],
		["nothing has happened", {}, ""],
	] as const)("says what happened when %s", (_, state, text) => {
		renderField({ value: "typed-key", ...state });
		expect(screen.getByRole("status")).toHaveTextContent(text, { normalizeWhitespace: true });
		if (!text) expect(screen.getByRole("status")).toBeEmptyDOMElement();
	});

	it("adds the service's note to a valid key", () => {
		renderField({ testStatus: "valid" }, { validNote: "Free keys allow 1,000 calls a day." });
		expect(screen.getByRole("status")).toHaveTextContent(
			"Valid key. Free keys allow 1,000 calls a day."
		);
	});

	it("marks the field invalid only when the service turned the key down", () => {
		renderField({ value: "typed-key", testStatus: "invalid" });
		expect(input()).toHaveAttribute("aria-invalid", "true");
	});

	it.each(["idle", "valid", "unreachable"] as const)(
		"leaves the field unmarked when the check is %s",
		(testStatus) => {
			renderField({ value: "typed-key", testStatus });
			expect(input()).not.toHaveAttribute("aria-invalid");
		}
	);
});

describe("ApiKeyField link", () => {
	it("says where to get a key while none is saved", () => {
		renderField({ value: "typed-key" });
		const link = screen.getByRole("link", { name: "Get a key at example.com" });
		expect(link).toHaveAttribute("href", "https://example.com/keys");
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noreferrer");
	});

	it("goes away once a key is saved", () => {
		renderField({ saved: "saved-key", value: "saved-key" });
		expect(screen.queryByRole("link")).toBeNull();
	});
});
