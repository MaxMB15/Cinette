// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Finding the destination's own item for each reference.
//!
//! The rules go from the most certain to the least, and the first that
//! finds exactly one item wins:
//!
//! 1. The same account and the same Xtream panel id.
//! 2. The same account and the same name.
//! 3. For a live channel, the same `tvg-id` and name, then the `tvg-id`
//!    alone. For a movie or a show, the same IMDb id, then the same title.
//!    For an episode, its show's title with the same season and episode.
//!
//! A rule that finds several items tries to narrow them to the one in a
//! provider with the reference's account. If it can't, the item counts as
//! ambiguous unless a later rule finds exactly one. Nothing is ever picked
//! from several by chance.

use super::refs::{self, normalize_title, AccountTag};
use super::{ItemKind, ItemRef};
use std::collections::{HashMap, HashSet};

/// A provider on the destination.
#[derive(Debug, Clone, PartialEq)]
pub struct DestProvider {
    pub id: String,
    /// See [`refs::account_tag`], under the transfer's salt.
    pub account: Option<AccountTag>,
    /// Xtream panel ids only mean the same thing under an Xtream account.
    pub xtream: bool,
}

/// A channel, movie, show or episode on the destination.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DestChannel {
    pub id: String,
    pub provider_id: String,
    pub name: String,
    /// "live", "movie" or "series".
    pub content_type: String,
    pub group: String,
    pub logo: Option<String>,
    pub tvg_id: Option<String>,
    pub series_title: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub imdb: Option<String>,
}

impl DestChannel {
    fn kind(&self) -> Option<ItemKind> {
        match self.content_type.as_str() {
            "live" => Some(ItemKind::Live),
            "movie" => Some(ItemKind::Movie),
            "series" if self.season.is_some() && self.episode.is_some() => Some(ItemKind::Episode),
            "series" => Some(ItemKind::Series),
            _ => None,
        }
    }

    /// The show an episode belongs to.
    fn show_title(&self) -> &str {
        self.series_title.as_deref().unwrap_or(&self.name)
    }
}

/// Where a matched item's rows go on the destination.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    /// The channel a history row or a favorite goes on. `None` when only the
    /// show was found, which is enough for a position but not for a row.
    pub channel: Option<DestChannel>,
    /// The key a position goes under. `None` for a live channel.
    pub key: Option<String>,
}

/// Why a reference matched nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Miss {
    /// Nothing on the destination is that item.
    Missing,
    /// Several items could be, and nothing says which.
    Ambiguous,
}

/// The destination's catalog, arranged for matching.
#[derive(Debug, Default)]
pub struct Index {
    channels: Vec<DestChannel>,
    accounts: HashMap<String, AccountTag>,
    providers: HashMap<AccountTag, Vec<String>>,
    by_panel: HashMap<(AccountTag, String), usize>,
    by_account_name: HashMap<(AccountTag, ItemKind, String), Vec<usize>>,
    by_tvg_name: HashMap<(String, String), Vec<usize>>,
    by_tvg: HashMap<String, Vec<usize>>,
    by_imdb: HashMap<(ItemKind, String), Vec<usize>>,
    by_title: HashMap<(ItemKind, String), Vec<usize>>,
    by_episode: HashMap<(String, u32, u32), Vec<usize>>,
    groups: HashSet<(String, String, String)>,
}

/// The items a lookup found, if any.
fn get(found: Option<&Vec<usize>>) -> &[usize] {
    found.map_or(&[], Vec::as_slice)
}

/// One result of a rule.
enum Pick {
    One(usize),
    Several,
    None,
}

impl Index {
    /// `channels` are the destination's channels, with the episodes of the
    /// shows whose lists it has saved.
    pub fn new(providers: &[DestProvider], channels: Vec<DestChannel>) -> Self {
        let mut index = Index::default();
        let mut xtream = HashSet::new();
        for p in providers {
            if let Some(account) = &p.account {
                index.accounts.insert(p.id.clone(), account.clone());
                index
                    .providers
                    .entry(account.clone())
                    .or_default()
                    .push(p.id.clone());
                if p.xtream {
                    xtream.insert(p.id.as_str());
                }
            }
        }
        for (i, ch) in channels.iter().enumerate() {
            let Some(kind) = ch.kind() else { continue };
            let account = index.accounts.get(&ch.provider_id).cloned();
            if let Some(account) = &account {
                if xtream.contains(ch.provider_id.as_str())
                    && let Some(panel) = refs::panel_id(&ch.id, &ch.provider_id)
                {
                    index
                        .by_panel
                        .entry((account.clone(), panel.to_string()))
                        .or_insert(i);
                }
                index
                    .by_account_name
                    .entry((account.clone(), kind, normalize_title(&ch.name)))
                    .or_default()
                    .push(i);
            }
            index.groups.insert((
                ch.provider_id.clone(),
                ch.content_type.clone(),
                ch.group.clone(),
            ));
            match kind {
                ItemKind::Live => {
                    if let Some(tvg) = ch.tvg_id.as_deref().filter(|t| !t.trim().is_empty()) {
                        index
                            .by_tvg_name
                            .entry((tvg.to_string(), normalize_title(&ch.name)))
                            .or_default()
                            .push(i);
                        index.by_tvg.entry(tvg.to_string()).or_default().push(i);
                    }
                }
                ItemKind::Movie | ItemKind::Series => {
                    if let Some(imdb) = ch.imdb.as_deref().filter(|t| !t.is_empty()) {
                        index
                            .by_imdb
                            .entry((kind, imdb.to_string()))
                            .or_default()
                            .push(i);
                    }
                    index
                        .by_title
                        .entry((kind, normalize_title(&ch.name)))
                        .or_default()
                        .push(i);
                }
                ItemKind::Episode => {
                    if let (Some(season), Some(episode)) = (ch.season, ch.episode) {
                        index
                            .by_episode
                            .entry((normalize_title(ch.show_title()), season, episode))
                            .or_default()
                            .push(i);
                    }
                }
            }
        }
        index.channels = channels;
        index
    }

    /// The destination's providers with this account.
    pub fn providers_of(&self, account: &AccountTag) -> &[String] {
        self.providers.get(account).map_or(&[], Vec::as_slice)
    }

    /// Whether a provider has a group of that name and content type.
    pub fn has_group(&self, provider_id: &str, content_type: &str, group: &str) -> bool {
        self.groups.contains(&(
            provider_id.to_string(),
            content_type.to_string(),
            group.to_string(),
        ))
    }

    /// Narrows several items to the one with the reference's account.
    fn pick(&self, found: &[usize], account: Option<&AccountTag>) -> Pick {
        match found {
            [] => Pick::None,
            [one] => Pick::One(*one),
            several => {
                let mine: Vec<usize> = several
                    .iter()
                    .copied()
                    .filter(|&i| {
                        account.is_some()
                            && self.accounts.get(&self.channels[i].provider_id) == account
                    })
                    .collect();
                match mine[..] {
                    [one] => Pick::One(one),
                    _ => Pick::Several,
                }
            }
        }
    }

    /// The destination's item for a reference.
    pub fn find(&self, r: &ItemRef) -> Result<Found, Miss> {
        let account = r.account.as_ref();
        let mut ambiguous = false;
        let mut first = |found: Pick| -> Option<usize> {
            match found {
                Pick::One(i) => Some(i),
                Pick::Several => {
                    ambiguous = true;
                    None
                }
                Pick::None => None,
            }
        };

        // 1. The same account and panel id.
        if let (Some(account), Some(panel)) = (account, r.panel_id.as_deref())
            && let Some(&i) = self.by_panel.get(&(account.clone(), panel.to_string()))
            && self.channels[i].kind() == Some(r.kind)
        {
            return Ok(self.found(i));
        }
        if r.kind == ItemKind::Episode
            && let Some(found) = self.episode_by_panel(r)
        {
            return Ok(found);
        }

        // 2. The same account and name.
        if let Some(account) = account {
            let name = match r.kind {
                ItemKind::Episode => None,
                _ => Some(normalize_title(&r.name)),
            };
            if let Some(name) = name
                && let Some(i) = first(self.pick(
                    get(self.by_account_name.get(&(account.clone(), r.kind, name))),
                    Some(account),
                ))
            {
                return Ok(self.found(i));
            }
        }

        // 3. Keys any provider can share.
        match r.kind {
            ItemKind::Live => {
                if let Some(tvg) = r.tvg_id.as_deref().filter(|t| !t.trim().is_empty()) {
                    let by_name = self
                        .by_tvg_name
                        .get(&(tvg.to_string(), normalize_title(&r.name)));
                    if let Some(i) = first(self.pick(get(by_name), account)) {
                        return Ok(self.found(i));
                    }
                    if let Some(i) = first(self.pick(get(self.by_tvg.get(tvg)), account)) {
                        return Ok(self.found(i));
                    }
                }
            }
            ItemKind::Movie | ItemKind::Series => {
                if let Some(imdb) = r.imdb.as_deref().filter(|t| !t.is_empty()) {
                    let found = self.by_imdb.get(&(r.kind, imdb.to_string()));
                    if let Some(i) = first(self.pick(get(found), account)) {
                        return Ok(self.found(i));
                    }
                }
                let found = self.by_title.get(&(r.kind, normalize_title(&r.name)));
                if let Some(i) = first(self.pick(get(found), account)) {
                    return Ok(self.found(i));
                }
            }
            ItemKind::Episode => {
                if let (Some(series), Some(season), Some(episode)) =
                    (r.series.as_deref(), r.season, r.episode)
                {
                    let found = self
                        .by_episode
                        .get(&(normalize_title(series), season, episode));
                    if let Some(i) = first(self.pick(get(found), account)) {
                        return Ok(self.found(i));
                    }
                    // Only the show: enough for the position, whose key can
                    // only ever resume that episode of that show.
                    let shows = self
                        .by_title
                        .get(&(ItemKind::Series, normalize_title(series)));
                    if let Some(i) = first(self.pick(get(shows), account)) {
                        let show = &self.channels[i];
                        return Ok(Found {
                            channel: None,
                            key: Some(refs::episode_key(&show.name, season, episode)),
                        });
                    }
                }
            }
        }
        Err(if ambiguous {
            Miss::Ambiguous
        } else {
            Miss::Missing
        })
    }

    /// An Xtream episode whose list the destination hasn't saved: the same
    /// account has the show, and episode ids follow from the show's.
    fn episode_by_panel(&self, r: &ItemRef) -> Option<Found> {
        let account = r.account.as_ref()?;
        let panel = r.panel_id.as_deref()?;
        let show = refs::series_of_episode(panel)?;
        let &i = self.by_panel.get(&(account.clone(), show))?;
        let show = &self.channels[i];
        let key = match (r.season, r.episode) {
            (Some(season), Some(episode)) => Some(refs::episode_key(&show.name, season, episode)),
            _ => None,
        };
        Some(Found {
            channel: Some(DestChannel {
                id: format!("{}-{panel}", show.provider_id),
                provider_id: show.provider_id.clone(),
                name: r.name.clone(),
                content_type: "series".into(),
                group: show.group.clone(),
                logo: show.logo.clone(),
                tvg_id: None,
                series_title: Some(show.name.clone()),
                season: r.season,
                episode: r.episode,
                imdb: None,
            }),
            key,
        })
    }

    /// Every rule only looks among items of the reference's kind, so the
    /// channel at `i` is one.
    fn found(&self, i: usize) -> Found {
        let ch = &self.channels[i];
        let key = match ch.kind() {
            Some(ItemKind::Movie) => Some(refs::movie_key(&ch.name)),
            Some(ItemKind::Episode) => match (ch.season, ch.episode) {
                (Some(season), Some(episode)) => {
                    Some(refs::episode_key(ch.show_title(), season, episode))
                }
                _ => None,
            },
            _ => None,
        };
        Found {
            channel: Some(ch.clone()),
            key,
        }
    }
}

#[cfg(test)]
mod tests;
