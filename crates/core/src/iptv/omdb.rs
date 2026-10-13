// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Movie and series details from OMDb, looked up by title.

use serde::{Deserialize, Serialize};
use thiserror::Error;

const OMDB_URL: &str = "https://www.omdbapi.com/";

/// Movie or series details from OMDb. Ratings stay as the text OMDb sends,
/// because the UI shows them as they are.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OmdbData {
    pub title: String,
    pub year: Option<String>,
    pub rated: Option<String>,
    pub runtime: Option<String>,
    pub genre: Option<String>,
    pub director: Option<String>,
    pub actors: Option<String>,
    pub plot: Option<String>,
    pub poster_url: Option<String>,
    pub imdb_rating: Option<String>,
    pub rotten_tomatoes: Option<String>,
    pub imdb_id: Option<String>,
    pub imdb_votes: Option<String>,
}

/// Errors from an OMDb lookup.
#[derive(Debug, Error)]
pub enum OmdbError {
    /// The request failed or the server answered with an error status.
    #[error("HTTP request failed: {0}")]
    Http(#[source] reqwest::Error),
    /// OMDb answered but reported an error, such as a title it doesn't know.
    #[error("OMDB API error: {0}")]
    Api(String),
    /// The response was not in the expected shape.
    #[error("Parse error: {0}")]
    Parse(String),
}

// Request URLs can carry API keys and logins, so they are dropped before the
// error can reach a log or the UI.
impl From<reqwest::Error> for OmdbError {
    fn from(e: reqwest::Error) -> Self {
        Self::Http(e.without_url())
    }
}

/// Raw OMDB API response shape (for deserialization only).
#[derive(Debug, Deserialize)]
struct OmdbApiResponse {
    #[serde(rename = "Response")]
    response: String,
    #[serde(rename = "Error")]
    error: Option<String>,
    #[serde(rename = "Title")]
    title: Option<String>,
    #[serde(rename = "Year")]
    year: Option<String>,
    #[serde(rename = "Rated")]
    rated: Option<String>,
    #[serde(rename = "Runtime")]
    runtime: Option<String>,
    #[serde(rename = "Genre")]
    genre: Option<String>,
    #[serde(rename = "Director")]
    director: Option<String>,
    #[serde(rename = "Actors")]
    actors: Option<String>,
    #[serde(rename = "Plot")]
    plot: Option<String>,
    #[serde(rename = "Poster")]
    poster: Option<String>,
    #[serde(rename = "imdbRating")]
    imdb_rating: Option<String>,
    #[serde(rename = "Ratings")]
    ratings: Option<Vec<OmdbRating>>,
    #[serde(rename = "imdbID")]
    imdb_id: Option<String>,
    #[serde(rename = "imdbVotes")]
    imdb_votes: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OmdbRating {
    #[serde(rename = "Source")]
    source: String,
    #[serde(rename = "Value")]
    value: String,
}

/// Convert an OMDB "N/A" string to None.
fn na_to_none(s: Option<String>) -> Option<String> {
    s.filter(|v| v != "N/A" && !v.is_empty())
}

/// Extract the Rotten Tomatoes rating from the Ratings array.
fn extract_rotten_tomatoes(ratings: Option<Vec<OmdbRating>>) -> Option<String> {
    ratings?
        .into_iter()
        .find(|r| r.source == "Rotten Tomatoes")
        .map(|r| r.value)
}

/// Strip a trailing ` (YYYY)` year suffix from a title if present.
/// Matches the common IPTV pattern where titles are stored as `"Title (Year)"`.
/// Returns the bare title without the year; `None` if the pattern does not match.
///
/// # Examples
///
/// - `"Inception (2010)"` → `Some("Inception")`
/// - `"Breaking Bad (2008)"` → `Some("Breaking Bad")`
/// - `"Plain Title"` → `None`
fn strip_trailing_year(title: &str) -> Option<&str> {
    let trimmed = title.trim_end();
    if trimmed.len() >= 7 {
        let rest = trimmed.len() - 7; // " (XXXX)".len() == 7
        let suffix = &trimmed[rest..];
        if suffix.starts_with(" (") && suffix.ends_with(')') {
            let year_part = &suffix[2..6];
            if year_part.chars().all(|c| c.is_ascii_digit()) {
                return Some(trimmed[..rest].trim_end());
            }
        }
    }
    None
}

/// Parse an OMDB API JSON response (as serde_json::Value) into OmdbData.
/// Separated from the HTTP call so it can be unit-tested without network access.
pub fn parse_omdb_response(json: serde_json::Value) -> Result<OmdbData, OmdbError> {
    let resp: OmdbApiResponse =
        serde_json::from_value(json).map_err(|e| OmdbError::Parse(e.to_string()))?;

    if resp.response != "True" {
        return Err(OmdbError::Api(
            resp.error.unwrap_or_else(|| "Unknown OMDB error".into()),
        ));
    }

    let title = resp
        .title
        .ok_or_else(|| OmdbError::Parse("Missing title".into()))?;

    Ok(OmdbData {
        title,
        year: na_to_none(resp.year),
        rated: na_to_none(resp.rated),
        runtime: na_to_none(resp.runtime),
        genre: na_to_none(resp.genre),
        director: na_to_none(resp.director),
        actors: na_to_none(resp.actors),
        plot: na_to_none(resp.plot),
        poster_url: na_to_none(resp.poster),
        imdb_rating: na_to_none(resp.imdb_rating),
        rotten_tomatoes: extract_rotten_tomatoes(resp.ratings),
        imdb_id: na_to_none(resp.imdb_id),
        imdb_votes: na_to_none(resp.imdb_votes),
    })
}

/// Perform an OMDB API lookup for the given title.
async fn do_fetch(
    client: &reqwest::Client,
    url: &str,
    title: &str,
    content_type: &str,
    api_key: &str,
) -> Result<OmdbData, OmdbError> {
    let response = lookup_request(client, url, title, content_type, api_key)
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;
    parse_omdb_response(response)
}

// Keys are pasted in, often with a trailing newline, which OMDb would reject.
fn lookup_request(
    client: &reqwest::Client,
    url: &str,
    title: &str,
    content_type: &str,
    api_key: &str,
) -> reqwest::RequestBuilder {
    client.get(url).query(&[
        ("t", title),
        ("type", content_type),
        ("plot", "full"),
        ("apikey", api_key.trim()),
    ])
}

/// Fetch OMDB data for a title. `content_type` should be `"movie"` or `"series"`.
///
/// If the title matches the pattern `Title (Year)` (e.g. `"Inception (2010)"`), the year
/// suffix is stripped and OMDB is queried with the bare title first. If that lookup fails,
/// the full title is tried as a fallback.
pub async fn fetch_omdb(
    title: &str,
    content_type: &str,
    api_key: &str,
) -> Result<OmdbData, OmdbError> {
    fetch_from(
        crate::http::client(),
        OMDB_URL,
        title,
        content_type,
        api_key,
    )
    .await
}

/// The work of [`fetch_omdb`], taking the client and address so tests can
/// point it at a local server.
async fn fetch_from(
    client: &reqwest::Client,
    url: &str,
    title: &str,
    content_type: &str,
    api_key: &str,
) -> Result<OmdbData, OmdbError> {
    if let Some(stripped) = strip_trailing_year(title) {
        match do_fetch(client, url, stripped, content_type, api_key).await {
            Ok(data) => return Ok(data),
            Err(OmdbError::Api(_)) => { /* fall through to full title */ }
            Err(e) => return Err(e),
        }
    }

    do_fetch(client, url, title, content_type, api_key).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::test_server;
    use serde_json::json;

    #[test]
    fn spaces_around_the_key_are_ignored() {
        let request = lookup_request(
            crate::http::client(),
            OMDB_URL,
            "Inception",
            "movie",
            " KEY\n",
        )
        .build()
        .unwrap();
        let key = request.url().query_pairs().find(|(k, _)| k == "apikey");
        assert_eq!(key.unwrap().1, "KEY");
    }

    fn full_response() -> serde_json::Value {
        json!({
            "Response": "True",
            "Title": "The Dark Knight",
            "Year": "2008",
            "Rated": "PG-13",
            "Runtime": "152 min",
            "Genre": "Action, Crime, Drama",
            "Director": "Christopher Nolan",
            "Actors": "Christian Bale, Heath Ledger",
            "Plot": "Batman raises the stakes in his war on crime.",
            "Poster": "https://example.com/poster.jpg",
            "imdbRating": "9.0",
            "imdbID": "tt0468569",
            "imdbVotes": "2,844,668",
            "Ratings": [
                { "Source": "Internet Movie Database", "Value": "9.0/10" },
                { "Source": "Rotten Tomatoes", "Value": "94%" },
                { "Source": "Metacritic", "Value": "84/100" }
            ]
        })
    }

    #[test]
    fn test_strip_trailing_year() {
        assert_eq!(strip_trailing_year("Inception (2010)"), Some("Inception"));
        assert_eq!(
            strip_trailing_year("Breaking Bad (2008)"),
            Some("Breaking Bad")
        );
        assert_eq!(
            strip_trailing_year("The Dark Knight (2008)"),
            Some("The Dark Knight")
        );
        assert_eq!(strip_trailing_year("Plain Title"), None);
        assert_eq!(strip_trailing_year("Avatar"), None);
        assert_eq!(strip_trailing_year("Movie (I)"), None); // roman numeral, not year
    }

    #[test]
    fn four_letters_in_brackets_are_not_a_year() {
        assert_eq!(strip_trailing_year("Shogun (Live)"), None);
    }

    #[test]
    fn a_year_needs_a_bracket_on_each_side() {
        assert_eq!(strip_trailing_year("Example Film [2010)"), None);
        assert_eq!(strip_trailing_year("Example Film (2010]"), None);
    }

    #[test]
    fn test_parse_full_response() {
        let data = parse_omdb_response(full_response()).unwrap();
        assert_eq!(data.title, "The Dark Knight");
        assert_eq!(data.year.as_deref(), Some("2008"));
        assert_eq!(data.rated.as_deref(), Some("PG-13"));
        assert_eq!(data.runtime.as_deref(), Some("152 min"));
        assert_eq!(data.genre.as_deref(), Some("Action, Crime, Drama"));
        assert_eq!(data.director.as_deref(), Some("Christopher Nolan"));
        assert_eq!(data.actors.as_deref(), Some("Christian Bale, Heath Ledger"));
        assert!(data.plot.is_some());
        assert_eq!(
            data.poster_url.as_deref(),
            Some("https://example.com/poster.jpg")
        );
        assert_eq!(data.imdb_rating.as_deref(), Some("9.0"));
        assert_eq!(data.rotten_tomatoes.as_deref(), Some("94%"));
        assert_eq!(data.imdb_id.as_deref(), Some("tt0468569"));
        assert_eq!(data.imdb_votes.as_deref(), Some("2,844,668"));
    }

    #[test]
    fn test_na_values_become_none() {
        let response = json!({
            "Response": "True",
            "Title": "Some Movie",
            "Year": "N/A",
            "Rated": "N/A",
            "Runtime": "N/A",
            "Genre": "N/A",
            "Director": "N/A",
            "Actors": "N/A",
            "Plot": "N/A",
            "Poster": "N/A",
            "imdbRating": "N/A",
            "imdbID": "N/A",
            "imdbVotes": "N/A",
            "Ratings": []
        });
        let data = parse_omdb_response(response).unwrap();
        assert_eq!(data.title, "Some Movie");
        assert!(data.year.is_none());
        assert!(data.rated.is_none());
        assert!(data.runtime.is_none());
        assert!(data.genre.is_none());
        assert!(data.director.is_none());
        assert!(data.actors.is_none());
        assert!(data.plot.is_none());
        assert!(data.poster_url.is_none());
        assert!(data.imdb_rating.is_none());
        assert!(data.rotten_tomatoes.is_none());
        assert!(data.imdb_id.is_none());
        assert!(data.imdb_votes.is_none());
    }

    #[test]
    fn test_api_error_response() {
        let response = json!({
            "Response": "False",
            "Error": "Movie not found!"
        });
        let err = parse_omdb_response(response).unwrap_err();
        assert!(matches!(err, OmdbError::Api(_)));
        assert!(err.to_string().contains("Movie not found!"));
    }

    #[test]
    fn test_api_error_without_message() {
        let response = json!({
            "Response": "False"
        });
        let err = parse_omdb_response(response).unwrap_err();
        assert!(matches!(err, OmdbError::Api(_)));
    }

    #[test]
    fn test_no_rotten_tomatoes_in_ratings() {
        let response = json!({
            "Response": "True",
            "Title": "Some Movie",
            "Ratings": [
                { "Source": "Internet Movie Database", "Value": "7.5/10" }
            ]
        });
        let data = parse_omdb_response(response).unwrap();
        assert!(data.rotten_tomatoes.is_none());
    }

    #[test]
    fn test_missing_ratings_field() {
        let response = json!({
            "Response": "True",
            "Title": "Some Movie"
        });
        let data = parse_omdb_response(response).unwrap();
        assert!(data.rotten_tomatoes.is_none());
    }

    #[test]
    fn test_rotten_tomatoes_extracted_when_present() {
        let response = json!({
            "Response": "True",
            "Title": "Great Film",
            "Ratings": [
                { "Source": "Metacritic", "Value": "75/100" },
                { "Source": "Rotten Tomatoes", "Value": "88%" }
            ]
        });
        let data = parse_omdb_response(response).unwrap();
        assert_eq!(data.rotten_tomatoes.as_deref(), Some("88%"));
    }

    #[test]
    fn test_omdb_data_serializes_to_camel_case() {
        let data = OmdbData {
            title: "Test".into(),
            year: Some("2020".into()),
            rated: None,
            runtime: None,
            genre: None,
            director: None,
            actors: None,
            plot: None,
            poster_url: Some("https://example.com/p.jpg".into()),
            imdb_rating: Some("8.5".into()),
            rotten_tomatoes: None,
            imdb_id: None,
            imdb_votes: None,
        };
        let json_str = serde_json::to_string(&data).unwrap();
        assert!(json_str.contains("\"posterUrl\""));
        assert!(json_str.contains("\"imdbRating\""));
        assert!(json_str.contains("\"rottenTomatoes\""));
        assert!(json_str.contains("\"imdbId\""));
        assert!(json_str.contains("\"imdbVotes\""));
    }

    #[test]
    fn test_imdb_id_and_votes_parsed() {
        let response = json!({
            "Response": "True",
            "Title": "Inception",
            "imdbID": "tt1375666",
            "imdbVotes": "2,500,000"
        });
        let data = parse_omdb_response(response).unwrap();
        assert_eq!(data.imdb_id.as_deref(), Some("tt1375666"));
        assert_eq!(data.imdb_votes.as_deref(), Some("2,500,000"));
    }

    #[test]
    fn test_missing_imdb_id_and_votes_are_none() {
        let response = json!({
            "Response": "True",
            "Title": "No IDs Movie"
        });
        let data = parse_omdb_response(response).unwrap();
        assert!(data.imdb_id.is_none());
        assert!(data.imdb_votes.is_none());
    }

    // --- Lookups against a local server ---

    /// What OMDb sends for a title it doesn't know.
    const NOT_FOUND: &str = r#"{"Response":"False","Error":"Movie not found!"}"#;

    /// Looks `title` up on a local server that gives `replies` in turn, and
    /// returns the result with the request line of each lookup sent.
    async fn look_up(
        title: &str,
        replies: &[(&str, &str)],
    ) -> (Result<OmdbData, OmdbError>, Vec<String>) {
        let (server, requests) = test_server::serve_in_order(replies);
        let client = test_server::client();
        let result = fetch_from(&client, &format!("{server}/"), title, "movie", "KEY").await;
        let lines = requests
            .try_iter()
            .map(|request| request.lines().next().unwrap_or_default().to_string())
            .collect();
        (result, lines)
    }

    #[tokio::test]
    async fn a_title_with_a_year_is_looked_up_without_it_first() {
        let (result, lines) = look_up(
            "The Dark Knight (2008)",
            &[("200 OK", &full_response().to_string())],
        )
        .await;
        assert_eq!(
            result.unwrap(),
            parse_omdb_response(full_response()).unwrap()
        );
        assert_eq!(
            lines,
            ["GET /?t=The+Dark+Knight&type=movie&plot=full&apikey=KEY HTTP/1.1"]
        );
    }

    #[tokio::test]
    async fn the_full_title_is_tried_when_omdb_does_not_know_the_bare_one() {
        let (result, lines) = look_up(
            "Heat (1995)",
            &[
                ("200 OK", NOT_FOUND),
                ("200 OK", &full_response().to_string()),
            ],
        )
        .await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with("GET /?t=Heat&"), "{}", lines[0]);
        assert!(
            lines[1].starts_with("GET /?t=Heat+%281995%29&"),
            "{}",
            lines[1]
        );
    }

    #[tokio::test]
    async fn a_title_unknown_with_and_without_its_year_is_an_api_error() {
        let (result, lines) = look_up(
            "Heat (1995)",
            &[("200 OK", NOT_FOUND), ("200 OK", NOT_FOUND)],
        )
        .await;
        assert!(
            matches!(&result, Err(OmdbError::Api(message)) if message == "Movie not found!"),
            "{result:?}"
        );
        assert_eq!(lines.len(), 2);
    }

    #[tokio::test]
    async fn a_failed_lookup_is_not_retried_with_the_full_title() {
        let (result, lines) = look_up(
            "Heat (1995)",
            &[
                ("503 Service Unavailable", "<html>down</html>"),
                ("200 OK", &full_response().to_string()),
            ],
        )
        .await;
        assert!(matches!(result, Err(OmdbError::Http(_))), "{result:?}");
        assert_eq!(lines.len(), 1);
    }

    #[tokio::test]
    async fn a_request_that_cannot_connect_does_not_show_the_key() {
        let url = format!("{}/", test_server::refused_url());
        let err = fetch_from(
            &test_server::client(),
            &url,
            "Heat (1995)",
            "movie",
            "SECRET",
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, OmdbError::Http(e) if e.is_connect()),
            "{err:?}"
        );
        test_server::assert_hides(&err, "SECRET");
    }
}
