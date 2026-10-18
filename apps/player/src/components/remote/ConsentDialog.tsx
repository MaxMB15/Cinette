// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "@/components/ui/dialog";
import { useConsentRequest, type ConsentRequest } from "@/hooks/useRemoteTarget";
import { cn } from "@/lib/utils";
import { deviceTypeName, formatCode, secondsLeft } from "@/lib/remote-devices";

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
	return createPortal(
		<Dialog
			onClose={() => answer(false)}
			labelledBy={titleId}
			// Above the full screen player, which sits at z-9999.
			overlayClassName="z-10000"
			className="bg-card border border-border rounded-lg p-5 w-[340px] max-w-[calc(100vw-2rem)] shadow-xl"
		>
			<h2 id={titleId} className="text-base font-semibold mb-1">
				Allow {request.name} to control this device?
			</h2>
			<p className="text-xs text-muted-foreground mb-4">
				{deviceTypeName(request.deviceType)} on your network. It will be able to play, pause
				and choose what plays here, and see what this device can play. Only allow it if the
				code matches the one on that device.
			</p>
			<p
				className="text-3xl font-mono font-semibold tracking-widest text-center mb-1"
				aria-label={`Code ${request.code.split("").join(" ")}`}
			>
				{formatCode(request.code)}
			</p>
			<p className="text-xs text-muted-foreground text-center mb-5" aria-live="polite">
				{left > 0 ? `Expires in ${left} s` : "Expired"}
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
					className={`${BUTTON} bg-primary text-primary-foreground hover:bg-primary/90`}
					onClick={() => answer(true)}
				>
					Allow
				</button>
			</div>
		</Dialog>,
		document.body
	);
};
