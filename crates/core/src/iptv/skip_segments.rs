// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Times to skip the intro, recap, credits and next-episode preview of a movie
//! or episode.
//!
//! The times come from two free databases that people fill in by hand, both
//! looked up by IMDb ID. SkipDB (skipdb.tv, ODbL 1.0) is asked first because
//! it checks its times against the length of the video being played. IntroDB
//! (introdb.app) fills in the kinds SkipDB doesn't have, but it can't be
//! checked that way. `check_segments` then drops any times that can't be right
//! for the video, and decides which ones are sure enough to skip by themselves.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use thiserror::Error;

const SKIPDB_URL: &str = "https://api.skipdb.tv/api/segments";
const INTRODB_URL: &str = "https://api.introdb.app/segments";

/// Both databases answer in well under a second, so a slow one is down.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// A segment this close to the end has nothing left to skip to.
const END_MARGIN: f64 = 1.0;

/// Anything shorter isn't worth a button, and is likely a stray submission.
const MIN_LENGTH: f64 = 3.0;

/// SkipDB's times for a video whose length is further off than this are taken
/// to be for another cut, such as an extended edition, and are dropped.
const MAX_MISMATCH: f64 = 120.0;

/// SkipDB gives 0.9 to times for a video within 2 seconds of their length, and
/// 0.82 to one within 15 seconds. Anything less only gets a button.
const AUTO_CONFIDENCE: f64 = 0.8;

/// What part of the video a segment covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SegmentKind {
    /// The title sequence.
    Intro,
    /// The "previously on" part at the start of an episode.
    Recap,
    /// The end credits. Both databases call them the outro.
    Credits,
    /// A look at the next episode, during or after the credits.
    Preview,
}

/// Where a segment's times came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SegmentSource {
    SkipDb,
    IntroDb,
}

/// How well a segment's times are known to fit the video being played.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    /// The video is within 2 seconds of the length the times were taken from.
    Exact,
    /// The video is within 15 seconds of that length. SkipDB has moved the
    /// times earlier when the video is shorter, so a button is never late.
    Shifted,
    /// The source doesn't say what length its times are for.
    Unchecked,
    /// The video's length is further off, so the times may be too.
    Mismatch,
}

/// A part of the video the player can offer to skip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipSegment {
    pub kind: SegmentKind,
    /// Where the segment starts, in seconds.
    pub start: f64,
    /// Where it ends, in seconds. Skipping jumps here.
    pub end: f64,
    pub source: SegmentSource,
    pub fit: Fit,
    /// How sure the source is of the times, from 0 to 1.
    pub confidence: Option<f64>,
    /// The video's length minus the length the times were taken from, in
    /// seconds. Only SkipDB reports it.
    pub offset: Option<f64>,
    /// Where the player may skip from without asking, or `None` when the times
    /// are only good enough for a button. `check_segments` sets it.
    #[serde(default)]
    pub auto_from: Option<f64>,
}

/// The video to look up.
#[derive(Debug, Clone, PartialEq)]
pub struct SkipQuery {
    /// The IMDb ID of the movie, or of the series for an episode.
    pub imdb_id: String,
    /// The season and episode number, or `None` for a movie.
    pub episode: Option<(u32, u32)>,
    /// The length of the video being played, in seconds.
    pub duration: f64,
}

impl SkipQuery {
    /// The cache key for this video. SkipDB's times depend on the length, so
    /// the key has it in whole seconds, the same as SkipDB is sent.
    pub fn cache_key(&self) -> String {
        let seconds = self.seconds();
        match self.episode {
            Some((season, episode)) => format!("{}:{season}:{episode}:{seconds}", self.imdb_id),
            None => format!("{}:movie:{seconds}", self.imdb_id),
        }
    }

    fn seconds(&self) -> u64 {
        self.duration.round() as u64
    }

    fn check(&self) -> Result<(), SkipError> {
        if !is_imdb_id(&self.imdb_id) {
            return Err(SkipError::BadQuery(format!(
                "not an IMDb ID: {}",
                self.imdb_id
            )));
        }
        if matches!(self.episode, Some((0, _)) | Some((_, 0))) {
            return Err(SkipError::BadQuery(
                "seasons and episodes start at 1".into(),
            ));
        }
        if !(self.duration.is_finite() && self.duration >= 1.0) {
            return Err(SkipError::BadQuery(format!(
                "bad length: {}",
                self.duration
            )));
        }
        Ok(())
    }

    fn skipdb_params(&self) -> Vec<(&'static str, String)> {
        let mut params = vec![("imdb_id", self.imdb_id.clone())];
        if let Some((season, episode)) = self.episode {
            params.push(("season", season.to_string()));
            params.push(("episode", episode.to_string()));
        }
        params.push(("duration", self.seconds().to_string()));
        params
    }

    fn introdb_params(&self) -> Vec<(&'static str, String)> {
        let mut params = vec![("imdb_id", self.imdb_id.clone())];
        match self.episode {
            Some((season, episode)) => {
                params.push(("season", season.to_string()));
                params.push(("episode", episode.to_string()));
            }
            None => params.push(("is_movie", "true".into())),
        }
        params
    }
}

/// `tt` and seven or eight digits, the form both databases take.
fn is_imdb_id(id: &str) -> bool {
    id.strip_prefix("tt").is_some_and(|digits| {
        matches!(digits.len(), 7 | 8) && digits.bytes().all(|b| b.is_ascii_digit())
    })
}

#[derive(Debug, Error)]
pub enum SkipError {
    #[error("{0}")]
    BadQuery(String),
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("{0} returned HTTP {1}")]
    Status(&'static str, u16),
}

/// What the two databases had for a video.
#[derive(Debug, Clone, PartialEq)]
pub struct Fetched {
    /// Both sources' segments put together, not yet checked against the video.
    pub segments: Vec<SkipSegment>,
    /// Whether both sources answered. Times missing a source shouldn't be
    /// cached, so the next lookup can try it again.
    pub complete: bool,
}

/// One segment as both databases send it. A missing segment is `null`, and
/// SkipDB sends 0 to 0 for one it knows the video doesn't have.
#[derive(Debug, Deserialize)]
struct RawSegment {
    start_ms: f64,
    end_ms: f64,
    #[serde(default)]
    confidence: Option<f64>,
    /// SkipDB only.
    #[serde(default)]
    offset_ms: Option<f64>,
    /// SkipDB only: exact, shifted, agnostic or out-of-range.
    #[serde(default, rename = "match")]
    fit: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct SkipDbResponse {
    #[serde(default)]
    segments: SkipDbSegments,
}

#[derive(Debug, Default, Deserialize)]
struct SkipDbSegments {
    intro: Option<RawSegment>,
    recap: Option<RawSegment>,
    outro: Option<RawSegment>,
    preview: Option<RawSegment>,
}

#[derive(Debug, Default, Deserialize)]
struct IntroDbResponse {
    intro: Option<RawSegment>,
    recap: Option<RawSegment>,
    outro: Option<RawSegment>,
    /// A scene after the credits, which skipping the credits mustn't jump past.
    post_credits: Option<RawSegment>,
}

impl RawSegment {
    fn into_segment(self, kind: SegmentKind, source: SegmentSource) -> SkipSegment {
        let fit = match self.fit.as_deref() {
            Some("exact") => Fit::Exact,
            Some("shifted") => Fit::Shifted,
            Some("out-of-range") => Fit::Mismatch,
            _ => Fit::Unchecked,
        };
        SkipSegment {
            kind,
            start: self.start_ms / 1000.0,
            end: self.end_ms / 1000.0,
            source,
            fit,
            confidence: self.confidence,
            offset: self.offset_ms.map(|ms| ms / 1000.0),
            auto_from: None,
        }
    }
}

fn to_segments(
    source: SegmentSource,
    raw: [(SegmentKind, Option<RawSegment>); 4],
) -> Vec<SkipSegment> {
    raw.into_iter()
        .filter_map(|(kind, segment)| segment.map(|s| s.into_segment(kind, source)))
        .collect()
}

fn from_skipdb(response: SkipDbResponse) -> Vec<SkipSegment> {
    let s = response.segments;
    to_segments(
        SegmentSource::SkipDb,
        [
            (SegmentKind::Intro, s.intro),
            (SegmentKind::Recap, s.recap),
            (SegmentKind::Credits, s.outro),
            (SegmentKind::Preview, s.preview),
        ],
    )
}

/// IntroDB's segments, and where its post-credits scene starts if it has one.
fn from_introdb(response: IntroDbResponse) -> (Vec<SkipSegment>, Option<f64>) {
    let post_credits = response.post_credits.map(|s| s.start_ms / 1000.0);
    let segments = to_segments(
        SegmentSource::IntroDb,
        [
            (SegmentKind::Intro, response.intro),
            (SegmentKind::Recap, response.recap),
            (SegmentKind::Credits, response.outro),
            (SegmentKind::Preview, None),
        ],
    );
    (segments, post_credits)
}

/// Puts the two sources together, one segment of each kind. SkipDB's wins,
/// even one that says the video has none, since only its times are checked
/// against the video. Credits that run into a post-credits scene end where
/// the scene starts, so skipping them doesn't jump past it.
fn merge(
    skipdb: Vec<SkipSegment>,
    introdb: Vec<SkipSegment>,
    post_credits: Option<f64>,
) -> Vec<SkipSegment> {
    let mut segments = skipdb;
    for segment in introdb {
        if !segments.iter().any(|s| s.kind == segment.kind) {
            segments.push(segment);
        }
    }
    if let Some(scene) = post_credits {
        for credits in segments
            .iter_mut()
            .filter(|s| s.kind == SegmentKind::Credits)
        {
            if credits.start < scene && scene < credits.end {
                credits.end = scene;
            }
        }
    }
    segments
}

/// Puts the two answers together. When one source fails, the other's times
/// still come back, marked incomplete. Fails only when both do.
fn combine(
    skipdb: Result<Option<SkipDbResponse>, SkipError>,
    introdb: Result<Option<IntroDbResponse>, SkipError>,
) -> Result<Fetched, SkipError> {
    let complete = skipdb.is_ok() && introdb.is_ok();
    let (skipdb, introdb) = match (skipdb, introdb) {
        (Err(e), Err(other)) => {
            tracing::warn!("[skip] IntroDB failed too: {other}");
            return Err(e);
        }
        (skipdb, introdb) => (ok_or_warn("SkipDB", skipdb), ok_or_warn("IntroDB", introdb)),
    };
    let (introdb, post_credits) = from_introdb(introdb.unwrap_or_default());
    Ok(Fetched {
        segments: merge(
            from_skipdb(skipdb.unwrap_or_default()),
            introdb,
            post_credits,
        ),
        complete,
    })
}

fn ok_or_warn<T>(name: &str, result: Result<Option<T>, SkipError>) -> Option<T> {
    result.unwrap_or_else(|e| {
        tracing::warn!("[skip] {name} failed: {e}");
        None
    })
}

/// Where a segment of each kind can be. Times outside these are for another
/// cut of the video, or wrong.
struct Bounds {
    /// The earliest start, as a share of the video's length.
    from: f64,
    /// The latest start, as a share of the video's length.
    to: f64,
    /// The longest it can last, in seconds.
    max_length: f64,
}

impl SegmentKind {
    fn bounds(self) -> Bounds {
        match self {
            SegmentKind::Intro | SegmentKind::Recap => Bounds {
                from: 0.0,
                to: 0.4,
                max_length: 300.0,
            },
            SegmentKind::Credits => Bounds {
                from: 0.5,
                to: 1.0,
                max_length: 1200.0,
            },
            SegmentKind::Preview => Bounds {
                from: 0.5,
                to: 1.0,
                max_length: 300.0,
            },
        }
    }
}

/// Keeps the segments that can be right for a video `duration` seconds long,
/// with each one's end cut to the video's end, and sets which ones the player
/// may skip without asking.
///
/// Times are dropped when they're out of order, too short to matter, in the
/// wrong part of the video for their kind, too long for it, or from SkipDB for
/// a video more than two minutes longer or shorter.
pub fn check_segments(segments: &[SkipSegment], duration: f64) -> Vec<SkipSegment> {
    if !(duration.is_finite() && duration > 0.0) {
        return Vec::new();
    }
    segments
        .iter()
        .filter_map(|s| check_segment(s, duration))
        .collect()
}

fn check_segment(segment: &SkipSegment, duration: f64) -> Option<SkipSegment> {
    let mut s = segment.clone();
    if !(s.start.is_finite() && s.end.is_finite()) || s.start < 0.0 || s.start >= s.end {
        return None;
    }
    s.end = s.end.min(duration);
    let length = s.end - s.start;
    if s.start >= duration - END_MARGIN || length < MIN_LENGTH {
        return None;
    }
    let bounds = s.kind.bounds();
    let share = s.start / duration;
    if share < bounds.from || share > bounds.to || length > bounds.max_length {
        return None;
    }
    if s.fit == Fit::Mismatch && s.offset.is_some_and(|o| o.abs() > MAX_MISMATCH) {
        return None;
    }
    s.auto_from = auto_from(&s);
    Some(s)
}

/// Where a segment is safe to skip from without asking.
///
/// Only times checked against the video's length qualify. Even then, the
/// video's extra or missing seconds can sit before the segment or after it,
/// which moves the segment by up to `offset` or not at all. Waiting `offset`
/// seconds past the start skips only what's inside the segment either way, so
/// a skip never cuts into the show.
fn auto_from(s: &SkipSegment) -> Option<f64> {
    let checked = matches!(s.fit, Fit::Exact | Fit::Shifted);
    if !checked || !s.confidence.is_some_and(|c| c >= AUTO_CONFIDENCE) {
        return None;
    }
    let from = s.start + s.offset.unwrap_or(0.0).abs();
    (s.end - from >= MIN_LENGTH).then_some(from)
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(concat!("MaxVideoPlayer/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_default()
}

/// Gets JSON from `url`, or `None` when the server has nothing for it.
async fn get_json<T: DeserializeOwned>(
    client: &reqwest::Client,
    name: &'static str,
    url: &str,
    params: &[(&str, String)],
) -> Result<Option<T>, SkipError> {
    let response = client.get(url).query(params).send().await?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(SkipError::Status(name, status.as_u16()));
    }
    Ok(Some(response.json().await?))
}

/// Looks the video up in both databases at once. The segments that come back
/// still need `check_segments`.
pub async fn fetch_skip_segments(query: &SkipQuery) -> Result<Fetched, SkipError> {
    query.check()?;
    let client = client();
    let (skipdb_params, introdb_params) = (query.skipdb_params(), query.introdb_params());
    let (skipdb, introdb) = tokio::join!(
        get_json(&client, "SkipDB", SKIPDB_URL, &skipdb_params),
        get_json(&client, "IntroDB", INTRODB_URL, &introdb_params),
    );
    combine(skipdb, introdb)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn segment(kind: SegmentKind, start: f64, end: f64) -> SkipSegment {
        SkipSegment {
            kind,
            start,
            end,
            source: SegmentSource::SkipDb,
            fit: Fit::Exact,
            confidence: Some(0.9),
            offset: Some(0.0),
            auto_from: None,
        }
    }

    fn episode(duration: f64) -> SkipQuery {
        SkipQuery {
            imdb_id: "tt0903747".into(),
            episode: Some((1, 2)),
            duration,
        }
    }

    /// SkipDB's answer for a Breaking Bad episode played at 3,490 seconds,
    /// ten seconds shorter than SkipDB's copy.
    fn skipdb_shifted() -> SkipDbResponse {
        serde_json::from_value(json!({
            "imdb_id": "tt0903747", "season": 1, "episode": 1,
            "segments": {
                "intro": {"start_ms": 219500, "end_ms": 236500, "adjusted": true,
                          "offset_ms": -10000, "match": "shifted", "confidence": 0.82},
                "recap": null,
                "outro": {"start_ms": 3424000, "end_ms": 3490000, "adjusted": true,
                          "offset_ms": -10000, "match": "shifted", "confidence": 0.82},
                "preview": {"start_ms": 0, "end_ms": 0, "adjusted": false,
                            "offset_ms": -10000, "match": "shifted", "confidence": 0.82}
            },
            "intro_length_estimate_ms": 17000
        }))
        .unwrap()
    }

    fn introdb_episode() -> IntroDbResponse {
        serde_json::from_value(json!({
            "imdb_id": "tt0903747", "media_type": "tv", "is_movie": false,
            "season": 1, "episode": 1,
            "intro": {"start_sec": 229, "end_sec": 246, "start_ms": 229000, "end_ms": 246000,
                      "confidence": 1, "submission_count": 3, "updated_at": "2026-04-14T12:21:01.935Z"},
            "recap": {"start_sec": 0, "end_sec": 40, "start_ms": 0, "end_ms": 40000,
                      "confidence": 0.7, "submission_count": 1, "updated_at": "2026-04-14T12:21:01.935Z"},
            "outro": {"start_sec": 3431, "end_sec": 3500, "start_ms": 3431000, "end_ms": 3500000,
                      "confidence": 1, "submission_count": 1, "updated_at": "2026-04-14T12:21:01.935Z"},
            "post_credits": null
        }))
        .unwrap()
    }

    #[test]
    fn reads_skipdb_times_and_fit() {
        let segments = from_skipdb(skipdb_shifted());
        assert_eq!(segments.len(), 3);
        let intro = &segments[0];
        assert_eq!(intro.kind, SegmentKind::Intro);
        assert_eq!((intro.start, intro.end), (219.5, 236.5));
        assert_eq!(intro.fit, Fit::Shifted);
        assert_eq!(intro.offset, Some(-10.0));
        assert_eq!(intro.confidence, Some(0.82));
        assert_eq!(segments[1].kind, SegmentKind::Credits);
        assert_eq!(segments[2].kind, SegmentKind::Preview);
    }

    #[test]
    fn maps_each_skipdb_match() {
        let fit = |name: Option<&str>| {
            RawSegment {
                start_ms: 0.0,
                end_ms: 1.0,
                confidence: None,
                offset_ms: None,
                fit: name.map(String::from),
            }
            .into_segment(SegmentKind::Intro, SegmentSource::SkipDb)
            .fit
        };
        assert_eq!(fit(Some("exact")), Fit::Exact);
        assert_eq!(fit(Some("shifted")), Fit::Shifted);
        assert_eq!(fit(Some("out-of-range")), Fit::Mismatch);
        assert_eq!(fit(Some("agnostic")), Fit::Unchecked);
        assert_eq!(fit(Some("something new")), Fit::Unchecked);
        assert_eq!(fit(None), Fit::Unchecked);
    }

    #[test]
    fn reads_introdb_as_unchecked_and_its_post_credits_scene() {
        let mut response = introdb_episode();
        response.post_credits = Some(RawSegment {
            start_ms: 3480000.0,
            end_ms: 3500000.0,
            confidence: Some(1.0),
            offset_ms: None,
            fit: None,
        });
        let (segments, post_credits) = from_introdb(response);
        assert_eq!(segments.len(), 3);
        assert!(segments
            .iter()
            .all(|s| s.fit == Fit::Unchecked && s.source == SegmentSource::IntroDb));
        assert_eq!(segments[2].kind, SegmentKind::Credits);
        assert_eq!(post_credits, Some(3480.0));
    }

    #[test]
    fn reads_empty_answers() {
        let skipdb: SkipDbResponse = serde_json::from_value(json!({
            "imdb_id": "tt9999999999", "season": 1, "episode": 1,
            "segments": {"intro": null, "recap": null, "outro": null, "preview": null},
            "intro_length_estimate_ms": null
        }))
        .unwrap();
        assert!(from_skipdb(skipdb).is_empty());
        let introdb: IntroDbResponse = serde_json::from_value(json!({
            "imdb_id": "tt0111161", "media_type": "movie", "is_movie": true, "season": 0, "episode": 0,
            "intro": null, "recap": null, "outro": null, "post_credits": null
        }))
        .unwrap();
        assert_eq!(from_introdb(introdb), (Vec::new(), None));
    }

    #[test]
    fn prefers_skipdb_and_fills_in_from_introdb() {
        let (introdb, post_credits) = from_introdb(introdb_episode());
        let merged = merge(from_skipdb(skipdb_shifted()), introdb, post_credits);
        let kinds: Vec<_> = merged.iter().map(|s| (s.kind, s.source)).collect();
        assert_eq!(
            kinds,
            [
                (SegmentKind::Intro, SegmentSource::SkipDb),
                (SegmentKind::Credits, SegmentSource::SkipDb),
                (SegmentKind::Preview, SegmentSource::SkipDb),
                (SegmentKind::Recap, SegmentSource::IntroDb),
            ]
        );
    }

    #[test]
    fn ends_the_credits_where_a_post_credits_scene_starts() {
        let credits = || vec![segment(SegmentKind::Credits, 3400.0, 3500.0)];
        assert_eq!(merge(credits(), Vec::new(), Some(3450.0))[0].end, 3450.0);
        // A scene outside the credits leaves them alone.
        assert_eq!(merge(credits(), Vec::new(), Some(3300.0))[0].end, 3500.0);
        assert_eq!(merge(credits(), Vec::new(), Some(3500.0))[0].end, 3500.0);
    }

    #[test]
    fn combines_both_answers_as_complete() {
        let fetched = combine(Ok(Some(skipdb_shifted())), Ok(Some(introdb_episode()))).unwrap();
        assert!(fetched.complete);
        assert_eq!(fetched.segments.len(), 4);
    }

    #[test]
    fn treats_not_found_as_empty_and_complete() {
        let fetched = combine(Ok(None), Ok(None)).unwrap();
        assert_eq!(
            fetched,
            Fetched {
                segments: Vec::new(),
                complete: true
            }
        );
    }

    #[test]
    fn keeps_one_source_when_the_other_fails() {
        let fetched = combine(
            Err(SkipError::Status("SkipDB", 429)),
            Ok(Some(introdb_episode())),
        )
        .unwrap();
        assert!(!fetched.complete);
        assert!(fetched
            .segments
            .iter()
            .all(|s| s.source == SegmentSource::IntroDb));
        assert_eq!(fetched.segments.len(), 3);

        let fetched = combine(
            Ok(Some(skipdb_shifted())),
            Err(SkipError::Status("IntroDB", 500)),
        )
        .unwrap();
        assert!(!fetched.complete);
        assert_eq!(fetched.segments.len(), 3);
    }

    #[test]
    fn fails_when_both_sources_fail() {
        let err = combine(
            Err(SkipError::Status("SkipDB", 503)),
            Err(SkipError::Status("IntroDB", 500)),
        )
        .unwrap_err();
        assert_eq!(err.to_string(), "SkipDB returned HTTP 503");
    }

    #[test]
    fn checks_the_query_before_asking() {
        let bad = |query: SkipQuery| matches!(query.check(), Err(SkipError::BadQuery(_)));
        assert!(episode(3500.0).check().is_ok());
        assert!(SkipQuery {
            imdb_id: "tt12345678".into(),
            episode: None,
            duration: 6000.0
        }
        .check()
        .is_ok());
        for id in [
            "",
            "tt",
            "tt123456",
            "tt123456789",
            "nm0000123",
            "tt12345a7",
            "tt0903747&x=1",
        ] {
            assert!(
                bad(SkipQuery {
                    imdb_id: id.into(),
                    ..episode(3500.0)
                }),
                "{id}"
            );
        }
        assert!(bad(SkipQuery {
            episode: Some((0, 1)),
            ..episode(3500.0)
        }));
        assert!(bad(SkipQuery {
            episode: Some((1, 0)),
            ..episode(3500.0)
        }));
        for duration in [0.0, 0.4, -5.0, f64::NAN, f64::INFINITY] {
            assert!(bad(episode(duration)), "{duration}");
        }
    }

    #[test]
    fn sends_each_database_what_it_takes() {
        let query = episode(3499.6);
        assert_eq!(
            query.skipdb_params(),
            [
                ("imdb_id", "tt0903747".into()),
                ("season", "1".into()),
                ("episode", "2".into()),
                ("duration", "3500".into())
            ]
        );
        assert_eq!(
            query.introdb_params(),
            [
                ("imdb_id", "tt0903747".into()),
                ("season", "1".into()),
                ("episode", "2".into())
            ]
        );
        let movie = SkipQuery {
            imdb_id: "tt0111161".into(),
            episode: None,
            duration: 8520.2,
        };
        assert_eq!(
            movie.skipdb_params(),
            [("imdb_id", "tt0111161".into()), ("duration", "8520".into())]
        );
        assert_eq!(
            movie.introdb_params(),
            [("imdb_id", "tt0111161".into()), ("is_movie", "true".into())]
        );
    }

    #[test]
    fn keys_the_cache_by_video_and_length() {
        assert_eq!(episode(3499.6).cache_key(), "tt0903747:1:2:3500");
        let movie = SkipQuery {
            imdb_id: "tt0111161".into(),
            episode: None,
            duration: 8520.2,
        };
        assert_eq!(movie.cache_key(), "tt0111161:movie:8520");
    }

    #[test]
    fn keeps_good_times_and_cuts_them_to_the_video() {
        let checked = check_segments(&[segment(SegmentKind::Credits, 3400.0, 3600.0)], 3500.0);
        assert_eq!(checked.len(), 1);
        assert_eq!((checked[0].start, checked[0].end), (3400.0, 3500.0));
    }

    #[test]
    fn checks_nothing_against_a_bad_length() {
        let segments = [segment(SegmentKind::Intro, 10.0, 60.0)];
        for duration in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(check_segments(&segments, duration).is_empty(), "{duration}");
        }
    }

    #[test]
    fn drops_times_that_cant_be_right() {
        let dropped = |s: SkipSegment| check_segments(&[s], 3000.0).is_empty();
        // Out of order, empty, or not numbers. 0 to 0 is SkipDB's "none".
        assert!(dropped(segment(SegmentKind::Intro, 60.0, 10.0)));
        assert!(dropped(segment(SegmentKind::Intro, 0.0, 0.0)));
        assert!(dropped(segment(SegmentKind::Intro, -5.0, 30.0)));
        assert!(dropped(segment(SegmentKind::Intro, f64::NAN, 30.0)));
        assert!(dropped(segment(SegmentKind::Intro, 10.0, f64::INFINITY)));
        // Too short to matter, or with nothing after it.
        assert!(dropped(segment(SegmentKind::Intro, 10.0, 12.5)));
        assert!(dropped(segment(SegmentKind::Credits, 2999.5, 3100.0)));
        assert!(dropped(segment(SegmentKind::Credits, 2998.0, 3000.0)));
        // In the wrong part of the video for its kind.
        assert!(dropped(segment(SegmentKind::Intro, 1300.0, 1360.0)));
        assert!(dropped(segment(SegmentKind::Recap, 1300.0, 1360.0)));
        assert!(dropped(segment(SegmentKind::Credits, 1400.0, 1500.0)));
        assert!(dropped(segment(SegmentKind::Preview, 1400.0, 1460.0)));
        // Too long for its kind.
        assert!(dropped(segment(SegmentKind::Intro, 0.0, 301.0)));
        assert!(dropped(segment(SegmentKind::Preview, 2600.0, 2901.0)));
        assert!(!dropped(segment(SegmentKind::Intro, 0.0, 300.0)));
        assert!(!dropped(segment(SegmentKind::Recap, 1200.0, 1260.0)));
        assert!(!dropped(segment(SegmentKind::Preview, 1500.0, 1560.0)));
    }

    #[test]
    fn allows_long_credits_only_up_to_twenty_minutes() {
        let credits =
            |start: f64| check_segments(&[segment(SegmentKind::Credits, start, 9000.0)], 9000.0);
        assert_eq!(credits(7800.0).len(), 1);
        assert!(credits(7799.0).is_empty());
    }

    #[test]
    fn drops_skipdb_times_for_another_cut() {
        let mismatch = |offset: f64| SkipSegment {
            fit: Fit::Mismatch,
            confidence: Some(0.6),
            offset: Some(offset),
            ..segment(SegmentKind::Intro, 229.5, 246.5)
        };
        assert_eq!(check_segments(&[mismatch(-120.0)], 3380.0).len(), 1);
        assert_eq!(check_segments(&[mismatch(100.0)], 3600.0).len(), 1);
        assert!(check_segments(&[mismatch(-120.1)], 3380.0).is_empty());
        assert!(check_segments(&[mismatch(500.0)], 4000.0).is_empty());
        // The length check only applies to SkipDB's own mismatches.
        let far = SkipSegment {
            fit: Fit::Shifted,
            ..mismatch(500.0)
        };
        assert_eq!(check_segments(&[far], 4000.0).len(), 1);
    }

    #[test]
    fn skips_by_itself_only_with_checked_times() {
        let auto = |s: SkipSegment| check_segments(&[s], 3500.0)[0].auto_from;
        let intro = || segment(SegmentKind::Intro, 229.5, 246.5);
        assert_eq!(auto(intro()), Some(229.5));
        assert_eq!(
            auto(SkipSegment {
                fit: Fit::Shifted,
                confidence: Some(0.82),
                ..intro()
            }),
            Some(229.5)
        );
        assert_eq!(
            auto(SkipSegment {
                fit: Fit::Unchecked,
                ..intro()
            }),
            None
        );
        assert_eq!(
            auto(SkipSegment {
                fit: Fit::Mismatch,
                offset: Some(30.0),
                ..intro()
            }),
            None
        );
        assert_eq!(
            auto(SkipSegment {
                confidence: Some(0.79),
                ..intro()
            }),
            None
        );
        assert_eq!(
            auto(SkipSegment {
                confidence: None,
                ..intro()
            }),
            None
        );
    }

    #[test]
    fn waits_out_the_length_difference_before_skipping_by_itself() {
        let shifted = |offset: f64| SkipSegment {
            fit: Fit::Shifted,
            confidence: Some(0.82),
            offset: Some(offset),
            ..segment(SegmentKind::Intro, 219.5, 236.5)
        };
        assert_eq!(
            check_segments(&[shifted(-10.0)], 3490.0)[0].auto_from,
            Some(229.5)
        );
        assert_eq!(
            check_segments(&[shifted(10.0)], 3510.0)[0].auto_from,
            Some(229.5)
        );
        assert_eq!(
            check_segments(&[shifted(0.0)], 3500.0)[0].auto_from,
            Some(219.5)
        );
        // Too little left to skip after waiting.
        assert_eq!(check_segments(&[shifted(14.5)], 3514.0)[0].auto_from, None);
    }

    #[test]
    fn serializes_for_the_app() {
        let s = SkipSegment {
            auto_from: Some(3.5),
            ..segment(SegmentKind::Credits, 1.0, 9.0)
        };
        let value = serde_json::to_value(&s).unwrap();
        assert_eq!(value["kind"], "credits");
        assert_eq!(value["source"], "skipdb");
        assert_eq!(value["fit"], "exact");
        assert_eq!(value["autoFrom"], 3.5);
        let back: SkipSegment = serde_json::from_value(value).unwrap();
        assert_eq!(back, s);
        let intro_db = serde_json::to_value(SegmentSource::IntroDb).unwrap();
        assert_eq!(intro_db, "introdb");
        assert_eq!(serde_json::to_value(Fit::Mismatch).unwrap(), "mismatch");
    }
}
