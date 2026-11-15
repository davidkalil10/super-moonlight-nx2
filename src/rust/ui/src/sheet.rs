//! The stream menu's option rows: their order, where each sits and how far the list scrolls.

use crate::model::item;
use alloc::vec::Vec;

pub(crate) const TOP: u32 = 350;
pub(crate) const BOTTOM: u32 = 916;
pub(crate) const ROW: u32 = 84;
pub(crate) const GAP: u32 = 21;
/// Disconnect and Quit sit apart from the rows above them.
const GROUP_GAP: u32 = 2 * GAP;
/// Room past a revealed row, so the next one peeks in when there is more.
pub(crate) const EDGE: u32 = GAP + 41;
const VIEW: u32 = BOTTOM - TOP;

/// The rows in order: the stream's own options first, then leaving it.
pub(crate) fn rows(virtual_pad: bool, sensitivity: Option<u32>) -> Vec<u32> {
    let mut rows = Vec::from([
        item::RESUME_STREAM,
        item::SHOW_KEYBOARD,
        item::TOGGLE_STATS,
        item::TOGGLE_JOYCON_MOUSE,
    ]);
    rows.extend(sensitivity);
    if virtual_pad {
        rows.push(item::TOGGLE_VIRTUAL_PAD);
    }
    rows.extend([item::RETURN_TO_APPS, item::QUIT_HOST]);
    rows
}

/// Where row `index` starts, from the top of the list.
pub(crate) fn top(rows: &[u32], index: usize) -> u32 {
    rows.iter()
        .skip(1)
        .take(index)
        .map(|&id| {
            ROW + if id == item::RETURN_TO_APPS {
                GROUP_GAP
            } else {
                GAP
            }
        })
        .sum()
}

fn height(rows: &[u32]) -> u32 {
    rows.len()
        .checked_sub(1)
        .map_or(0, |last| top(rows, last) + ROW)
}

pub(crate) fn clamp(rows: &[u32], scroll: u32) -> u32 {
    scroll.min(height(rows).saturating_sub(VIEW))
}

pub(crate) fn fully_shown(rows: &[u32], scroll: u32, index: usize) -> bool {
    let top = top(rows, index);
    top >= scroll && top + ROW <= scroll + VIEW
}

/// The scroll that shows row `index` whole, moving as little as it can.
pub(crate) fn reveal(rows: &[u32], scroll: u32, index: usize) -> u32 {
    let top = top(rows, index);
    let above = if index > 0 { EDGE } else { 0 };
    let below = if index + 1 < rows.len() { EDGE } else { 0 };
    let scroll = if top < scroll + above {
        top.saturating_sub(above)
    } else if top + ROW + below > scroll + VIEW {
        (top + ROW + below).saturating_sub(VIEW)
    } else {
        scroll
    };
    clamp(rows, scroll)
}

/// One row further down the list for a positive `direction`, up for a negative one.
pub(crate) fn step(rows: &[u32], scroll: u32, direction: i32) -> u32 {
    let scroll = clamp(rows, scroll);
    let shown: Vec<usize> = (0..rows.len())
        .filter(|&index| fully_shown(rows, scroll, index))
        .collect();
    let target = if direction > 0 {
        shown.last().map(|&last| last + 1)
    } else {
        shown.first().and_then(|&first| first.checked_sub(1))
    };
    match target.filter(|&target| target < rows.len()) {
        Some(target) => reveal(rows, scroll, target),
        None => scroll,
    }
}

/// The row whole on screen nearest to `index`, for when `index` scrolled out of view.
pub(crate) fn nearest_shown(rows: &[u32], scroll: u32, index: usize) -> usize {
    (0..rows.len())
        .filter(|&row| fully_shown(rows, scroll, row))
        .min_by_key(|&row| row.abs_diff(index))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handheld() -> Vec<u32> {
        rows(true, Some(item::SETTING))
    }

    #[test]
    fn rows_keep_their_spacing_and_set_leaving_apart() {
        let rows = handheld();
        assert_eq!(rows.len(), 8);
        assert_eq!(top(&rows, 1), ROW + GAP);
        assert_eq!(top(&rows, 6) - top(&rows, 5), ROW + GROUP_GAP);
        assert_eq!(rows[6..], [item::RETURN_TO_APPS, item::QUIT_HOST]);
        assert_eq!(rows[4], item::SETTING);
    }

    #[test]
    fn focus_moves_the_list_only_when_the_row_is_not_whole() {
        let rows = handheld();
        assert_eq!(reveal(&rows, 0, 3), 0);
        let down = reveal(&rows, 0, 5);
        assert!(fully_shown(&rows, down, 5));
        assert!(top(&rows, 6) < down + VIEW, "the next row peeks in");
        assert_eq!(reveal(&rows, down, 4), down, "already whole");
        assert_eq!(reveal(&rows, down, 7), clamp(&rows, u32::MAX));
        assert_eq!(reveal(&rows, down, 0), 0);
    }

    #[test]
    fn a_drag_steps_one_row_and_stops_at_the_ends() {
        let rows = handheld();
        let mut scroll = 0;
        let mut steps = 0;
        while step(&rows, scroll, 1) != scroll {
            scroll = step(&rows, scroll, 1);
            steps += 1;
        }
        assert!(fully_shown(&rows, scroll, 7));
        assert!(steps >= 2);
        while step(&rows, scroll, -1) != scroll {
            scroll = step(&rows, scroll, -1);
        }
        assert_eq!(scroll, 0);
        assert_eq!(nearest_shown(&rows, 0, 7), 4);
    }
}
