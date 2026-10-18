// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useCallback, useEffect, useRef, useState } from "react";
import { useChanged } from "@/hooks/useChanged";

/** Where a save is up to. "saved" and "removed" show for a moment, then go back to idle. */
export type KeySaveStatus = "idle" | "saving" | "saved" | "removed" | "error";

/** What the last check of the key found. "unreachable" means the check itself failed. */
export type KeyTestStatus = "idle" | "testing" | "valid" | "invalid" | "unreachable";

/** The backend calls behind one API key. */
export interface ApiKeyService {
	/** The saved key, or null when none is saved. */
	load: () => Promise<string | null>;
	/** Saves the key. A blank key removes the saved one. */
	save: (key: string) => Promise<void>;
	/** Whether the service takes the key. Rejects when it can't be reached. */
	test: (key: string) => Promise<boolean>;
	/**
	 * Runs after every save that goes through, with the trimmed key or "" for
	 * a removal. It runs even when the field has gone by then, since the key
	 * is saved either way.
	 */
	onSaved?: (key: string) => void;
}

export interface ApiKeyState {
	/** The text in the field. */
	value: string;
	/** The saved key, or "" when none is saved or it couldn't be read. */
	saved: string;
	loadFailed: boolean;
	saveStatus: KeySaveStatus;
	testStatus: KeyTestStatus;
	/**
	 * Whether Save has something to do. It does when the field differs from
	 * the saved key, and always when the saved key couldn't be read.
	 */
	dirty: boolean;
	setValue: (value: string) => void;
	save: () => Promise<void>;
	test: () => Promise<void>;
}

/** How long Saved or Removed shows before the button goes back to normal. */
export const SAVED_MS = 2000;

/**
 * The state behind an API key field: the saved key, the text being edited,
 * and the results of saving and checking it. Editing the field drops any
 * result that hasn't come back yet, so a check of the old text can't mark
 * the new text valid. Pass a service defined once, outside any component,
 * since a new one loads the key again.
 */
export const useApiKey = (service: ApiKeyService): ApiKeyState => {
	const [value, setValueState] = useState("");
	const [saved, setSaved] = useState("");
	const [loadFailed, setLoadFailed] = useState(false);
	const [saveStatus, setSaveStatus] = useState<KeySaveStatus>("idle");
	const [testStatus, setTestStatus] = useState<KeyTestStatus>("idle");

	// Goes up on every edit. A result only shows when it hasn't moved since
	// the save or check began.
	const generation = useRef(0);
	const edited = useRef(false);
	const saving = useRef(false);
	// The service a save last went through since the key began loading. A
	// load that lands after it is out of date.
	const savedFor = useRef<ApiKeyService | null>(null);
	// The service the field shows, or null once the field has gone. A save or
	// check only shows its result while its service is still this one.
	const shown = useRef<ApiKeyService | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearTimer = () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
	};

	// Results for another service don't belong to this one. A save or check
	// still on its way clears its own status when it lands.
	const serviceChanged = useChanged(service);
	if (serviceChanged) {
		setSaveStatus((status) => (status === "saving" ? status : "idle"));
		setTestStatus((status) => (status === "testing" ? status : "idle"));
	}

	useEffect(() => {
		shown.current = service;
		savedFor.current = null;
		// Each run drops its own load when it ends, so a load from an earlier
		// run, or from Strict Mode's first one, can't land after a newer one.
		let current = true;
		const isStale = () => !current || savedFor.current === service;
		service
			.load()
			.then((key) => {
				if (isStale()) return;
				const stored = key?.trim() ?? "";
				setSaved(stored);
				setLoadFailed(false);
				// Text typed while the key loaded stays.
				if (!edited.current) setValueState(stored);
			})
			.catch(() => {
				if (!isStale()) setLoadFailed(true);
			});
		return () => {
			current = false;
			shown.current = null;
			clearTimer();
		};
	}, [service]);

	const setValue = useCallback((next: string) => {
		edited.current = true;
		generation.current += 1;
		clearTimer();
		setValueState(next);
		setTestStatus("idle");
		// A save already on its way keeps showing until it lands.
		setSaveStatus((status) => (status === "saving" ? status : "idle"));
	}, []);

	const save = useCallback(async () => {
		if (saving.current) return;
		saving.current = true;
		const key = value.trim();
		const started = generation.current;
		clearTimer();
		setSaveStatus("saving");
		// Whether the field still shows this service and the text that was saved.
		// When it moved to another service, only Saving needs to go.
		const forService = () => shown.current === service;
		const forText = () => forService() && generation.current === started;
		// Not a finally, which the React Compiler can't compile yet.
		let failed = false;
		try {
			await service.save(key);
			savedFor.current = service;
		} catch {
			failed = true;
		}
		saving.current = false;
		if (failed) {
			setSaveStatus(forText() ? "error" : "idle");
			return;
		}
		if (forService()) {
			setSaved(key);
			setLoadFailed(false);
		}
		if (forText()) {
			setValueState(key);
			// The status line says the key saved, which a check result would
			// cover up. The saved key can be checked again.
			setTestStatus("idle");
			setSaveStatus(key ? "saved" : "removed");
			timer.current = setTimeout(() => setSaveStatus("idle"), SAVED_MS);
		} else {
			setSaveStatus("idle");
		}
		// The key is saved either way, so a listener that throws doesn't make
		// the save look failed.
		if (service.onSaved) {
			try {
				service.onSaved(key);
			} catch (e) {
				console.error("Couldn't report the saved key", e);
			}
		}
	}, [service, value]);

	const test = useCallback(async () => {
		const key = value.trim();
		if (!key || testStatus === "testing") return;
		const started = generation.current;
		setTestStatus("testing");
		// Promise callbacks in place of a try, which the React Compiler can't
		// compile with the ternary. Starting from a promise catches a check
		// that throws before it returns one, as the try did.
		const result = await Promise.resolve()
			.then(() => service.test(key))
			.then(
				(valid): KeyTestStatus => (valid ? "valid" : "invalid"),
				(): KeyTestStatus => "unreachable"
			);
		// An edit already cleared Testing, and the new text may have a check of
		// its own on the way.
		if (generation.current !== started) return;
		setTestStatus(shown.current === service ? result : "idle");
	}, [service, value, testStatus]);

	return {
		value,
		saved,
		loadFailed,
		saveStatus,
		testStatus,
		dirty: loadFailed || value.trim() !== saved,
		setValue,
		save,
		test,
	};
};
