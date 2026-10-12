// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useId, useState, type FormEvent, type ReactNode, type Ref } from "react";
import { AlertCircle, CheckCircle, Eye, EyeOff, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ApiKeyState } from "@/hooks/useApiKey";
import { cn } from "@/lib/utils";

interface ApiKeyFieldProps {
	/** The service, as in "OMDb API key". */
	name: string;
	description?: ReactNode;
	field: ApiKeyState;
	placeholder: string;
	/** Where to get a key. The link shows while no key is saved. */
	getKey: { url: string; text: string };
	/** Said after "Valid key", such as the free plan's limit. */
	validNote?: string;
	inputRef?: Ref<HTMLInputElement>;
}

const TONES = {
	ok: "text-green-500",
	warn: "text-amber-500",
	error: "text-destructive",
} as const;

const StatusLine = ({
	tone,
	icon: Icon,
	children,
}: {
	tone: keyof typeof TONES;
	icon: typeof CheckCircle;
	children: ReactNode;
}) => (
	<span className={cn("flex items-center gap-1", TONES[tone])}>
		<Icon className="h-3 w-3 shrink-0" aria-hidden="true" /> {children}
	</span>
);

/** The outcome of the last save or check, or nothing when there's none to show. */
const KeyStatus = ({ field, validNote }: { field: ApiKeyState; validNote?: string }) => {
	if (field.saveStatus === "error") {
		return (
			<StatusLine tone="error" icon={XCircle}>
				Couldn't save the key. Try again.
			</StatusLine>
		);
	}
	// The buttons show these. The status line says them for screen readers.
	if (field.saveStatus === "saving") return <span className="sr-only">Saving the key</span>;
	switch (field.testStatus) {
		case "testing":
			return <span className="sr-only">Checking the key</span>;
		case "valid":
			return (
				<StatusLine tone="ok" icon={CheckCircle}>
					{validNote ? `Valid key. ${validNote}` : "Valid key"}
				</StatusLine>
			);
		case "invalid":
			return (
				<StatusLine tone="error" icon={XCircle}>
					Invalid key
				</StatusLine>
			);
		case "unreachable":
			return (
				<StatusLine tone="warn" icon={AlertCircle}>
					Couldn't check the key. Check your connection and try again.
				</StatusLine>
			);
	}
	if (field.loadFailed) {
		return (
			<StatusLine tone="error" icon={XCircle}>
				Couldn't read the saved key
			</StatusLine>
		);
	}
	if (field.saveStatus === "saved") return <span className="sr-only">Key saved</span>;
	if (field.saveStatus === "removed") return <span className="sr-only">Key removed</span>;
	return null;
};

/** What the Save button says. Save and Remove name the key for screen readers. */
const SaveLabel = ({ field, name }: { field: ApiKeyState; name: string }) => {
	switch (field.saveStatus) {
		case "saving":
			return <>Saving…</>;
		case "saved":
		case "removed":
			return (
				<span className="flex items-center gap-1 text-green-500">
					<CheckCircle className="h-4 w-4" aria-hidden="true" />
					{field.saveStatus === "saved" ? "Saved" : "Removed"}
				</span>
			);
	}
	// Saving a blank field removes the key, so the button says so. A key that
	// couldn't be read may still be there, so it can be removed too.
	const action = !field.value.trim() && (field.saved || field.loadFailed) ? "Remove" : "Save";
	return (
		<>
			{action}
			<span className="sr-only"> {name} API key</span>
		</>
	);
};

/**
 * A labeled field for an API key, with Save, Test and a show or hide toggle.
 * Enter saves. Save turns into Remove when the field is cleared while a key
 * is saved, or while the saved key couldn't be read. The line under the field says how the last save or check went,
 * and screen readers hear it as it changes.
 */
export const ApiKeyField = ({
	name,
	description,
	field,
	placeholder,
	getKey,
	validNote,
	inputRef,
}: ApiKeyFieldProps) => {
	const [visible, setVisible] = useState(false);
	const inputId = useId();
	const descriptionId = useId();
	const statusId = useId();
	// Pressing Saved or Removed saves again, which restarts its timer.
	const canSave = field.dirty || field.saveStatus === "saved" || field.saveStatus === "removed";

	const handleSubmit = (e: FormEvent) => {
		e.preventDefault();
		if (canSave) void field.save();
	};

	return (
		<form onSubmit={handleSubmit}>
			<label htmlFor={inputId} className="mb-1 block text-sm font-medium">
				{name} API key
			</label>
			{description && (
				<p id={descriptionId} className="mb-2 text-xs text-muted-foreground">
					{description}
				</p>
			)}
			<div className="flex items-center gap-2">
				<div className="relative flex-1">
					<Input
						id={inputId}
						ref={inputRef}
						type={visible ? "text" : "password"}
						placeholder={placeholder}
						value={field.value}
						onChange={(e) => field.setValue(e.target.value)}
						autoComplete="off"
						autoCapitalize="none"
						autoCorrect="off"
						spellCheck={false}
						aria-describedby={description ? `${descriptionId} ${statusId}` : statusId}
						aria-invalid={field.testStatus === "invalid" || undefined}
						className="pr-10"
					/>
					<button
						type="button"
						className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
						onClick={() => setVisible((v) => !v)}
						aria-label={`Show ${name} API key`}
						aria-pressed={visible}
					>
						{visible ? (
							<EyeOff className="h-4 w-4" aria-hidden="true" />
						) : (
							<Eye className="h-4 w-4" aria-hidden="true" />
						)}
					</button>
				</div>
				{/* While busy, the buttons stay enabled so they keep focus, and the hook
				    ignores clicks. Save also stays enabled when it has nothing to do, so
				    it keeps focus when Saved turns back into Save. aria-disabled tells
				    screen readers. */}
				<Button
					type="submit"
					size="sm"
					variant="secondary"
					aria-disabled={!canSave || field.saveStatus === "saving" || undefined}
					// Dim, with no hover or pointer, as a disabled button looks. It
					// brightens while focused from the keyboard so the ring shows.
					className={
						canSave
							? undefined
							: "cursor-default opacity-50 hover:bg-secondary focus-visible:opacity-100"
					}
				>
					<SaveLabel field={field} name={name} />
				</Button>
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => void field.test()}
					disabled={!field.value.trim()}
					aria-disabled={field.testStatus === "testing" || undefined}
				>
					{field.testStatus === "testing" ? (
						"Testing…"
					) : (
						<>
							Test<span className="sr-only"> {name} API key</span>
						</>
					)}
				</Button>
			</div>
			{/* A hidden live region goes unheard when it fills, so this one stays and only drops its margin. */}
			<div id={statusId} role="status" className="mt-2 text-xs empty:mt-0">
				<KeyStatus field={field} validNote={validNote} />
			</div>
			{!field.saved && (
				<p className="mt-1 text-xs text-muted-foreground">
					<a
						href={getKey.url}
						target="_blank"
						rel="noreferrer"
						className="underline hover:text-foreground"
					>
						{getKey.text}
					</a>
				</p>
			)}
		</form>
	);
};
