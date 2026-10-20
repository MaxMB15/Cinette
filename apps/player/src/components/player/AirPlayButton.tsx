// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Airplay } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLatestRef } from "@/hooks/useLatestRef";

/** How long a reason stays up. */
const NOTICE_MS = 6000;

interface AirPlayButtonProps {
	/**
	 * Sends the current item to AirPlay, with the system picker anchored at
	 * the button. `confirm` asks the user, with `warning`, before this
	 * device converts the stream. Resolves to why it couldn't, or `null`.
	 */
	onSend: (anchor: DOMRect, confirm: () => Promise<boolean>) => Promise<string | null>;
	/** What the confirm step says before a conversion. */
	warning: string;
}

/** Asks before this device converts a stream for the TV. Escape says no. */
const ConfirmConvert = ({
	warning,
	onAnswer,
}: {
	warning: string;
	onAnswer: (ok: boolean) => void;
}) => {
	const answer = useLatestRef(onAnswer);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") answer.current(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [answer]);
	return (
		<div
			role="dialog"
			aria-label="Convert on this device?"
			className="absolute right-0 bottom-full mb-2 w-64 rounded bg-black/90 px-3 py-2 text-left text-xs text-white"
		>
			<p>{warning}</p>
			<div className="mt-2 flex justify-end gap-2">
				<Button variant="ghost" size="sm" onClick={() => onAnswer(false)}>
					Cancel
				</Button>
				<Button variant="secondary" size="sm" onClick={() => onAnswer(true)}>
					Send to TV
				</Button>
			</div>
		</div>
	);
};

/**
 * The player's AirPlay button. It asks before this device converts a
 * stream, and says why under it when an item can't go.
 */
export const AirPlayButton = ({ onSend, warning }: AirPlayButtonProps) => {
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [asking, setAsking] = useState<((ok: boolean) => void) | null>(null);

	const confirm = () => new Promise<boolean>((resolve) => setAsking(() => resolve));

	// A question still open when the button goes is a no, so the send it
	// holds up ends.
	const open = useLatestRef(asking);
	useEffect(() => () => open.current?.(false), [open]);

	// A reason that's gone already has nothing to clear, which is harmless.
	useEffect(() => {
		const timer = setTimeout(() => setNotice(null), NOTICE_MS);
		return () => clearTimeout(timer);
	}, [notice]);

	// The button is disabled while a send runs, so one runs at a time.
	const send = async (anchor: DOMRect) => {
		setBusy(true);
		setNotice(null);
		// On the promise, since the React Compiler can't compile `finally`.
		const notice = await onSend(anchor, confirm).catch(() => "Couldn't start AirPlay.");
		setNotice(notice);
		setBusy(false);
	};

	return (
		<div className="relative">
			<Button
				variant="ghost"
				size="icon"
				className="text-white hover:bg-white/20"
				onClick={(e) => void send(e.currentTarget.getBoundingClientRect())}
				disabled={busy}
				aria-label="AirPlay"
			>
				<Airplay className="h-5 w-5" />
			</Button>
			{asking && (
				<ConfirmConvert
					warning={warning}
					onAnswer={(ok) => {
						asking(ok);
						setAsking(null);
					}}
				/>
			)}
			{notice && (
				<p
					role="alert"
					className="absolute right-0 bottom-full mb-2 w-56 rounded bg-black/90 px-3 py-2 text-left text-xs text-white"
				>
					{notice}
				</p>
			)}
		</div>
	);
};
