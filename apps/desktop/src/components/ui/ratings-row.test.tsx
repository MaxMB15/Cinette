// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RatingsRow } from "./ratings-row";
import { makeOmdb } from "@/test/detail-fixtures";

describe("RatingsRow", () => {
	afterEach(cleanup);

	it("renders nothing without any ratings", () => {
		const { container } = render(<RatingsRow />);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing when OMDb only has N/A ratings", () => {
		const { container } = render(
			<RatingsRow omdbData={makeOmdb({ imdbRating: "N/A", rottenTomatoes: "N/A" })} />
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows the IMDb and Rotten Tomatoes ratings from OMDb", () => {
		render(<RatingsRow omdbData={makeOmdb()} whatsonData={null} />);
		expect(screen.getByText("7.4")).toBeInTheDocument();
		expect(screen.getByText("🍅 88%")).toBeInTheDocument();
		expect(screen.queryByText(/🍿/)).toBeNull();
	});

	it("prefers the Whatson ratings and shows their vote counts", () => {
		render(
			<RatingsRow
				omdbData={makeOmdb()}
				whatsonData={{
					imdbRating: 8.24,
					imdbVotes: 1_234_567,
					rtCriticsRating: 91,
					rtCriticsCount: 312,
					rtAudienceRating: 85,
					rtAudienceCount: 25_400,
				}}
			/>
		);
		expect(screen.getByText("8.2")).toBeInTheDocument();
		expect(screen.getByText("· 1.2M")).toBeInTheDocument();
		expect(screen.getByText("🍅 91%")).toBeInTheDocument();
		expect(screen.getByText("· 312")).toBeInTheDocument();
		expect(screen.getByText("🍿 85%")).toBeInTheDocument();
		expect(screen.getByText("· 25K")).toBeInTheDocument();
		expect(screen.queryByText("7.4")).toBeNull();
		expect(screen.queryByText("🍅 88%")).toBeNull();
	});

	it("falls back to OMDb for the ratings Whatson doesn't have", () => {
		render(<RatingsRow omdbData={makeOmdb()} whatsonData={{ rtAudienceRating: 70 }} />);
		expect(screen.getByText("7.4")).toBeInTheDocument();
		expect(screen.getByText("🍅 88%")).toBeInTheDocument();
		expect(screen.getByText("🍿 70%")).toBeInTheDocument();
	});

	it("shows a rating without counts when Whatson has none", () => {
		const { container } = render(
			<RatingsRow whatsonData={{ imdbRating: 6, rtCriticsRating: 40 }} />
		);
		expect(screen.getByText("6.0")).toBeInTheDocument();
		expect(screen.getByText("🍅 40%")).toBeInTheDocument();
		expect(container.textContent).not.toContain("·");
	});
});
