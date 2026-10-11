// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// The API runs on a host that sleeps when idle, and the first request after a
/// quiet spell can take most of a minute while it wakes up.
const WAKE_UP_TIMEOUT: Duration = Duration::from_secs(90);

/// Enriched metadata from the whatson-api (aggregates ratings from 13+ platforms).
/// All fields optional as the API may omit any of them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WhatsonData {
    // Core
    pub imdb_id: Option<String>,
    pub title: Option<String>,
    pub image: Option<String>,     // TMDB CDN poster URL
    pub item_type: Option<String>, // "movie" or "tvshow"
    pub release_date: Option<String>,
    pub runtime: Option<i64>, // seconds
    pub certification: Option<String>,
    pub tagline: Option<String>,

    // IMDb
    pub imdb_rating: Option<f64>,
    pub imdb_votes: Option<i64>,

    // Rotten Tomatoes critic
    pub rt_critics_rating: Option<i32>,
    pub rt_critics_count: Option<i32>,

    // Rotten Tomatoes audience
    pub rt_audience_rating: Option<i32>,
    pub rt_audience_count: Option<i32>,

    // Metacritic
    pub metacritic_critics: Option<i32>,
    pub metacritic_critics_count: Option<i32>,
    pub metacritic_users: Option<f64>,

    // Letterboxd
    pub letterboxd_rating: Option<f64>,
    pub letterboxd_count: Option<i64>,

    // TMDB
    pub tmdb_rating: Option<f64>,
    pub tmdb_votes: Option<i64>,
}

#[derive(Debug, Error)]
pub enum WhatsonError {
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("Whatson API error: {0}")]
    Api(String),
    #[error("Parse error: {0}")]
    Parse(String),
    #[error("Not found")]
    NotFound,
}

/// Raw platform rating object from the API.
#[derive(Debug, Deserialize)]
struct PlatformRating {
    #[serde(default, deserialize_with = "deserialize_string_or_number")]
    id: Option<String>,
    #[serde(default)]
    users_rating: Option<f64>,
    #[serde(default)]
    users_rating_count: Option<i64>,
    #[serde(default)]
    critics_rating: Option<f64>,
    #[serde(default)]
    critics_rating_count: Option<i64>,
}

/// Deserialize a value that can be a string or a number into Option<String>.
fn deserialize_string_or_number<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde_json::Value;
    let v = Option::<Value>::deserialize(deserializer)?;
    Ok(v.and_then(|v| match v {
        Value::String(s) => Some(s),
        Value::Number(n) => Some(n.to_string()),
        Value::Null => None,
        _ => None,
    }))
}

/// Raw API response item.
#[derive(Debug, Deserialize)]
struct WhatsonItem {
    #[serde(default)]
    item_type: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    image: Option<String>,
    #[serde(default)]
    release_date: Option<String>,
    #[serde(default)]
    runtime: Option<i64>,
    #[serde(default)]
    certification: Option<String>,
    #[serde(default)]
    tagline: Option<String>,

    // Platform objects (each is optional)
    #[serde(default)]
    imdb: Option<PlatformRating>,
    #[serde(default)]
    rotten_tomatoes: Option<PlatformRating>,
    #[serde(default)]
    metacritic: Option<PlatformRating>,
    #[serde(default)]
    letterboxd: Option<PlatformRating>,
    #[serde(default)]
    tmdb: Option<PlatformRating>,
}

/// Paginated response wrapper from the API.
#[derive(Debug, Deserialize)]
struct WhatsonResponse {
    #[serde(default)]
    results: Vec<WhatsonItem>,
}

fn item_to_data(item: WhatsonItem) -> WhatsonData {
    let imdb = item.imdb.as_ref();
    let rt = item.rotten_tomatoes.as_ref();
    let mc = item.metacritic.as_ref();
    let lb = item.letterboxd.as_ref();
    let tmdb = item.tmdb.as_ref();

    WhatsonData {
        imdb_id: imdb.and_then(|p| p.id.clone()),
        title: item.title,
        image: item.image,
        item_type: item.item_type,
        release_date: item.release_date,
        runtime: item.runtime,
        certification: item.certification,
        tagline: item.tagline,

        imdb_rating: imdb.and_then(|p| p.users_rating),
        imdb_votes: imdb.and_then(|p| p.users_rating_count),

        rt_critics_rating: rt.and_then(|p| p.critics_rating).map(|v| v as i32),
        rt_critics_count: rt.and_then(|p| p.critics_rating_count).map(|v| v as i32),
        rt_audience_rating: rt.and_then(|p| p.users_rating).map(|v| v as i32),
        rt_audience_count: rt.and_then(|p| p.users_rating_count).map(|v| v as i32),

        metacritic_critics: mc.and_then(|p| p.critics_rating).map(|v| v as i32),
        metacritic_critics_count: mc.and_then(|p| p.critics_rating_count).map(|v| v as i32),
        metacritic_users: mc.and_then(|p| p.users_rating),

        letterboxd_rating: lb.and_then(|p| p.users_rating),
        letterboxd_count: lb.and_then(|p| p.users_rating_count),

        tmdb_rating: tmdb.and_then(|p| p.users_rating),
        tmdb_votes: tmdb.and_then(|p| p.users_rating_count),
    }
}

/// Parse a whatson-api response into `WhatsonData`.
/// The API returns `{"page": N, "results": [...]}`.
pub fn parse_whatson_response(json: serde_json::Value) -> Result<WhatsonData, WhatsonError> {
    // Primary format: paginated response with "results" array
    if json.is_object() && json.get("results").is_some() {
        let resp: WhatsonResponse =
            serde_json::from_value(json).map_err(|e| WhatsonError::Parse(e.to_string()))?;
        let item = resp
            .results
            .into_iter()
            .next()
            .ok_or(WhatsonError::NotFound)?;
        return Ok(item_to_data(item));
    }

    // Fallback: bare array of items
    if json.is_array() {
        let arr: Vec<WhatsonItem> =
            serde_json::from_value(json).map_err(|e| WhatsonError::Parse(e.to_string()))?;
        let item = arr.into_iter().next().ok_or(WhatsonError::NotFound)?;
        return Ok(item_to_data(item));
    }

    // Fallback: single item object
    let item: WhatsonItem =
        serde_json::from_value(json).map_err(|e| WhatsonError::Parse(e.to_string()))?;
    Ok(item_to_data(item))
}

/// Fetch whatson-api data for the given IMDB ID.
/// `item_type` should be `"movie"` or `"tvshow"`.
pub async fn fetch_whatson(imdb_id: &str, item_type: &str) -> Result<WhatsonData, WhatsonError> {
    let response = crate::http::client()
        .get("https://whatson-api.onrender.com/")
        .query(&[("imdbId", imdb_id), ("item_type", item_type)])
        .timeout(WAKE_UP_TIMEOUT)
        .send()
        .await?;

    if response.status() == 404 {
        return Err(WhatsonError::NotFound);
    }
    if response.status() == 429 {
        return Err(WhatsonError::Api("Rate limited".into()));
    }
    if !response.status().is_success() {
        return Err(WhatsonError::Api(format!("HTTP {}", response.status())));
    }

    let json: serde_json::Value = response.json().await?;
    parse_whatson_response(json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Mimics the real API response: `{"page": 1, "results": [...], ...}`
    fn full_movie_response() -> serde_json::Value {
        json!({
            "page": 1,
            "results": [{
                "id": 278,
                "item_type": "movie",
                "title": "The Shawshank Redemption",
                "image": "https://image.tmdb.org/t/p/w1280/9cqNxx0GxF0bflZmeSMuL5tnGzr.jpg",
                "release_date": "1995-03-01T00:00:00.000Z",
                "runtime": 8520,
                "certification": null,
                "tagline": "Fear can hold you prisoner. Hope can set you free.",
                "imdb": {
                    "id": "tt0111161",
                    "url": "https://www.imdb.com/title/tt0111161/",
                    "users_rating": 9.3,
                    "users_rating_count": 3168950
                },
                "rotten_tomatoes": {
                    "id": "shawshank_redemption",
                    "url": "https://www.rottentomatoes.com/m/shawshank_redemption",
                    "users_rating": 98,
                    "users_rating_count": 181611,
                    "users_rating_liked_count": 178781,
                    "users_rating_not_liked_count": 2830,
                    "users_certified": false,
                    "critics_rating": 89,
                    "critics_rating_count": 146,
                    "critics_rating_liked_count": 131,
                    "critics_rating_not_liked_count": 15,
                    "critics_certified": true
                },
                "metacritic": {
                    "id": "the-shawshank-redemption",
                    "url": "https://www.metacritic.com/movie/the-shawshank-redemption",
                    "critics_rating": 82,
                    "critics_rating_count": 22,
                    "users_rating": 9.3,
                    "users_rating_count": 2151
                },
                "letterboxd": {
                    "id": "the-shawshank-redemption",
                    "url": "https://letterboxd.com/film/the-shawshank-redemption",
                    "users_rating": 4.58,
                    "users_rating_count": 2630036
                },
                "tmdb": {
                    "id": 278,
                    "url": "https://www.themoviedb.org/movie/278",
                    "users_rating": 8.7,
                    "users_rating_count": 29936
                }
            }],
            "total_pages": 1,
            "total_results": 1
        })
    }

    fn tvshow_response() -> serde_json::Value {
        json!({
            "page": 1,
            "results": [{
                "id": 1396,
                "item_type": "tvshow",
                "title": "Breaking Bad",
                "image": "https://image.tmdb.org/t/p/w1280/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg",
                "imdb": {
                    "id": "tt0903747",
                    "users_rating": 9.5,
                    "users_rating_count": 2589290
                },
                "rotten_tomatoes": {
                    "id": "breaking_bad",
                    "users_rating": 97,
                    "users_rating_count": null,
                    "critics_rating": 96,
                    "critics_rating_count": 250
                },
                "metacritic": {
                    "id": "breaking-bad",
                    "critics_rating": 87,
                    "critics_rating_count": 98,
                    "users_rating": 9.4,
                    "users_rating_count": 19006
                },
                "letterboxd": null,
                "tmdb": {
                    "id": 1396,
                    "users_rating": 8.918,
                    "users_rating_count": 14973
                }
            }],
            "total_pages": 1,
            "total_results": 1
        })
    }

    #[test]
    fn test_parse_full_response() {
        let data = parse_whatson_response(full_movie_response()).unwrap();

        assert_eq!(data.imdb_id.as_deref(), Some("tt0111161"));
        assert_eq!(data.title.as_deref(), Some("The Shawshank Redemption"));
        assert!(data.image.is_some());
        assert_eq!(data.item_type.as_deref(), Some("movie"));
        assert_eq!(data.runtime, Some(8520));
        assert_eq!(
            data.tagline.as_deref(),
            Some("Fear can hold you prisoner. Hope can set you free.")
        );

        assert_eq!(data.imdb_rating, Some(9.3));
        assert_eq!(data.imdb_votes, Some(3168950));

        assert_eq!(data.rt_critics_rating, Some(89));
        assert_eq!(data.rt_critics_count, Some(146));
        assert_eq!(data.rt_audience_rating, Some(98));
        assert_eq!(data.rt_audience_count, Some(181611));

        assert_eq!(data.metacritic_critics, Some(82));
        assert_eq!(data.metacritic_critics_count, Some(22));
        assert_eq!(data.metacritic_users, Some(9.3));

        assert_eq!(data.letterboxd_rating, Some(4.58));
        assert_eq!(data.letterboxd_count, Some(2630036));

        assert_eq!(data.tmdb_rating, Some(8.7));
        assert_eq!(data.tmdb_votes, Some(29936));
    }

    #[test]
    fn test_parse_tvshow_response() {
        let data = parse_whatson_response(tvshow_response()).unwrap();

        assert_eq!(data.imdb_id.as_deref(), Some("tt0903747"));
        assert_eq!(data.title.as_deref(), Some("Breaking Bad"));
        assert_eq!(data.item_type.as_deref(), Some("tvshow"));

        assert_eq!(data.imdb_rating, Some(9.5));
        assert_eq!(data.rt_critics_rating, Some(96));
        assert_eq!(data.rt_critics_count, Some(250));
        assert_eq!(data.rt_audience_rating, Some(97));
        // users_rating_count is null in the response
        assert_eq!(data.rt_audience_count, None);

        assert_eq!(data.metacritic_critics, Some(87));
        assert_eq!(data.metacritic_users, Some(9.4));

        // letterboxd is null in the response
        assert!(data.letterboxd_rating.is_none());

        assert_eq!(data.tmdb_rating, Some(8.918));
    }

    #[test]
    fn test_parse_empty_results() {
        let err = parse_whatson_response(json!({"page": 1, "results": [], "total_results": 0}))
            .unwrap_err();
        assert!(matches!(err, WhatsonError::NotFound));
    }

    #[test]
    fn test_parse_empty_object_fallback() {
        let data = parse_whatson_response(json!({})).unwrap();
        assert!(data.imdb_id.is_none());
        assert!(data.imdb_rating.is_none());
        assert!(data.rt_critics_rating.is_none());
    }

    #[test]
    fn test_parse_bare_array_fallback() {
        let data = parse_whatson_response(json!([{
            "title": "Test Movie",
            "imdb": {
                "id": "tt1234567",
                "users_rating": 7.5
            }
        }]))
        .unwrap();

        assert_eq!(data.imdb_id.as_deref(), Some("tt1234567"));
        assert_eq!(data.imdb_rating, Some(7.5));
        assert!(data.imdb_votes.is_none());
        assert!(data.rt_critics_rating.is_none());
    }

    #[test]
    fn test_parse_empty_array() {
        let err = parse_whatson_response(json!([])).unwrap_err();
        assert!(matches!(err, WhatsonError::NotFound));
    }

    #[test]
    fn test_whatson_data_serializes_camel_case() {
        let data = WhatsonData {
            imdb_id: Some("tt0111161".into()),
            rt_critics_rating: Some(89),
            rt_audience_rating: Some(98),
            ..Default::default()
        };
        let json_str = serde_json::to_string(&data).unwrap();
        assert!(json_str.contains("\"imdbId\""));
        assert!(json_str.contains("\"rtCriticsRating\""));
        assert!(json_str.contains("\"rtAudienceRating\""));
    }
}
