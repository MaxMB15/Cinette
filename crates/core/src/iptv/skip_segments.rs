// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Times to skip the intro, recap, credits and next-episode preview of a movie
//! or episode.
//!
//! The times come from two free databases that people fill in by hand, both
//! looked up by IMDb ID. SkipDB (skipdb.tv, ODbL 1.0) is preferred because it
//! checks its times against the length of the video being played. IntroDB
//! (introdb.app) fills in the kinds SkipDB doesn't have, but it can't be
//! checked that way. Each database is asked and cached on its own by
//! `fetch_source`, and `resolve` puts their answers together for a video.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use thiserror::Error;

const SKIPDB_URL: &str = "https://api.skipdb.tv/api/segments";
const INTRODB_URL: &str = "https://api.introdb.app/segments";

/// Both databases answer in well under a second, so one that takes longer is
/// down. The other's times are shown without waiting for it.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// A segment this close to the end has nothing left to skip to.
const END_MARGIN: f64 = 1.0;

/// Anything shorter isn't worth a button, and is likely a stray submission.
const MIN_LENGTH: f64 = 3.0;

/// Times for a video whose length is further off than this are taken to be for
/// another cut, such as an extended edition, and are dropped.
const MAX_MISMATCH: f64 = 120.0;

/// SkipDB calls a video an exact match when it's within this many seconds of
/// the length its times were taken from, and reports no difference for it.
const EXACT_SLACK: f64 = 2.0;

/// How far past the video's end a segment may run, beyond the length
/// difference SkipDB reports, before it's taken to be for a longer cut.
const END_SLACK: f64 = 15.0;

/// Times that end this close to the end of the copy they were taken from are
/// taken to run to its end.
const RUNS_TO_END: f64 = 5.0;

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
    /// Where it ends, in seconds. The Skip button jumps here.
    pub end: f64,
    pub source: SegmentSource,
    pub fit: Fit,
    /// How sure the source is of the times, from 0 to 1.
    pub confidence: Option<f64>,
    /// The video's length minus the length the times were taken from, in
    /// seconds. SkipDB reports it. IntroDB's times don't say what length they
    /// were taken from, so when SkipDB finds the video too far off its own
    /// copy, `resolve` takes IntroDB's to be off by as much.
    pub offset: Option<f64>,
    /// Where the player may skip from without asking, or `None` when the times
    /// are only good enough for a button. `resolve` sets it.
    #[serde(default)]
    pub auto_from: Option<f64>,
    /// Where skipping without asking jumps to, set along with `auto_from`. It
    /// can stop short of `end` when the times may run late.
    #[serde(default)]
    pub auto_to: Option<f64>,
}

/// What one database had for a video, before it's checked against the video.
/// This is what's cached, so a database that failed can be asked again without
/// asking the other.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTimes {
    pub segments: Vec<SkipSegment>,
    /// Where a scene after the credits starts, which skipping the credits
    /// mustn't jump past. Only IntroDB has it.
    #[serde(default)]
    pub post_credits: Option<f64>,
}

/// The video to look up, checked by `SkipQuery::new`.
#[derive(Debug, Clone, PartialEq)]
pub struct SkipQuery {
    /// The IMDb ID of the movie, or of the series for an episode.
    imdb_id: String,
    /// The season and episode number, or `None` for a movie.
    episode: Option<(u32, u32)>,
    /// The length of the video being played, in seconds.
    duration: f64,
}

impl SkipQuery {
    /// The movie with this IMDb ID, or the episode of the series with it when
    /// `season` and `episode` are both given, `duration` seconds long.
    pub fn new(
        imdb_id: impl Into<String>,
        season: Option<u32>,
        episode: Option<u32>,
        duration: f64,
    ) -> Result<Self, SkipError> {
        let imdb_id = imdb_id.into();
        if !is_imdb_id(&imdb_id) {
            return Err(SkipError::BadQuery(format!("not an IMDb ID: {imdb_id}")));
        }
        let episode = match (season, episode) {
            (None, None) => None,
            (Some(0), Some(_)) | (Some(_), Some(0)) => {
                return Err(SkipError::BadQuery(
                    "seasons and episodes start at 1".into(),
                ))
            }
            (Some(season), Some(episode)) => Some((season, episode)),
            _ => {
                return Err(SkipError::BadQuery(
                    "an episode needs both a season and an episode number".into(),
                ))
            }
        };
        if !(duration.is_finite() && duration >= 1.0) {
            return Err(SkipError::BadQuery(format!("bad length: {duration}")));
        }
        Ok(Self {
            imdb_id,
            episode,
            duration,
        })
    }

    /// The length of the video being played, in seconds.
    pub fn duration(&self) -> f64 {
        self.duration
    }

    /// The cache key for one database's times. SkipDB's depend on the length,
    /// so its key has it in whole seconds, the same as SkipDB is sent.
    /// IntroDB's don't, so one entry serves every length.
    pub fn cache_key(&self, source: SegmentSource) -> String {
        let video = match self.episode {
            Some((season, episode)) => format!("{}:{season}:{episode}", self.imdb_id),
            None => format!("{}:movie", self.imdb_id),
        };
        match source {
            SegmentSource::SkipDb => format!("skipdb:{video}:{}", self.seconds()),
            SegmentSource::IntroDb => format!("introdb:{video}"),
        }
    }

    fn seconds(&self) -> u64 {
        self.duration.round() as u64
    }

    fn skipdb_params(&self) -> Vec<(&'static str, String)> {
        let mut params = vec![("imdb_id", self.imdb_id.clone())];
        if let Some((season, episode)) = self.episode {
            params.push(("season", season.to_string()));
            params.push(("episode", episode.to_string()));
        }
        params.push(("duration", self.seconds().to_string()));
        // Only ever moves times earlier for a shorter video, which `auto_from`
        // and the checks in `check_segment` depend on. It's the default, but
        // pinned so a change of default can't make skips cut into the show.
        params.push(("adjust", "conservative".into()));
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

/// One segment as both databases send it. A segment the database doesn't have
/// is `null`.
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
            auto_to: None,
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

impl From<SkipDbResponse> for SourceTimes {
    fn from(response: SkipDbResponse) -> Self {
        let s = response.segments;
        Self {
            segments: to_segments(
                SegmentSource::SkipDb,
                [
                    (SegmentKind::Intro, s.intro),
                    (SegmentKind::Recap, s.recap),
                    (SegmentKind::Credits, s.outro),
                    (SegmentKind::Preview, s.preview),
                ],
            ),
            post_credits: None,
        }
    }
}

impl From<IntroDbResponse> for SourceTimes {
    fn from(response: IntroDbResponse) -> Self {
        Self {
            segments: to_segments(
                SegmentSource::IntroDb,
                [
                    (SegmentKind::Intro, response.intro),
                    (SegmentKind::Recap, response.recap),
                    (SegmentKind::Credits, response.outro),
                    (SegmentKind::Preview, None),
                ],
            ),
            post_credits: response.post_credits.map(|s| s.start_ms / 1000.0),
        }
    }
}

/// The segments to offer for a video `duration` seconds long, from what each
/// database had for it.
///
/// Each database's times are checked against the video before they're put
/// together, so a bad time from SkipDB doesn't hide a good one from IntroDB.
/// Where both have a kind, SkipDB's wins, since only its times are checked
/// against the video's length.
pub fn resolve(
    skipdb: Option<&SourceTimes>,
    introdb: Option<&SourceTimes>,
    duration: f64,
) -> Vec<SkipSegment> {
    if !(duration.is_finite() && duration > 0.0) {
        return Vec::new();
    }
    let post_credits = introdb.and_then(|t| t.post_credits);
    let skipdb = skipdb.map_or(&[][..], |t| &t.segments);
    let introdb = introdb.map_or(&[][..], |t| &t.segments);
    // How far SkipDB finds the video from its own copy, when it's further than
    // an exact match. IntroDB's times are taken to be off by as much, so they
    // get a button that says the times may be off, or are dropped.
    let off_by = skipdb
        .iter()
        .find(|s| matches!(s.fit, Fit::Shifted | Fit::Mismatch))
        .and_then(|s| s.offset);

    let mut segments: Vec<SkipSegment> = skipdb
        .iter()
        .filter_map(|s| check_segment(s, duration, post_credits))
        .collect();
    for segment in introdb {
        if segments.iter().any(|s| s.kind == segment.kind) {
            continue;
        }
        let segment = match off_by {
            Some(offset) => SkipSegment {
                fit: Fit::Mismatch,
                offset: Some(offset),
                ..segment.clone()
            },
            None => segment.clone(),
        };
        segments.extend(check_segment(&segment, duration, post_credits));
    }
    segments
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

/// The segment fitted to a video `duration` seconds long, with `auto_from`
/// set, or `None` when its times can't be right for the video.
///
/// Times are dropped when they're out of order, too short to matter, in the
/// wrong part of the video for their kind, or too long for it. They're also
/// dropped when they're for a video more than two minutes longer or shorter,
/// or off by more than the segment is long, since a button there could skip
/// part of the show instead.
fn check_segment(
    segment: &SkipSegment,
    duration: f64,
    post_credits: Option<f64>,
) -> Option<SkipSegment> {
    let mut s = segment.clone();
    if !(s.start.is_finite() && s.end.is_finite()) || s.start >= s.end {
        return None;
    }
    let offset = s.offset.unwrap_or(0.0);
    let difference = offset.abs();
    if s.fit == Fit::Mismatch && (difference > MAX_MISMATCH || difference >= s.end - s.start) {
        return None;
    }
    // How far SkipDB moved the times earlier for a shorter video. It doesn't
    // stop at 0, so a recap at the very start can begin before it.
    let moved = if s.fit == Fit::Shifted {
        offset.min(0.0)
    } else {
        0.0
    };
    // Starting before the start, or ending past the end by more than the
    // length difference explains, means the times are for another cut.
    if s.start < moved || s.end > duration + difference + END_SLACK {
        return None;
    }
    // Times that ran to the end of the copy they were taken from run to the
    // end of this video, wherever its extra seconds are.
    if s.end >= duration - offset + moved - RUNS_TO_END {
        s.end = duration;
    }
    // Credits that run into a scene after them end where the scene starts.
    // The scene's time isn't moved, so it's moved as the credits were.
    if let Some(scene) = post_credits.filter(|_| s.kind == SegmentKind::Credits) {
        let scene = scene + moved;
        if s.start < scene && scene < s.end {
            s.end = scene;
        }
    }
    let auto_from = auto_from(&s);
    s.start = s.start.max(0.0);
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
    let auto_to = auto_to(&s, duration);
    s.auto_from = auto_from.filter(|from| auto_to - from >= MIN_LENGTH);
    s.auto_to = s.auto_from.map(|_| auto_to);
    Some(s)
}

/// Where a segment is safe to skip from without asking, from its start before
/// it's cut to the video.
///
/// Only times checked against the video's length qualify. Even then, the
/// video's extra or missing seconds can sit before the segment or after it,
/// which moves the segment by up to `offset` or not at all. Waiting `offset`
/// seconds past the start skips only what's inside the segment either way, so
/// a skip never cuts into the show. SkipDB only moves times earlier, so their
/// end is never early. An exact match can still be up to 2 seconds off either
/// way, so it waits that long, and `auto_to` stops that far short of the end
/// unless the segment runs to the end of the video.
fn auto_from(s: &SkipSegment) -> Option<f64> {
    let checked = matches!(s.fit, Fit::Exact | Fit::Shifted);
    if !checked || !s.confidence.is_some_and(|c| c >= AUTO_CONFIDENCE) {
        return None;
    }
    Some(s.start + s.offset.unwrap_or(0.0).abs().max(EXACT_SLACK))
}

/// Where a segment that may be skipped without asking is skipped to, once its
/// end is fitted to a video `duration` seconds long. See `auto_from`.
fn auto_to(s: &SkipSegment, duration: f64) -> f64 {
    if s.fit == Fit::Exact && s.end < duration {
        s.end - EXACT_SLACK
    } else {
        s.end
    }
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
    let response = client
        .get(url)
        .query(params)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(SkipError::Status(name, status.as_u16()));
    }
    Ok(Some(response.json().await?))
}

/// Looks the video up in one database. Nothing found comes back empty rather
/// than as an error, so it can be cached.
pub async fn fetch_source(
    query: &SkipQuery,
    source: SegmentSource,
) -> Result<SourceTimes, SkipError> {
    let url = match source {
        SegmentSource::SkipDb => SKIPDB_URL,
        SegmentSource::IntroDb => INTRODB_URL,
    };
    fetch_from(&client(), url, query, source).await
}

async fn fetch_from(
    client: &reqwest::Client,
    url: &str,
    query: &SkipQuery,
    source: SegmentSource,
) -> Result<SourceTimes, SkipError> {
    Ok(match source {
        SegmentSource::SkipDb => {
            get_json::<SkipDbResponse>(client, "SkipDB", url, &query.skipdb_params())
                .await?
                .map(SourceTimes::from)
        }
        SegmentSource::IntroDb => {
            get_json::<IntroDbResponse>(client, "IntroDB", url, &query.introdb_params())
                .await?
                .map(SourceTimes::from)
        }
    }
    .unwrap_or_default())
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
            auto_to: None,
        }
    }

    /// A segment SkipDB fitted to a video `offset` seconds longer or shorter.
    fn shifted(kind: SegmentKind, start: f64, end: f64, offset: f64) -> SkipSegment {
        SkipSegment {
            fit: Fit::Shifted,
            confidence: Some(0.82),
            offset: Some(offset),
            ..segment(kind, start, end)
        }
    }

    /// A segment SkipDB has for a video `offset` seconds longer or shorter
    /// than this one, too far off to fit.
    fn mismatch(kind: SegmentKind, start: f64, end: f64, offset: f64) -> SkipSegment {
        SkipSegment {
            fit: Fit::Mismatch,
            confidence: Some(0.6),
            offset: Some(offset),
            ..segment(kind, start, end)
        }
    }

    fn from_introdb(kind: SegmentKind, start: f64, end: f64) -> SkipSegment {
        SkipSegment {
            source: SegmentSource::IntroDb,
            fit: Fit::Unchecked,
            confidence: Some(1.0),
            offset: None,
            ..segment(kind, start, end)
        }
    }

    fn times(segments: Vec<SkipSegment>) -> SourceTimes {
        SourceTimes {
            segments,
            post_credits: None,
        }
    }

    /// The segments `resolve` keeps from SkipDB alone.
    fn check(segments: Vec<SkipSegment>, duration: f64) -> Vec<SkipSegment> {
        resolve(Some(&times(segments)), None, duration)
    }

    fn episode(duration: f64) -> SkipQuery {
        SkipQuery::new("tt0903747", Some(1), Some(2), duration).unwrap()
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
                "preview": null
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

    mod reading {
        use super::*;

        #[test]
        fn reads_skipdb_times_and_fit() {
            let segments = SourceTimes::from(skipdb_shifted()).segments;
            assert_eq!(segments.len(), 2);
            let intro = &segments[0];
            assert_eq!(intro.kind, SegmentKind::Intro);
            assert_eq!((intro.start, intro.end), (219.5, 236.5));
            assert_eq!(intro.fit, Fit::Shifted);
            assert_eq!(intro.offset, Some(-10.0));
            assert_eq!(intro.confidence, Some(0.82));
            assert_eq!(segments[1].kind, SegmentKind::Credits);
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
            let times = SourceTimes::from(response);
            assert_eq!(times.segments.len(), 3);
            assert!(times
                .segments
                .iter()
                .all(|s| s.fit == Fit::Unchecked && s.source == SegmentSource::IntroDb));
            assert_eq!(times.segments[2].kind, SegmentKind::Credits);
            assert_eq!(times.post_credits, Some(3480.0));
        }

        #[test]
        fn reads_empty_answers() {
            let skipdb: SkipDbResponse = serde_json::from_value(json!({
                "imdb_id": "tt9999999999", "season": 1, "episode": 1,
                "segments": {"intro": null, "recap": null, "outro": null, "preview": null},
                "intro_length_estimate_ms": null
            }))
            .unwrap();
            assert_eq!(SourceTimes::from(skipdb), SourceTimes::default());
            let introdb: IntroDbResponse = serde_json::from_value(json!({
                "imdb_id": "tt0111161", "media_type": "movie", "is_movie": true, "season": 0, "episode": 0,
                "intro": null, "recap": null, "outro": null, "post_credits": null
            }))
            .unwrap();
            assert_eq!(SourceTimes::from(introdb), SourceTimes::default());
        }

        #[test]
        fn serializes_for_the_app_and_the_cache() {
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

            let times = SourceTimes {
                segments: vec![s],
                post_credits: Some(8.0),
            };
            let value = serde_json::to_value(&times).unwrap();
            assert_eq!(value["postCredits"], 8.0);
            assert_eq!(serde_json::from_value::<SourceTimes>(value).unwrap(), times);
        }
    }

    mod query {
        use super::*;

        #[test]
        fn checks_the_video_before_asking() {
            let bad = |result: Result<SkipQuery, SkipError>| {
                matches!(result, Err(SkipError::BadQuery(_)))
            };
            assert!(SkipQuery::new("tt0903747", Some(1), Some(2), 3500.0).is_ok());
            assert!(SkipQuery::new("tt12345678", None, None, 6000.0).is_ok());
            for id in [
                "",
                "tt",
                "tt123456",
                "tt123456789",
                "nm0000123",
                "tt12345a7",
                "tt0903747&x=1",
            ] {
                assert!(bad(SkipQuery::new(id, None, None, 3500.0)), "{id}");
            }
            assert!(bad(SkipQuery::new("tt0903747", Some(0), Some(1), 3500.0)));
            assert!(bad(SkipQuery::new("tt0903747", Some(1), Some(0), 3500.0)));
            // An episode number alone isn't a movie.
            assert!(bad(SkipQuery::new("tt0903747", Some(1), None, 3500.0)));
            assert!(bad(SkipQuery::new("tt0903747", None, Some(1), 3500.0)));
            for duration in [0.0, 0.4, -5.0, f64::NAN, f64::INFINITY] {
                assert!(
                    bad(SkipQuery::new("tt0903747", None, None, duration)),
                    "{duration}"
                );
            }
        }

        #[test]
        fn sends_each_database_what_it_takes() {
            let query = episode(3499.6);
            assert_eq!(query.duration(), 3499.6);
            assert_eq!(
                query.skipdb_params(),
                [
                    ("imdb_id", "tt0903747".into()),
                    ("season", "1".into()),
                    ("episode", "2".into()),
                    ("duration", "3500".into()),
                    ("adjust", "conservative".into())
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
            let movie = SkipQuery::new("tt0111161", None, None, 8520.2).unwrap();
            assert_eq!(
                movie.skipdb_params(),
                [
                    ("imdb_id", "tt0111161".into()),
                    ("duration", "8520".into()),
                    ("adjust", "conservative".into())
                ]
            );
            assert_eq!(
                movie.introdb_params(),
                [("imdb_id", "tt0111161".into()), ("is_movie", "true".into())]
            );
        }

        #[test]
        fn keys_skipdb_by_length_and_introdb_by_video_only() {
            let query = episode(3499.6);
            assert_eq!(
                query.cache_key(SegmentSource::SkipDb),
                "skipdb:tt0903747:1:2:3500"
            );
            assert_eq!(
                query.cache_key(SegmentSource::IntroDb),
                "introdb:tt0903747:1:2"
            );
            assert_eq!(
                episode(3600.0).cache_key(SegmentSource::IntroDb),
                query.cache_key(SegmentSource::IntroDb)
            );
            let movie = SkipQuery::new("tt0111161", None, None, 8520.2).unwrap();
            assert_eq!(
                movie.cache_key(SegmentSource::SkipDb),
                "skipdb:tt0111161:movie:8520"
            );
            assert_eq!(
                movie.cache_key(SegmentSource::IntroDb),
                "introdb:tt0111161:movie"
            );
        }
    }

    mod putting_together {
        use super::*;

        #[test]
        fn prefers_skipdb_and_fills_in_from_introdb() {
            let skipdb = SourceTimes::from(skipdb_shifted());
            let introdb = SourceTimes::from(introdb_episode());
            let resolved = resolve(Some(&skipdb), Some(&introdb), 3490.0);
            let kinds: Vec<_> = resolved.iter().map(|s| (s.kind, s.source)).collect();
            assert_eq!(
                kinds,
                [
                    (SegmentKind::Intro, SegmentSource::SkipDb),
                    (SegmentKind::Credits, SegmentSource::SkipDb),
                    (SegmentKind::Recap, SegmentSource::IntroDb),
                ]
            );
        }

        #[test]
        fn uses_either_source_alone() {
            let skipdb = SourceTimes::from(skipdb_shifted());
            let introdb = SourceTimes::from(introdb_episode());
            assert_eq!(resolve(Some(&skipdb), None, 3490.0).len(), 2);
            assert_eq!(resolve(None, Some(&introdb), 3500.0).len(), 3);
            assert!(resolve(None, None, 3500.0).is_empty());
        }

        #[test]
        fn checks_each_source_before_putting_them_together() {
            // A stray two-second intro from SkipDB doesn't hide IntroDB's.
            let skipdb = times(vec![segment(SegmentKind::Intro, 229.0, 231.0)]);
            let introdb = times(vec![from_introdb(SegmentKind::Intro, 229.0, 246.0)]);
            let resolved = resolve(Some(&skipdb), Some(&introdb), 3500.0);
            assert_eq!(resolved.len(), 1);
            assert_eq!(resolved[0].source, SegmentSource::IntroDb);
        }

        #[test]
        fn takes_introdb_to_be_as_far_off_as_skipdb_finds_the_video() {
            let introdb = times(vec![
                from_introdb(SegmentKind::Intro, 229.0, 246.0),
                from_introdb(SegmentKind::Credits, 3431.0, 3500.0),
            ]);
            // 200 seconds longer is another cut, so IntroDB's credits would
            // show in the last act.
            let far = times(vec![mismatch(SegmentKind::Intro, 229.5, 246.5, 200.0)]);
            assert!(resolve(Some(&far), Some(&introdb), 3700.0).is_empty());
            // 40 seconds keeps the credits, which are longer than that, as a
            // button with a warning. The intro is shorter, so it's dropped.
            let near = times(vec![mismatch(SegmentKind::Preview, 3300.0, 3360.0, 40.0)]);
            let resolved = resolve(Some(&near), Some(&introdb), 3540.0);
            let credits = resolved
                .iter()
                .find(|s| s.kind == SegmentKind::Credits)
                .unwrap();
            assert_eq!(credits.source, SegmentSource::IntroDb);
            assert_eq!(credits.fit, Fit::Mismatch);
            assert_eq!(credits.auto_from, None);
            assert!(!resolved.iter().any(|s| s.kind == SegmentKind::Intro));
        }

        #[test]
        fn leaves_introdb_unchecked_when_skipdb_matches_exactly() {
            let skipdb = times(vec![segment(SegmentKind::Credits, 3424.0, 3490.0)]);
            let introdb = times(vec![from_introdb(SegmentKind::Intro, 229.0, 246.0)]);
            let resolved = resolve(Some(&skipdb), Some(&introdb), 3490.0);
            assert_eq!(resolved[1].fit, Fit::Unchecked);
            assert_eq!(resolved[1].offset, None);
            assert_eq!(resolved[1].auto_from, None);
        }

        #[test]
        fn warns_about_introdb_when_skipdb_finds_the_video_shifted() {
            // SkipDB fits its times to a video 14 seconds shorter. IntroDB's
            // intro may be off by as much, which is less than it lasts.
            let skipdb = times(vec![shifted(SegmentKind::Credits, 3410.0, 3476.0, -14.0)]);
            let introdb = times(vec![from_introdb(SegmentKind::Intro, 60.0, 120.0)]);
            let resolved = resolve(Some(&skipdb), Some(&introdb), 3476.0);
            let intro = resolved
                .iter()
                .find(|s| s.kind == SegmentKind::Intro)
                .unwrap();
            assert_eq!(intro.source, SegmentSource::IntroDb);
            assert_eq!(intro.fit, Fit::Mismatch);
            assert_eq!(intro.offset, Some(-14.0));
            assert_eq!((intro.start, intro.end), (60.0, 120.0));
            assert_eq!(intro.auto_from, None);
            // A short recap could be off by more than it lasts, so it's dropped.
            let recap = times(vec![from_introdb(SegmentKind::Recap, 0.0, 10.0)]);
            assert!(resolve(Some(&skipdb), Some(&recap), 3476.0)
                .iter()
                .all(|s| s.kind != SegmentKind::Recap));
        }

        #[test]
        fn ends_the_credits_where_a_post_credits_scene_starts() {
            let scene = |at: f64| SourceTimes {
                segments: Vec::new(),
                post_credits: Some(at),
            };
            let credits = |segment: SkipSegment, at: f64, duration: f64| {
                resolve(Some(&times(vec![segment])), Some(&scene(at)), duration)[0].end
            };
            let exact = || segment(SegmentKind::Credits, 3400.0, 3500.0);
            assert_eq!(credits(exact(), 3450.0, 3500.0), 3450.0);
            // A scene outside the credits leaves them alone.
            assert_eq!(credits(exact(), 3300.0, 3500.0), 3500.0);
            assert_eq!(credits(exact(), 3500.0, 3500.0), 3500.0);
            // SkipDB moved its credits ten seconds earlier for a shorter
            // video, so the scene may have moved as well.
            let moved = shifted(SegmentKind::Credits, 3390.0, 3490.0, -10.0);
            assert_eq!(credits(moved, 3450.0, 3490.0), 3440.0);
            // Only credits end at the scene.
            let preview = segment(SegmentKind::Preview, 3400.0, 3500.0);
            assert_eq!(credits(preview, 3450.0, 3500.0), 3500.0);
        }
    }

    mod checking {
        use super::*;

        #[test]
        fn checks_nothing_against_a_bad_length() {
            let segments = vec![segment(SegmentKind::Intro, 10.0, 60.0)];
            for duration in [0.0, -1.0, f64::NAN, f64::INFINITY] {
                assert!(check(segments.clone(), duration).is_empty(), "{duration}");
            }
        }

        #[test]
        fn drops_times_that_cant_be_right() {
            let dropped = |s: SkipSegment| check(vec![s], 3000.0).is_empty();
            // Out of order, empty, before the start, or not numbers.
            assert!(dropped(segment(SegmentKind::Intro, 60.0, 10.0)));
            assert!(dropped(segment(SegmentKind::Intro, 0.0, 0.0)));
            assert!(dropped(segment(SegmentKind::Intro, -5.0, 30.0)));
            assert!(dropped(segment(SegmentKind::Intro, f64::NAN, 30.0)));
            assert!(dropped(segment(SegmentKind::Intro, 10.0, f64::INFINITY)));
            // Too short to matter, or with nothing after it.
            assert!(dropped(segment(SegmentKind::Intro, 10.0, 12.5)));
            assert!(dropped(segment(SegmentKind::Credits, 2999.5, 3010.0)));
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
                |start: f64| check(vec![segment(SegmentKind::Credits, start, 9000.0)], 9000.0);
            assert_eq!(credits(7800.0).len(), 1);
            assert!(credits(7799.0).is_empty());
        }

        #[test]
        fn drops_times_that_run_well_past_the_end() {
            let credits =
                |end: f64| check(vec![segment(SegmentKind::Credits, 3400.0, end)], 3500.0);
            assert_eq!(credits(3510.0)[0].end, 3500.0);
            assert!(credits(3600.0).is_empty());
            // Unless SkipDB says the video is that much shorter.
            let longer = shifted(SegmentKind::Credits, 3400.0, 3520.0, -12.0);
            assert_eq!(check(vec![longer], 3500.0)[0].end, 3500.0);
        }

        #[test]
        fn keeps_a_segment_moved_to_before_the_start() {
            // A recap at 0 to 40 seconds, moved ten seconds earlier for a
            // video ten seconds shorter.
            let recap = |start: f64| {
                check(
                    vec![shifted(SegmentKind::Recap, start, 30.0, -10.0)],
                    3490.0,
                )
            };
            let kept = recap(-10.0);
            assert_eq!((kept[0].start, kept[0].end), (0.0, 30.0));
            assert_eq!(kept[0].auto_from, Some(0.0));
            // Further than it was moved is wrong.
            assert!(recap(-10.5).is_empty());
            // Times that weren't moved can't start before 0.
            let mut unmoved = shifted(SegmentKind::Recap, -5.0, 30.0, 10.0);
            assert!(check(vec![unmoved.clone()], 3510.0).is_empty());
            unmoved.fit = Fit::Exact;
            assert!(check(vec![unmoved], 3510.0).is_empty());
        }

        #[test]
        fn runs_credits_to_the_end_of_a_longer_video() {
            // SkipDB's copy is ten seconds shorter. Its credits ran to its end.
            let credits = shifted(SegmentKind::Credits, 3434.0, 3500.0, 10.0);
            assert_eq!(check(vec![credits], 3510.0)[0].end, 3510.0);
            // Credits that ended well before the end of SkipDB's copy don't.
            let early = shifted(SegmentKind::Credits, 3400.0, 3480.0, 10.0);
            assert_eq!(check(vec![early], 3510.0)[0].end, 3480.0);
            // An exact match that stops just short of the end runs to it.
            let exact = segment(SegmentKind::Credits, 3434.0, 3498.0);
            assert_eq!(check(vec![exact], 3500.0)[0].end, 3500.0);
        }

        #[test]
        fn drops_times_for_another_cut() {
            let credits = |offset: f64, duration: f64| {
                check(
                    vec![mismatch(SegmentKind::Credits, 2000.0, 2300.0, offset)],
                    duration,
                )
            };
            assert_eq!(credits(-120.0, 3380.0).len(), 1);
            assert_eq!(credits(100.0, 3600.0).len(), 1);
            assert!(credits(-120.1, 3380.0).is_empty());
            assert!(credits(500.0, 4000.0).is_empty());
            // Off by more than the segment is long, it may not overlap the
            // segment at all.
            let intro = |offset: f64| {
                check(
                    vec![mismatch(SegmentKind::Intro, 229.5, 246.5, offset)],
                    3500.0 + offset,
                )
            };
            assert_eq!(intro(16.0).len(), 1);
            assert!(intro(17.0).is_empty());
            assert!(intro(-30.0).is_empty());
            // The length check only applies to times SkipDB found too far off.
            let far = SkipSegment {
                fit: Fit::Shifted,
                ..mismatch(SegmentKind::Credits, 2000.0, 2300.0, 500.0)
            };
            assert_eq!(check(vec![far], 4000.0).len(), 1);
        }

        #[test]
        fn skips_by_itself_only_with_checked_times() {
            let auto = |s: SkipSegment| check(vec![s], 3500.0)[0].auto_from;
            let intro = || segment(SegmentKind::Intro, 229.5, 246.5);
            assert_eq!(auto(intro()), Some(231.5));
            assert_eq!(
                auto(shifted(SegmentKind::Intro, 229.5, 246.5, 0.0)),
                Some(231.5)
            );
            assert_eq!(
                auto(SkipSegment {
                    fit: Fit::Unchecked,
                    ..intro()
                }),
                None
            );
            assert_eq!(auto(mismatch(SegmentKind::Intro, 229.5, 246.5, 3.0)), None);
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
            let auto = |offset: f64| {
                check(
                    vec![shifted(SegmentKind::Intro, 219.5, 236.5, offset)],
                    3500.0 + offset,
                )[0]
                .auto_from
            };
            assert_eq!(auto(-10.0), Some(229.5));
            assert_eq!(auto(10.0), Some(229.5));
            // Even an exact match may be up to two seconds off.
            assert_eq!(auto(0.0), Some(221.5));
            assert_eq!(auto(1.0), Some(221.5));
            // Too little left to skip after waiting.
            assert_eq!(auto(14.5), None);
        }

        #[test]
        fn stops_short_of_the_end_only_for_an_exact_match() {
            let fitted = |s: SkipSegment, duration: f64| {
                let s = check(vec![s], duration).remove(0);
                (s.auto_from, s.auto_to, s.end)
            };
            // An exact match may be two seconds early, as well as late.
            assert_eq!(
                fitted(segment(SegmentKind::Intro, 60.0, 120.0), 3500.0),
                (Some(62.0), Some(118.0), 120.0)
            );
            // SkipDB moved these earlier for a shorter video, so the end can't
            // be early.
            assert_eq!(
                fitted(shifted(SegmentKind::Intro, 50.0, 110.0, -10.0), 3490.0),
                (Some(60.0), Some(110.0), 110.0)
            );
            assert_eq!(
                fitted(shifted(SegmentKind::Intro, 60.0, 120.0, 10.0), 3510.0),
                (Some(70.0), Some(120.0), 120.0)
            );
            // A segment too short to skip both ways gets only a button.
            assert_eq!(
                fitted(segment(SegmentKind::Intro, 60.0, 66.5), 3500.0),
                (None, None, 66.5)
            );
            assert_eq!(
                fitted(segment(SegmentKind::Intro, 60.0, 67.0), 3500.0),
                (Some(62.0), Some(65.0), 67.0)
            );
            // Credits that run to the end of the video can't end late.
            assert_eq!(
                fitted(segment(SegmentKind::Credits, 3494.0, 3500.0), 3500.0),
                (Some(3496.0), Some(3500.0), 3500.0)
            );
        }

        #[test]
        fn waits_from_where_the_credits_end_at_a_scene() {
            let scene = SourceTimes {
                segments: Vec::new(),
                post_credits: Some(3403.0),
            };
            let credits = times(vec![segment(SegmentKind::Credits, 3400.0, 3500.0)]);
            let resolved = resolve(Some(&credits), Some(&scene), 3500.0);
            assert_eq!(resolved[0].end, 3403.0);
            assert_eq!(resolved[0].auto_from, None);
        }
    }
}
