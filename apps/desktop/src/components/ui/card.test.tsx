// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, afterEach } from "vitest";
import { createRef } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";

afterEach(cleanup);

describe("Card", () => {
	it("lays out a titled card with its description, body and footer", () => {
		render(
			<Card data-testid="card">
				<CardHeader>
					<CardTitle>Downloads</CardTitle>
					<CardDescription>Where finished files go</CardDescription>
				</CardHeader>
				<CardContent>~/Movies</CardContent>
				<CardFooter>
					<button type="button">Change</button>
				</CardFooter>
			</Card>
		);

		expect(screen.getByRole("heading", { level: 3, name: "Downloads" })).toBeInTheDocument();
		expect(screen.getByText("Where finished files go").tagName).toBe("P");
		const card = screen.getByTestId("card");
		expect(card).toHaveClass("rounded-lg", "border", "bg-card");
		expect(card).toHaveTextContent("~/Movies");
		expect(screen.getByRole("button", { name: "Change" }).parentElement).toHaveClass(
			"flex",
			"items-center"
		);
	});

	it("gives each part's ref the element it renders", () => {
		const refs = {
			card: createRef<HTMLDivElement>(),
			header: createRef<HTMLDivElement>(),
			title: createRef<HTMLHeadingElement>(),
			description: createRef<HTMLParagraphElement>(),
			content: createRef<HTMLDivElement>(),
			footer: createRef<HTMLDivElement>(),
		};
		render(
			<Card ref={refs.card}>
				<CardHeader ref={refs.header}>
					<CardTitle ref={refs.title}>Title</CardTitle>
					<CardDescription ref={refs.description}>Description</CardDescription>
				</CardHeader>
				<CardContent ref={refs.content}>Content</CardContent>
				<CardFooter ref={refs.footer}>Footer</CardFooter>
			</Card>
		);

		expect(refs.card.current?.tagName).toBe("DIV");
		expect(refs.header.current?.tagName).toBe("DIV");
		expect(refs.title.current).toBe(screen.getByRole("heading", { name: "Title" }));
		expect(refs.description.current).toBe(screen.getByText("Description"));
		expect(refs.content.current).toBe(screen.getByText("Content"));
		expect(refs.footer.current).toBe(screen.getByText("Footer"));
		expect(refs.card.current).toContainElement(refs.footer.current);
	});

	it("lets a caller's classes replace the matching defaults", () => {
		render(
			<Card data-testid="card" className="shadow-lg">
				<CardHeader data-testid="header" className="p-4">
					<CardTitle className="text-lg">Title</CardTitle>
				</CardHeader>
				<CardContent data-testid="content" className="pt-2" />
			</Card>
		);

		const card = screen.getByTestId("card");
		expect(card).toHaveClass("shadow-lg");
		expect(card).not.toHaveClass("shadow-sm");
		expect(screen.getByTestId("header")).toHaveClass("p-4", "space-y-1.5");
		expect(screen.getByTestId("header")).not.toHaveClass("p-6");
		expect(screen.getByRole("heading")).toHaveClass("text-lg", "font-semibold");
		expect(screen.getByRole("heading")).not.toHaveClass("text-2xl");
		expect(screen.getByTestId("content")).toHaveClass("p-6", "pt-2");
		expect(screen.getByTestId("content")).not.toHaveClass("pt-0");
	});
});
