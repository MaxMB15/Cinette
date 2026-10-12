// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useCallback, useEffect, useRef, useState } from "react";

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
	/** Whether the field differs from the saved key, so Save has something to do. */
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
	const alive = useRef(true);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearTimer = () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
	};

	useEffect(() => {
		alive.current = true;
		service
			.load()
			.then((key) => {
				if (!alive.current) return;
				const stored = key?.trim() ?? "";
				setSaved(stored);
				// Text typed while the key loaded stays.
				if (!edited.current) setValueState(stored);
			})
			.catch(() => {
				if (alive.current) setLoadFailed(true);
			});
		return () => {
			alive.current = false;
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
		try {
			await service.save(key);
			service.onSaved?.(key);
			if (!alive.current) return;
			setSaved(key);
			setLoadFailed(false);
			if (generation.current !== started) {
				setSaveStatus("idle");
				return;
			}
			setValueState(key);
			setTestStatus("idle");
			setSaveStatus(key ? "saved" : "removed");
			timer.current = setTimeout(() => setSaveStatus("idle"), SAVED_MS);
		} catch {
			if (alive.current) setSaveStatus(generation.current === started ? "error" : "idle");
		} finally {
			saving.current = false;
		}
	}, [service, value]);

	const test = useCallback(async () => {
		const key = value.trim();
		if (!key || testStatus === "testing") return;
		const started = generation.current;
		setTestStatus("testing");
		let result: KeyTestStatus;
		try {
			result = (await service.test(key)) ? "valid" : "invalid";
		} catch {
			result = "unreachable";
		}
		if (alive.current && generation.current === started) setTestStatus(result);
	}, [service, value, testStatus]);

	return {
		value,
		saved,
		loadFailed,
		saveStatus,
		testStatus,
		dirty: value.trim() !== saved,
		setValue,
		save,
		test,
	};
};
