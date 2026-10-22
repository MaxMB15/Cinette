// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! "Send providers to [device]": picking them out of the cache on this
//! device, and saving them as its own on the other.
//!
//! Logins are only read from the cache once the other device has allowed
//! it, and never reach a log. A provider saved on the target is loaded the
//! way one added by hand is, so one whose list doesn't load isn't saved.

use crate::commands::{add_m3u_url, add_xtream};
use mvp_core::cache::store::CacheStore;
use mvp_core::models::playlist::{Provider, ProviderType};
use mvp_core::remote::transfer::flow::{
    provider_name_ok, ProviderKind, ProviderName, ProviderOutcome, ProviderResult,
    ProviderSettings, MAX_PROVIDERS, MAX_PROVIDER_FIELD,
};
use std::sync::Mutex;
use zeroize::Zeroize;

/// What a provider that didn't load says on the device that sent it. The
/// error itself can hold the provider's address.
pub const COULDNT_LOAD: &str = "Its channel list didn't load on that device.";

fn kind_of(provider: &Provider) -> ProviderKind {
    match provider.provider_type {
        ProviderType::M3u => ProviderKind::M3u,
        ProviderType::Xtream => ProviderKind::Xtream,
    }
}

/// A playlist that's a file on this device, which no other device can open.
pub fn is_local_file(provider: &Provider) -> bool {
    provider.provider_type == ProviderType::M3u && provider.url.trim().starts_with("file:")
}

/// The providers with these ids, in that order.
fn chosen(cache: &Mutex<CacheStore>, ids: &[String]) -> Result<Vec<Provider>, String> {
    let all = cache
        .lock()
        .map_err(|_| "The cache isn't available.".to_string())?
        .get_providers()
        .map_err(|e| e.to_string())?;
    ids.iter()
        .map(|id| {
            all.iter()
                .find(|p| &p.id == id)
                .cloned()
                .ok_or_else(|| "One of those providers was removed.".to_string())
        })
        .collect()
}

/// The names and kinds to ask for, which is all the other device sees
/// before it allows them.
pub fn names_for(cache: &Mutex<CacheStore>, ids: &[String]) -> Result<Vec<ProviderName>, String> {
    if ids.is_empty() {
        return Err("Pick a provider to send.".into());
    }
    if ids.len() > MAX_PROVIDERS {
        return Err(format!("Pick at most {MAX_PROVIDERS} providers at a time."));
    }
    let providers = chosen(cache, ids)?;
    if providers.iter().any(is_local_file) {
        return Err("A playlist that's a file on this device can't be sent.".into());
    }
    for p in &providers {
        if !provider_name_ok(&p.name) {
            return Err(format!(
                "Rename “{}” before sending it: its name is too long or has characters the other device can't show.",
                p.name.trim()
            ));
        }
        let long = |s: &Option<String>| s.as_ref().is_some_and(|s| s.len() > MAX_PROVIDER_FIELD);
        if p.url.len() > MAX_PROVIDER_FIELD || long(&p.username) || long(&p.password) {
            return Err(format!(
                "“{}” can't be sent: its address or login is too long.",
                p.name
            ));
        }
    }
    let names: Vec<ProviderName> = providers
        .iter()
        .map(|p| ProviderName {
            name: p.name.clone(),
            kind: kind_of(p),
        })
        .collect();
    for (i, name) in names.iter().enumerate() {
        if names[..i].contains(name) {
            return Err(format!(
                "Two of them are called “{}”. Rename one first.",
                name.name
            ));
        }
    }
    Ok(names)
}

/// The full settings of the providers with these ids, logins included.
pub fn settings_for(
    cache: &Mutex<CacheStore>,
    ids: &[String],
) -> Result<Vec<ProviderSettings>, String> {
    Ok(chosen(cache, ids)?
        .into_iter()
        .map(|mut p| {
            let settings = ProviderSettings {
                name: p.name.clone(),
                kind: kind_of(&p),
                url: p.url.clone(),
                username: p.username.clone(),
                password: p.password.clone(),
                // The other device finds the guide the way adding the
                // provider by hand does; for Xtream this would only repeat
                // the password.
                epg_url: None,
            };
            forget(&mut p);
            settings
        })
        .collect())
}

/// Whether two providers are the same account: for Xtream the same server
/// and username, for M3U the same address, query and all, since a token
/// in it can name the account.
fn same_account(a: &Provider, b: &Provider) -> bool {
    if a.provider_type != b.provider_type {
        return false;
    }
    match a.provider_type {
        ProviderType::Xtream => {
            server(&a.url).is_some_and(|s| server(&b.url) == Some(s))
                && a.username.as_deref().unwrap_or_default().trim()
                    == b.username.as_deref().unwrap_or_default().trim()
        }
        ProviderType::M3u => address(&a.url) == address(&b.url),
    }
}

/// An address in one form however it was typed: the host in lower case
/// and a default port left out.
fn address(url: &str) -> String {
    let url = url.trim();
    url::Url::parse(url).map_or_else(|_| url.to_string(), |u| u.to_string())
}

/// The scheme, host and port of an Xtream server.
fn server(url: &str) -> Option<(String, String, Option<u16>)> {
    let u = url::Url::parse(url.trim()).ok()?;
    let host = u.host_str().filter(|h| !h.is_empty())?.to_string();
    Some((u.scheme().to_string(), host, u.port_or_known_default()))
}

/// Clears a provider's address and login from memory.
fn forget(provider: &mut Provider) {
    provider.url.zeroize();
    provider.username.zeroize();
    provider.password.zeroize();
    provider.epg_url.zeroize();
}

/// A name no provider here has yet: the provider's own, or with the
/// sending device's name after it.
fn free_name(name: &str, from: &str, taken: &[String]) -> String {
    let free = |n: &str| !taken.iter().any(|t| t.eq_ignore_ascii_case(n));
    if free(name) {
        return name.to_string();
    }
    let from = if from.trim().is_empty() {
        "another device"
    } else {
        from.trim()
    };
    let base = format!("{name} (from {from})");
    (1..)
        .map(|n| {
            if n == 1 {
                base.clone()
            } else {
                format!("{base} {n}")
            }
        })
        .find(|n| free(n))
        .expect("some number is free")
}

/// What loading a provider does: the cache and the provider's settings in,
/// whether it loaded out. Tests stand in for the network.
pub(crate) trait Loader {
    async fn load(
        &self,
        cache: &Mutex<CacheStore>,
        settings: &ProviderSettings,
        name: String,
    ) -> Result<(), String>;

    /// The providers saved here now.
    fn saved(&self, cache: &Mutex<CacheStore>) -> Result<Vec<Provider>, ()> {
        cache
            .lock()
            .map_err(|_| ())?
            .get_providers()
            .map_err(|_| ())
    }
}

/// Loads providers from their servers, as adding them by hand does.
pub struct Network;

impl Loader for Network {
    async fn load(
        &self,
        cache: &Mutex<CacheStore>,
        settings: &ProviderSettings,
        name: String,
    ) -> Result<(), String> {
        let loaded = match settings.kind {
            ProviderKind::Xtream => {
                add_xtream(
                    cache,
                    name,
                    settings.url.clone(),
                    settings.username.clone().unwrap_or_default(),
                    settings.password.clone().unwrap_or_default(),
                )
                .await
            }
            ProviderKind::M3u => add_m3u_url(cache, name, settings.url.clone()).await,
        };
        loaded.map(|_| ())
    }

    // mutants: skip FnValue: the default reads the same list; this only moves the wait off the async thread.
    fn saved(&self, cache: &Mutex<CacheStore>) -> Result<Vec<Provider>, ()> {
        // A refresh or a guide save can hold the cache for a while.
        tokio::task::block_in_place(|| {
            cache
                .lock()
                .map_err(|_| ())?
                .get_providers()
                .map_err(|_| ())
        })
    }
}

/// Saves providers another device sent as this device's own. One whose
/// account is here already is skipped, and one whose name is taken gets
/// the sending device's name after it. Returns what became of each.
pub(crate) async fn save(
    cache: &Mutex<CacheStore>,
    loader: &impl Loader,
    from: &str,
    providers: Vec<ProviderSettings>,
) -> Vec<ProviderResult> {
    // One save at a time, so two devices sending one account at once can't
    // both find it missing and both add it.
    static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _one = ONE_AT_A_TIME.lock().await;
    let mut results = Vec::with_capacity(providers.len());
    for settings in providers {
        let result = save_one(cache, loader, from, &settings).await;
        results.push(result);
    }
    results
}

async fn save_one(
    cache: &Mutex<CacheStore>,
    loader: &impl Loader,
    from: &str,
    settings: &ProviderSettings,
) -> ProviderResult {
    let failed = |error: &str| ProviderResult {
        name: settings.name.clone(),
        outcome: ProviderOutcome::Failed,
        error: Some(error.to_string()),
        saved_as: None,
    };
    if settings.url.trim().starts_with("file:") {
        return failed("A playlist file on another device can't be opened here.");
    }
    let Ok(existing) = loader.saved(cache) else {
        return failed("This device couldn't save it.");
    };
    let incoming = Provider {
        id: String::new(),
        name: settings.name.clone(),
        provider_type: match settings.kind {
            ProviderKind::M3u => ProviderType::M3u,
            ProviderKind::Xtream => ProviderType::Xtream,
        },
        url: settings.url.clone(),
        username: settings.username.clone(),
        password: None,
        last_updated: None,
        channel_count: 0,
        epg_url: None,
    };
    let mut incoming = incoming;
    let mut taken = Vec::with_capacity(existing.len());
    let mut exists = false;
    for mut p in existing {
        exists |= same_account(&incoming, &p);
        taken.push(p.name.clone());
        forget(&mut p);
    }
    forget(&mut incoming);
    if exists {
        return ProviderResult {
            name: settings.name.clone(),
            outcome: ProviderOutcome::Exists,
            error: None,
            saved_as: None,
        };
    }
    let name = free_name(&settings.name, from, &taken);
    match loader.load(cache, settings, name.clone()).await {
        Ok(()) => {
            tracing::info!("[remote] added a provider sent from another device");
            ProviderResult {
                name: settings.name.clone(),
                outcome: ProviderOutcome::Added,
                error: None,
                saved_as: (name != settings.name).then_some(name),
            }
        }
        Err(_) => {
            // The error can hold the provider's address, so it stays here.
            tracing::warn!("[remote] a provider sent from another device didn't load");
            failed(COULDNT_LOAD)
        }
    }
}

#[cfg(test)]
#[path = "providers_tests.rs"]
mod tests;
