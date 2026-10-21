// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Reading a history transfer out of the store, and writing one in. See
//! [`crate::remote::transfer`].

use super::{enrich_stale_series, history_series_title, playback_key, CacheError, CacheStore};
use crate::iptv::m3u::parse_series_name;
use crate::models::channel::Channel;
use crate::models::playlist::ProviderType;
use crate::remote::transfer::matching::{DestChannel, DestProvider, Index};
use crate::remote::transfer::merge::{self, Outcome, Plan, Report};
use crate::remote::transfer::refs::{self, AccountTag, KeyRef, Salt};
use crate::remote::transfer::{Export, Item, ItemKind, ItemRef, Pin, Position, Watched, What};
use rusqlite::{params, OptionalExtension};
use std::collections::HashMap;

/// A provider as an export sees it.
struct Source {
    id: String,
    account: Option<AccountTag>,
    xtream: bool,
}

impl CacheStore {
    fn transfer_providers(&self, salt: &Salt) -> Result<Vec<Source>, CacheError> {
        Ok(self
            .get_providers()?
            .into_iter()
            .map(|p| Source {
                account: refs::account_tag(salt, &p),
                xtream: p.provider_type == ProviderType::Xtream,
                id: p.id,
            })
            .collect())
    }

    /// The IMDb id the OMDb cache has for a channel, however old.
    fn cached_imdb(&self, channel_id: &str) -> Result<Option<String>, CacheError> {
        Ok(self
            .conn
            .query_row(
                "SELECT json_extract(data_json, '$.imdbId') FROM omdb_cache WHERE channel_id = ?1",
                params![channel_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
            .filter(|id| !id.is_empty()))
    }

    /// What this device has to copy, under the destination's `salt`.
    /// `playing` is the channel the player has open, if any, for "Continue
    /// watching here". Without one, the item watched last stands in.
    pub fn export_transfer(
        &self,
        salt: &Salt,
        what: What,
        playing: Option<&str>,
        now: i64,
    ) -> Result<Export, CacheError> {
        let providers = self.transfer_providers(salt)?;
        let provider_of = |channel_id: &str| {
            providers.iter().find(|p| {
                channel_id
                    .strip_prefix(p.id.as_str())
                    .is_some_and(|rest| rest.starts_with('-'))
            })
        };
        let reference = |channel_id: &str, kind: ItemKind, name: String| {
            let mut r = ItemRef::named(kind, name);
            if let Some(p) = provider_of(channel_id) {
                r.account = p.account.clone();
                if p.xtream {
                    r.panel_id = refs::panel_id(channel_id, &p.id).map(str::to_string);
                }
            }
            r
        };

        let mut positions: HashMap<String, Position> = self.rows_of_positions()?;
        let mut items: Vec<Item> = Vec::new();
        let mut by_channel: HashMap<String, usize> = HashMap::new();

        let mut stmt = self.conn.prepare(
            "SELECT wh.channel_id, wh.channel_name, wh.content_type, wh.first_watched_at,
                    wh.last_watched_at, wh.total_duration_seconds, wh.play_count,
                    c.tvg_id, c.series_title, c.season, c.episode
             FROM watch_history wh
             LEFT JOIN channels c ON c.id = wh.channel_id
             ORDER BY wh.last_watched_at DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    Watched {
                        first_watched_at: row.get(3)?,
                        last_watched_at: row.get(4)?,
                        watched_seconds: row.get(5)?,
                        play_count: row.get(6)?,
                    },
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<u32>>(9)?,
                    row.get::<_, Option<u32>>(10)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        for (channel_id, name, content_type, watched, tvg_id, series, season, episode) in rows {
            let kind = match content_type.as_str() {
                "live" => ItemKind::Live,
                "movie" => ItemKind::Movie,
                "series" => ItemKind::Episode,
                _ => continue,
            };
            let mut r = reference(&channel_id, kind, name.clone());
            match kind {
                ItemKind::Live => r.tvg_id = tvg_id.filter(|t| !t.is_empty()),
                ItemKind::Movie => r.imdb = self.cached_imdb(&channel_id)?,
                _ => {
                    let numbers = season.zip(episode).or_else(|| {
                        parse_series_name(&name).map(|(_, season, episode)| (season, episode))
                    });
                    if let Some((season, episode)) = numbers {
                        r.series = Some(history_series_title(series.clone(), &name));
                        r.season = Some(season);
                        r.episode = Some(episode);
                    }
                }
            }
            let position = playback_key(&name, &content_type, series, season, episode)
                .and_then(|key| positions.remove(&key));
            by_channel.insert(channel_id, items.len());
            items.push(Item {
                reference: r,
                watched: Some(watched),
                position,
                favorite: false,
            });
        }

        let mut stmt = self.conn.prepare(
            "SELECT id, name, content_type, tvg_id, series_title, season, episode
             FROM channels WHERE is_favorite = 1 ORDER BY rowid",
        )?;
        let favorites = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<u32>>(5)?,
                    row.get::<_, Option<u32>>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        for (channel_id, name, content_type, tvg_id, series, season, episode) in favorites {
            if let Some(&i) = by_channel.get(&channel_id) {
                items[i].favorite = true;
                continue;
            }
            let kind = match (content_type.as_str(), season.zip(episode)) {
                ("live", _) => ItemKind::Live,
                ("movie", _) => ItemKind::Movie,
                ("series", Some(_)) => ItemKind::Episode,
                ("series", None) => ItemKind::Series,
                _ => continue,
            };
            let mut r = reference(&channel_id, kind, name.clone());
            match kind {
                ItemKind::Live => r.tvg_id = tvg_id.filter(|t| !t.is_empty()),
                ItemKind::Movie | ItemKind::Series => r.imdb = self.cached_imdb(&channel_id)?,
                ItemKind::Episode => {
                    r.series = Some(series.unwrap_or_else(|| name.clone()));
                    r.season = season;
                    r.episode = episode;
                }
            }
            by_channel.insert(channel_id, items.len());
            items.push(Item {
                reference: r,
                watched: None,
                position: None,
                favorite: true,
            });
        }

        // Positions with no history entry, such as one whose entry was
        // deleted: the key is all there is to go on.
        let mut rest: Vec<(String, Position)> = positions.into_iter().collect();
        rest.sort_by(|a, b| b.1.updated_at.cmp(&a.1.updated_at).then(a.0.cmp(&b.0)));
        for (key, position) in rest {
            let reference = match refs::parse_key(&key) {
                Some(KeyRef::Movie(title)) => ItemRef::named(ItemKind::Movie, title),
                Some(KeyRef::Episode {
                    series,
                    season,
                    episode,
                }) => ItemRef {
                    series: Some(series.clone()),
                    season: Some(season),
                    episode: Some(episode),
                    ..ItemRef::named(
                        ItemKind::Episode,
                        format!("{series} S{season:02}E{episode:02}"),
                    )
                },
                None => continue,
            };
            items.push(Item {
                reference,
                watched: None,
                position: Some(position),
                favorite: false,
            });
        }

        let mut stmt = self.conn.prepare(
            "SELECT provider_id, content_type, group_name FROM pinned_groups
             ORDER BY provider_id, content_type, sort_order, group_name",
        )?;
        let pinned = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        let pins = pinned
            .into_iter()
            .filter_map(|(provider_id, content_type, group)| {
                let account = providers
                    .iter()
                    .find(|p| p.id == provider_id)?
                    .account
                    .clone()?;
                Some(Pin {
                    account,
                    content_type,
                    group,
                })
            })
            .collect();

        // History is in newest-first order, so the first item with an entry
        // is the one watched last.
        let current = playing
            .and_then(|id| by_channel.get(id))
            .map(|&i| items[i].reference.clone())
            .or_else(|| {
                items
                    .iter()
                    .find(|i| i.watched.is_some())
                    .map(|i| i.reference.clone())
            });

        Ok(Export {
            items,
            pins,
            current,
            sent_at: now,
        }
        .only(what))
    }

    fn rows_of_positions(&self) -> Result<HashMap<String, Position>, CacheError> {
        let mut stmt = self.conn.prepare(
            "SELECT content_key, position_seconds, duration_seconds, updated_at, finished
             FROM playback_positions",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    Position {
                        position: row.get(1)?,
                        duration: row.get(2)?,
                        updated_at: row.get(3)?,
                        finished: row.get(4)?,
                    },
                ))
            })?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
        Ok(rows)
    }

    /// This device's catalog arranged for matching what another device
    /// sent, under the transfer's `salt`. Saved episode lists are included.
    pub fn transfer_index(&self, salt: &Salt) -> Result<Index, CacheError> {
        let providers: Vec<DestProvider> = self
            .transfer_providers(salt)?
            .into_iter()
            .map(|p| DestProvider {
                id: p.id,
                account: p.account,
                xtream: p.xtream,
            })
            .collect();

        let mut stmt = self.conn.prepare(
            "SELECT c.id, c.provider_id, c.name, c.content_type, c.group_title, c.logo_url,
                    c.tvg_id, c.series_title, c.season, c.episode,
                    json_extract(o.data_json, '$.imdbId')
             FROM channels c
             LEFT JOIN omdb_cache o ON o.channel_id = c.id
             ORDER BY c.rowid",
        )?;
        let mut channels = stmt
            .query_map([], |row| {
                Ok(DestChannel {
                    id: row.get(0)?,
                    provider_id: row.get(1)?,
                    name: row.get(2)?,
                    content_type: row.get(3)?,
                    group: row.get(4)?,
                    logo: row.get(5)?,
                    tvg_id: row.get(6)?,
                    series_title: row.get(7)?,
                    season: row.get(8)?,
                    episode: row.get(9)?,
                    imdb: row.get(10)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        enrich_names(&mut channels);

        let shows: HashMap<String, (String, String)> = channels
            .iter()
            .filter(|c| c.content_type == "series" && c.season.is_none())
            .map(|c| (c.id.clone(), (c.provider_id.clone(), c.group.clone())))
            .collect();
        let mut stmt = self
            .conn
            .prepare("SELECT series_channel_id, episodes_json FROM series_episode_cache")?;
        let lists = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        for (show_id, json) in lists {
            // A list whose show is gone, such as one of a removed provider,
            // could point at nothing this device can play.
            let Some((provider_id, group)) = shows.get(&show_id) else {
                continue;
            };
            let episodes: Vec<Channel> = serde_json::from_str(&json).unwrap_or_default();
            channels.extend(
                episodes
                    .into_iter()
                    .filter(|e| e.season.is_some() && e.episode.is_some())
                    .map(|e| DestChannel {
                        id: e.id,
                        provider_id: provider_id.clone(),
                        name: e.name,
                        content_type: "series".into(),
                        group: group.clone(),
                        logo: e.logo_url,
                        tvg_id: None,
                        series_title: e.series_title,
                        season: e.season,
                        episode: e.episode,
                        imdb: None,
                    }),
            );
        }
        Ok(Index::new(&providers, channels))
    }

    /// Writes a planned transfer in one transaction. If anything fails,
    /// nothing is written.
    pub fn apply_transfer(&self, plan: &Plan) -> Result<Report, CacheError> {
        let tx = self.conn.unchecked_transaction()?;
        let mut report = Report {
            unmatched: plan.unmatched.clone(),
            unmatched_total: plan.unmatched_total,
            ..Report::default()
        };

        for row in plan.history.values() {
            let old: Option<Watched> = tx
                .query_row(
                    "SELECT first_watched_at, last_watched_at, play_count, total_duration_seconds
                     FROM watch_history WHERE channel_id = ?1",
                    params![row.channel.id],
                    |r| {
                        Ok(Watched {
                            first_watched_at: r.get(0)?,
                            last_watched_at: r.get(1)?,
                            play_count: r.get(2)?,
                            watched_seconds: r.get(3)?,
                        })
                    },
                )
                .optional()?;
            let outcome = match merge::merge_watched(old, row.watched) {
                None => Outcome::Unchanged,
                Some(w) => {
                    tx.execute(
                        "INSERT INTO watch_history
                            (channel_id, channel_name, channel_logo, content_type,
                             first_watched_at, last_watched_at, total_duration_seconds, play_count)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                         ON CONFLICT(channel_id) DO UPDATE SET
                            first_watched_at       = excluded.first_watched_at,
                            last_watched_at        = excluded.last_watched_at,
                            total_duration_seconds = excluded.total_duration_seconds,
                            play_count             = excluded.play_count",
                        params![
                            row.channel.id,
                            row.channel.name,
                            row.channel.logo,
                            row.channel.content_type,
                            w.first_watched_at,
                            w.last_watched_at,
                            w.watched_seconds,
                            w.play_count,
                        ],
                    )?;
                    if old.is_some() {
                        Outcome::Updated
                    } else {
                        Outcome::Added
                    }
                }
            };
            report.history.count(outcome);
        }

        for (key, position) in &plan.positions {
            let old: Option<Position> = tx
                .query_row(
                    "SELECT position_seconds, duration_seconds, updated_at, finished
                     FROM playback_positions WHERE content_key = ?1",
                    params![key],
                    |r| {
                        Ok(Position {
                            position: r.get(0)?,
                            duration: r.get(1)?,
                            updated_at: r.get(2)?,
                            finished: r.get(3)?,
                        })
                    },
                )
                .optional()?;
            let outcome = match merge::merge_position(old, *position) {
                None => Outcome::Unchanged,
                Some(p) => {
                    tx.execute(
                        "INSERT INTO playback_positions
                            (content_key, position_seconds, duration_seconds, updated_at, finished)
                         VALUES (?1, ?2, ?3, ?4, ?5)
                         ON CONFLICT(content_key) DO UPDATE SET
                            position_seconds = excluded.position_seconds,
                            duration_seconds = excluded.duration_seconds,
                            updated_at       = excluded.updated_at,
                            finished         = excluded.finished",
                        params![key, p.position, p.duration, p.updated_at, p.finished],
                    )?;
                    if old.is_some() {
                        Outcome::Updated
                    } else {
                        Outcome::Added
                    }
                }
            };
            report.positions.count(outcome);
        }

        for channel_id in &plan.favorites {
            let changed = tx.execute(
                "UPDATE channels SET is_favorite = 1 WHERE id = ?1 AND is_favorite = 0",
                params![channel_id],
            )?;
            report.favorites.count(if changed > 0 {
                Outcome::Added
            } else {
                Outcome::Unchanged
            });
        }

        for pin in &plan.pins {
            let added = tx.execute(
                "INSERT OR IGNORE INTO pinned_groups (provider_id, content_type, group_name, sort_order)
                 SELECT ?1, ?2, ?3, COALESCE(MAX(sort_order) + 1, 0) FROM pinned_groups
                 WHERE provider_id = ?1 AND content_type = ?2",
                params![pin.provider_id, pin.content_type, pin.group],
            )?;
            report.pins.count(if added > 0 {
                Outcome::Added
            } else {
                Outcome::Unchanged
            });
        }

        report.resume = match &plan.resume {
            None => None,
            Some(resume) => {
                let position = match &resume.key {
                    None => None,
                    Some(key) => tx
                        .query_row(
                            "SELECT position_seconds FROM playback_positions
                             WHERE content_key = ?1 AND finished = 0",
                            params![key],
                            |r| r.get::<_, f64>(0),
                        )
                        .optional()?,
                };
                Some(merge::Resume {
                    position,
                    ..resume.clone()
                })
            }
        };

        tx.commit()?;
        Ok(report)
    }
}

impl CacheStore {
    /// The channel or saved episode with this id, for "Continue watching
    /// here" after a transfer. Episodes have no row of their own, so their
    /// shows' saved lists are looked through.
    pub fn find_channel(&self, id: &str) -> Result<Option<Channel>, CacheError> {
        if let Some(channel) = self.get_channel_by_id(id)? {
            return Ok(Some(channel));
        }
        let mut stmt = self
            .conn
            .prepare("SELECT episodes_json FROM series_episode_cache")?;
        let lists = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(lists.into_iter().find_map(|json| {
            serde_json::from_str::<Vec<Channel>>(&json)
                .ok()?
                .into_iter()
                .find(|e| e.id == id)
        }))
    }
}

/// Fills in the show, season and episode of series channels saved before
/// they were stored, as [`CacheStore::get_all_channels`] does.
fn enrich_names(channels: &mut [DestChannel]) {
    let mut as_channels: Vec<Channel> = channels
        .iter()
        .map(|c| Channel {
            name: c.name.clone(),
            content_type: c.content_type.clone(),
            series_title: c.series_title.clone(),
            season: c.season,
            episode: c.episode,
            ..Channel::default()
        })
        .collect();
    enrich_stale_series(&mut as_channels);
    for (c, e) in channels.iter_mut().zip(as_channels) {
        c.series_title = e.series_title;
        c.season = e.season;
        c.episode = e.episode;
    }
}

#[cfg(test)]
mod tests;
