// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Something taken and given back, held at most once, such as Android's
//! Wi-Fi multicast lock. The taking and giving back are passed in, so the
//! rules are the same wherever it's used and tests run without the system.

/// What's held now, if anything.
#[derive(Debug)]
pub struct Held<T>(Option<T>);

impl<T> Held<T> {
    pub const fn new() -> Self {
        Self(None)
    }

    #[cfg(test)]
    pub fn is_held(&self) -> bool {
        self.0.is_some()
    }

    /// Takes it with `acquire` when `hold` and it isn't held, or gives it
    /// back with `release` when it is held and `hold` isn't. Otherwise
    /// nothing is called. A failed `acquire` leaves it unheld, so the next
    /// hold tries again. After `release` it counts as given back even when
    /// that failed, since there's nothing left to retry with.
    pub fn set<E>(
        &mut self,
        hold: bool,
        acquire: impl FnOnce() -> Result<T, E>,
        release: impl FnOnce(T) -> Result<(), E>,
    ) -> Result<(), E> {
        match (hold, self.0.take()) {
            (true, None) => {
                self.0 = Some(acquire()?);
                Ok(())
            }
            (false, Some(held)) => release(held),
            (_, kept) => {
                self.0 = kept;
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// Holds or lets go, counting the calls.
    fn set(
        held: &mut Held<u32>,
        hold: bool,
        calls: &Cell<(u32, u32)>,
        fail: bool,
    ) -> Result<(), ()> {
        held.set(
            hold,
            || {
                calls.set((calls.get().0 + 1, calls.get().1));
                if fail {
                    Err(())
                } else {
                    Ok(7)
                }
            },
            |value| {
                assert_eq!(value, 7, "gives back what it took");
                calls.set((calls.get().0, calls.get().1 + 1));
                Ok(())
            },
        )
    }

    #[test]
    fn holding_twice_takes_it_once() {
        let calls = Cell::new((0, 0));
        let mut held = Held::new();
        set(&mut held, true, &calls, false).unwrap();
        set(&mut held, true, &calls, false).unwrap();
        assert!(held.is_held());
        assert_eq!(calls.get(), (1, 0));
    }

    #[test]
    fn letting_go_gives_it_back_once() {
        let calls = Cell::new((0, 0));
        let mut held = Held::new();
        set(&mut held, true, &calls, false).unwrap();
        set(&mut held, false, &calls, false).unwrap();
        set(&mut held, false, &calls, false).unwrap();
        assert!(!held.is_held());
        assert_eq!(calls.get(), (1, 1));
    }

    #[test]
    fn letting_go_of_nothing_calls_nothing() {
        let calls = Cell::new((0, 0));
        let mut held = Held::<u32>::new();
        set(&mut held, false, &calls, false).unwrap();
        assert_eq!(calls.get(), (0, 0));
    }

    #[test]
    fn a_failed_take_leaves_it_unheld_and_the_next_hold_tries_again() {
        let calls = Cell::new((0, 0));
        let mut held = Held::new();
        assert!(set(&mut held, true, &calls, true).is_err());
        assert!(!held.is_held());
        set(&mut held, true, &calls, false).unwrap();
        assert!(held.is_held());
        assert_eq!(calls.get(), (2, 0));
    }

    #[test]
    fn a_failed_give_back_still_counts_as_given_back() {
        let mut held = Held::new();
        held.set::<()>(true, || Ok(1), |_| Ok(())).unwrap();
        assert!(held.set(false, || Ok(1), |_| Err("gone")).is_err());
        assert!(!held.is_held());
    }
}
