// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useNavigate } from "react-router-dom";

/** Route state that makes Settings scroll to the OMDb key field. */
export const OMDB_KEY_FOCUS = { focus: "omdb" } as const;

interface OmdbKeyHintProps {
	/** Closes the sheet the hint sits in before Settings opens. */
	onNavigate: () => void;
}

/** Shown in an info sheet in place of the OMDb details when no key is saved. */
export const OmdbKeyHint = ({ onNavigate }: OmdbKeyHintProps) => {
	const navigate = useNavigate();

	const handleClick = () => {
		onNavigate();
		navigate("/settings", { state: OMDB_KEY_FOCUS });
	};

	return (
		<button
			type="button"
			onClick={handleClick}
			className="text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
		>
			Add an OMDb API key in <span className="underline underline-offset-2">Settings</span> to
			see the plot, cast and ratings.
		</button>
	);
};
