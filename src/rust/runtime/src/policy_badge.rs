//! Maps session policy feedback to the on-screen statistics badge.

use moonlight_nx2_app::policy::{Epoch, Feedback};
use moonlight_nx2_ui::{badge, glyphs::Glyphs};

#[derive(Default)]
pub(crate) struct Badge {
    epoch: Option<Epoch>,
    controller: Option<badge::Controller>,
}

impl Badge {
    pub fn invalidate(&mut self) {
        self.epoch = None;
    }

    pub fn failure(&self) -> Option<&'static str> {
        self.controller
            .as_ref()
            .and_then(badge::Controller::failure)
    }

    pub fn apply(
        &mut self,
        glyphs: &mut Glyphs,
        storage: &mut [u8; badge::STORAGE_BYTES],
        active: Option<Epoch>,
        feedback: Feedback,
    ) -> bool {
        let epoch = match feedback {
            Feedback::Metrics { epoch, .. } | Feedback::Badge { epoch, .. } => epoch,
            Feedback::Reconfigure { .. } => return false,
        };
        if active != Some(epoch) {
            return false;
        }
        match feedback {
            Feedback::Badge {
                text,
                duration_ms,
                frame_counter,
                ..
            } => {
                self.stop(storage);
                if !text.as_str().is_empty() || frame_counter {
                    let mut controller =
                        badge::Controller::start(text.as_str(), duration_ms, frame_counter);
                    controller.show(glyphs, storage);
                    self.controller = Some(controller);
                    self.epoch = Some(epoch);
                }
            }
            Feedback::Metrics { report, .. } => {
                if self.epoch == Some(epoch)
                    && let Some(controller) = &mut self.controller
                {
                    let second = report.second;
                    controller.stats(
                        glyphs,
                        storage,
                        i64::from(second.presented),
                        i64::from(second.caught_up),
                        i64::from(second.dropped_total),
                        Some(second.console_ms()),
                    );
                }
            }
            Feedback::Reconfigure { .. } => unreachable!(),
        }
        true
    }

    pub fn frame(
        &mut self,
        glyphs: &mut Glyphs,
        storage: &mut [u8; badge::STORAGE_BYTES],
        active: Option<Epoch>,
        now_ns: u64,
    ) {
        if self.epoch.is_none() || self.epoch != active {
            self.stop(storage);
        } else if let Some(controller) = &mut self.controller {
            controller.frame(glyphs, storage, now_ns);
        }
    }

    pub fn stop(&mut self, storage: &mut [u8; badge::STORAGE_BYTES]) {
        if let Some(controller) = &mut self.controller {
            controller.stop(storage);
        }
        self.controller = None;
        self.epoch = None;
    }
}
