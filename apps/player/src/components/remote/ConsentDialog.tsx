// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "@/components/ui/dialog";
import { useConsentRequest, type ConsentRequest } from "@/hooks/useRemoteTarget";
import { cn } from "@/lib/utils";
import { deviceTypeName, formatCode, secondsLeft } from "@/lib/remote-devices";

/** How long Allow waits after a request shows, or the window gains focus,
 *  before it works, so a click or key meant for something else can't
 *  allow a request no one read. */
export const ARM_MS = 1000;

const BUTTON = cn(
	"px-4 py-2 text-sm rounded-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
);

/**
 * Asks whether another device may control this one, under "Only when
 * allowed". It shows the device's name and type and the code the other
 * screen shows, so the user can tell their own request from a neighbor's.
 * Closing it, Escape or a click outside denies. It goes away by itself when
 * the request runs out or is withdrawn.
 */
export const ConsentDialog = () => {
	const { request, answer } = useConsentRequest();
	// A new request gets a dialog, and a clock, of its own.
	return request ? (
		<ConsentPrompt
			key={request.request}
			request={request}
			answer={(allow) => answer(request, allow)}
		/>
	) : null;
};

const ConsentPrompt = ({
	request,
	answer,
}: {
	request: ConsentRequest;
	answer: (allow: boolean) => void;
}) => {
	const titleId = useId();
	const [now, setNow] = useState(() => performance.now());
	useEffect(
		() => {
			const timer = setInterval(() => setNow(performance.now()), 250);
			return () => clearInterval(timer);
		},
		// Stryker disable next-line ArrayDeclaration: any list that never changes runs the effect once, as this one does.
		[]
	);
	const left = secondsLeft(request.expiresAt, now);
	// A new request mounts a new prompt, so it waits again.
	const [armedAt, setArmedAt] = useState(() => performance.now() + ARM_MS);
	useEffect(
		() => {
			const rearm = () => setArmedAt(performance.now() + ARM_MS);
			window.addEventListener("focus", rearm);
			return () => window.removeEventListener("focus", rearm);
		},
		// Stryker disable next-line ArrayDeclaration: any list that never changes runs the effect once, as this one does.
		[]
	);
	const armed = now >= armedAt;
	// A pointer press that began before this prompt was on screen was
	// meant for what was there before.
	const pressedHere = useRef(false);
	const allow = (fromPointer: boolean) => {
		// Past its time, the button is disabled.
		if (performance.now() < armedAt) return;
		if (fromPointer && !pressedHere.current) return;
		answer(true);
	};
	return createPortal(
		<Dialog
			onClose={() => answer(false)}
			labelledBy={titleId}
			// Above the full screen player, which sits at z-9999.
			overlayClassName="z-10000"
			className="bg-card border border-border rounded-lg p-5 w-[340px] max-w-[calc(100vw-2rem)] shadow-xl"
		>
			{/* Focus starts here rather than on Deny, so a key pressed for the
			    player behind, like Space, doesn't answer the request. */}
			<h2
				id={titleId}
				tabIndex={0}
				className="text-base font-semibold mb-1 break-words focus-visible:outline-hidden"
			>
				Allow “<bdi className="font-bold">{request.name}</bdi>” to control this device?
			</h2>
			<p className="text-xs text-muted-foreground mb-4">
				{deviceTypeName(request.deviceType)} on your network. It will be able to play, pause
				and choose what plays here, and see what this device can play. Only allow it if the
				code matches the one on that device.
			</p>
			<p className="text-3xl font-mono font-semibold tracking-widest text-center mb-1">
				<span aria-hidden>{formatCode(request.code)}</span>
				<span className="sr-only">Code {request.code.split("").join(" ")}</span>
			</p>
			<p className="text-xs text-muted-foreground text-center mb-5">
				{left > 0 ? `Expires in ${left} s` : "Expired"}
			</p>
			{/* Only the end is read out, not every second of the count. */}
			<p className="sr-only" aria-live="polite">
				{left > 0 ? "" : "The request expired."}
			</p>
			<div className="flex justify-end gap-2">
				<button
					type="button"
					className={`${BUTTON} hover:bg-accent`}
					onClick={() => answer(false)}
				>
					Deny
				</button>
				<button
					type="button"
					disabled={left === 0}
					aria-disabled={armed ? undefined : "true"}
					className={cn(
						`${BUTTON} bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50`,
						!armed && "opacity-50 cursor-default hover:bg-primary"
					)}
					onPointerDown={() => (pressedHere.current = true)}
					// A click from a key has no pointer press; detail counts clicks.
					onClick={(e) => allow(e.detail > 0)}
				>
					Allow
				</button>
			</div>
		</Dialog>,
		document.body
	);
};
