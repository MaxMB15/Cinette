// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/** What Back did. "exit" leaves Android to close the app. */
export type BackResult = "closed" | "home" | "exit";

/**
 * Back on a TV remote. Escape already closes the top layer everywhere in
 * the app, such as a dialog, the player's panels or the player itself, so
 * Back sends Escape to the focused element first. A handler that takes it
 * cancels it or stops it on its way up. When nothing does, Back goes to the
 * home page, the way the player's Escape does, and on the home page it lets
 * the app close. It doesn't go back through the history, which could open
 * the player again.
 */
export const handleBack = (doc: Document, atHome: boolean, goHome: () => void): BackResult => {
	const target = doc.activeElement ?? doc.body;
	const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
	// A dialog stops Escape in the capture phase on the document, so it
	// never bubbles back up to it.
	let reachedTop = false;
	const listener = () => {
		reachedTop = true;
	};
	doc.addEventListener("keydown", listener);
	try {
		target.dispatchEvent(escape);
	} finally {
		doc.removeEventListener("keydown", listener);
	}
	if (escape.defaultPrevented || !reachedTop) return "closed";
	if (atHome) return "exit";
	goHome();
	return "home";
};
