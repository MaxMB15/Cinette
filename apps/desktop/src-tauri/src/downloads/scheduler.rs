// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use mvp_core::downloads::model::DownloadStatus;
use mvp_core::downloads::recording::provider_of;
use std::collections::HashSet;

/// Given the currently-active items (queued + downloading) ordered FIFO and a
/// concurrency limit, return the ids that should be started now. An item should
/// start if it is `Queued` and the number of `Downloading` items is below the
/// limit (counting items we are about to start).
pub fn ids_to_start(active: &[(String, DownloadStatus)], limit: usize) -> Vec<String> {
    let mut running = active
        .iter()
        .filter(|(_, s)| *s == DownloadStatus::Downloading)
        .count();
    let mut to_start = Vec::new();
    for (id, status) in active {
        if running >= limit {
            break;
        }
        if *status == DownloadStatus::Queued {
            to_start.push(id.clone());
            running += 1;
        }
    }
    to_start
}

/// Start queued items up to the limit. `list` reads the active items fresh for
/// each pass and `start` starts one. An item that fails to start frees its
/// slot, so this picks again until a pass has no failures. A failed id is left
/// out of later passes, so this ends even if its status never changes. Returns
/// the first error.
pub fn start_queued(
    limit: usize,
    mut list: impl FnMut() -> Result<Vec<(String, DownloadStatus)>, String>,
    mut start: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    let mut failed = HashSet::new();
    let mut first_err = None;
    loop {
        let active: Vec<_> = list()?
            .into_iter()
            .filter(|(id, _)| !failed.contains(id))
            .collect();
        let mut any_failed = false;
        for id in ids_to_start(&active, limit) {
            if let Err(e) = start(&id) {
                failed.insert(id);
                any_failed = true;
                first_err.get_or_insert(e);
            }
        }
        if !any_failed {
            break;
        }
    }
    first_err.map_or(Ok(()), Err)
}

/// Whether a download of `channel_id` has to wait because a recording is
/// using its provider's connection. `recording` holds the live channels being
/// recorded, and `provider_ids` every provider. Many providers allow one
/// stream at a time, so the download starts once those recordings end.
pub fn waits_for_recording(
    channel_id: &str,
    recording: &[String],
    provider_ids: &[String],
) -> bool {
    let Some(provider) = provider_of(channel_id, provider_ids) else {
        return false;
    };
    recording
        .iter()
        .any(|c| provider_of(c, provider_ids) == Some(provider))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mvp_core::downloads::model::DownloadStatus::*;

    #[test]
    fn starts_up_to_limit() {
        let active = vec![
            ("a".to_string(), Downloading),
            ("b".to_string(), Queued),
            ("c".to_string(), Queued),
            ("d".to_string(), Queued),
        ];
        // limit 3, one already running → start 2 more (b, c).
        assert_eq!(ids_to_start(&active, 3), vec!["b", "c"]);
    }

    #[test]
    fn starts_nothing_when_full() {
        let active = vec![
            ("a".to_string(), Downloading),
            ("b".to_string(), Downloading),
            ("c".to_string(), Queued),
        ];
        assert!(ids_to_start(&active, 2).is_empty());
    }

    #[test]
    fn starts_all_when_under_limit() {
        let active = vec![("a".to_string(), Queued), ("b".to_string(), Queued)];
        assert_eq!(ids_to_start(&active, 5), vec!["a", "b"]);
    }

    type Items = Vec<(String, DownloadStatus)>;

    /// Runs `start_queued` against a list where a started item turns
    /// `Downloading` and an item in `broken` fails. With `mark_failed` a
    /// failure leaves the active list, as when its record turns `Failed`.
    fn run(
        ids: &[&str],
        limit: usize,
        broken: &[&str],
        mark_failed: bool,
    ) -> (Result<(), String>, Vec<String>, Items) {
        let items = std::cell::RefCell::new(
            ids.iter()
                .map(|id| (id.to_string(), Queued))
                .collect::<Items>(),
        );
        let mut attempts = Vec::new();
        let result = start_queued(
            limit,
            || Ok(items.borrow().clone()),
            |id| {
                attempts.push(id.to_string());
                let mut items = items.borrow_mut();
                if broken.contains(&id) {
                    if mark_failed {
                        items.retain(|(i, _)| i != id);
                    }
                    return Err(format!("{id} failed"));
                }
                if let Some(item) = items.iter_mut().find(|(i, _)| i == id) {
                    item.1 = Downloading;
                }
                Ok(())
            },
        );
        (result, attempts, items.into_inner())
    }

    #[test]
    fn fills_the_slot_of_a_download_that_failed_to_start() {
        let (result, attempts, items) = run(&["a", "b", "c"], 1, &["a"], true);
        assert_eq!(result, Err("a failed".to_string()));
        assert_eq!(attempts, vec!["a", "b"]);
        assert_eq!(
            items,
            vec![("b".to_string(), Downloading), ("c".to_string(), Queued)]
        );
    }

    #[test]
    fn ends_when_a_failed_status_cannot_be_saved() {
        let (result, attempts, _) = run(&["a", "b", "c"], 2, &["a", "b", "c"], false);
        assert_eq!(result, Err("a failed".to_string()));
        assert_eq!(attempts, vec!["a", "b", "c"]);
    }

    #[test]
    fn makes_one_pass_when_everything_starts() {
        let (result, attempts, _) = run(&["a", "b", "c"], 2, &[], true);
        assert_eq!(result, Ok(()));
        assert_eq!(attempts, vec!["a", "b"]);
    }

    #[test]
    fn a_download_waits_while_its_provider_records() {
        let providers = vec!["xt-1".to_string(), "m3u-2".to_string()];
        let recording = vec!["xt-1-xt-7".to_string()];
        assert!(waits_for_recording("xt-1-vod-3", &recording, &providers));
        assert!(waits_for_recording(
            "xt-1-xt-ep-9-s1-0",
            &recording,
            &providers
        ));
        assert!(!waits_for_recording("m3u-2-ch-4", &recording, &providers));
        assert!(!waits_for_recording("xt-1-vod-3", &[], &providers));
        // A download whose provider is gone has nothing to wait for.
        assert!(!waits_for_recording("xt-9-vod-3", &recording, &providers));
    }
}
