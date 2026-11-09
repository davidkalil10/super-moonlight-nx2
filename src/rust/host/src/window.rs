use std::{collections::VecDeque, time::Duration};

const MAX_SAMPLES: usize = 512;

pub struct VideoWindow {
    fps: u32,
    size: usize,
    needs: VecDeque<usize>,
    samples_ms: Vec<f64>,
}
impl VideoWindow {
    pub fn new(fps: u32) -> Option<Self> {
        if !(1..=120).contains(&fps) {
            return None;
        }
        let initial = window_for(30.0, fps);
        Some(Self {
            fps,
            size: initial,
            needs: VecDeque::from([initial]),
            samples_ms: Vec::new(),
        })
    }
    pub fn size(&self) -> usize {
        self.size
    }
    pub fn sample(&mut self, elapsed: Duration) {
        if self.samples_ms.len() == MAX_SAMPLES {
            self.samples_ms.remove(0);
        }
        self.samples_ms.push(elapsed.as_secs_f64() * 1000.0);
    }
    pub fn adapt(&mut self) -> usize {
        let minimum = 4usize.max((self.fps as f64 / 10.0).round() as usize);
        if self.samples_ms.len() >= minimum {
            self.samples_ms.sort_by(f64::total_cmp);
            let index = ((self.samples_ms.len() as f64 * 0.9).ceil() as usize).saturating_sub(1);
            let p90 = (self.samples_ms[index] * 100.0).round() / 100.0;
            self.needs.push_back(window_for(p90, self.fps));
            if self.needs.len() > 5 {
                self.needs.pop_front();
            }
            self.size = *self.needs.iter().max().expect("window needs");
        }
        self.samples_ms.clear();
        self.size
    }
}
fn window_for(ms: f64, fps: u32) -> usize {
    (((ms * f64::from(fps) / 1000.0).ceil() as usize) + 1).clamp(2, 8)
}
