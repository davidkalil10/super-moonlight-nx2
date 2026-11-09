pub const CAPACITY: usize = 32;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    InvalidPolicy,
    ClockWentBackwards,
    InvalidFormat,
}

#[derive(Clone, Copy, Debug)]
pub struct Policy {
    chunk_us: u64,
    target_us: u64,
    burst_us: u64,
    window_us: u64,
    output_us: u64,
}

impl Policy {
    pub fn new(
        chunk_us: u64,
        target_us: u64,
        burst_us: u64,
        window_us: u64,
        output_us: u64,
    ) -> Result<Self, Error> {
        let capacity_us = chunk_us
            .checked_mul(CAPACITY as u64)
            .ok_or(Error::InvalidPolicy)?;
        let twice = chunk_us.checked_mul(2).ok_or(Error::InvalidPolicy)?;
        let output_ok = output_us >= twice && output_us <= capacity_us;
        let target_ok = target_us >= output_us && target_us <= capacity_us;
        let burst_ok = burst_us >= target_us && burst_us <= capacity_us.saturating_sub(chunk_us);
        let window_ok = (50_000..=10_000_000).contains(&window_us);
        if chunk_us == 0
            || capacity_us > i64::MAX as u64
            || !output_ok
            || !target_ok
            || !burst_ok
            || !window_ok
        {
            return Err(Error::InvalidPolicy);
        }
        Ok(Self {
            chunk_us,
            target_us,
            burst_us,
            window_us,
            output_us,
        })
    }
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            chunk_us: 10_000,
            target_us: 20_000,
            burst_us: 70_000,
            window_us: 500_000,
            output_us: 20_000,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Stats {
    pub dropped: u64,
    pub cuts: u64,
    pub depth_us: u64,
    pub max_depth_us: u64,
}

#[derive(Debug, Default, Eq, PartialEq)]
pub struct Step {
    dropped: [u8; CAPACITY],
    dropped_count: usize,
    appended: [u8; CAPACITY],
    appended_count: usize,
}

impl Step {
    pub fn dropped(&self) -> &[u8] {
        &self.dropped[..self.dropped_count]
    }
    pub fn appended(&self) -> &[u8] {
        &self.appended[..self.appended_count]
    }
}

struct Window {
    started_us: u64,
    lowest_us: u64,
}

pub struct Queue {
    policy: Policy,
    waiting: [u8; CAPACITY],
    head: usize,
    count: usize,
    output: usize,
    window: Option<Window>,
    last_us: Option<u64>,
    stats: Stats,
}

impl Queue {
    pub fn new(policy: Policy) -> Self {
        Self {
            policy,
            waiting: [0; CAPACITY],
            head: 0,
            count: 0,
            output: 0,
            window: None,
            last_us: None,
            stats: Stats::default(),
        }
    }

    pub fn push(&mut self, item: u8) -> bool {
        if self.count + self.output >= CAPACITY {
            return false;
        }
        self.waiting[(self.head + self.count) % CAPACITY] = item;
        self.count += 1;
        true
    }

    pub fn release(&mut self) -> bool {
        if self.output == 0 {
            return false;
        }
        self.output -= 1;
        true
    }

    pub fn output_count(&self) -> usize {
        self.output
    }
    pub fn stats(&self) -> Stats {
        self.stats
    }

    fn depth(&self) -> u64 {
        (self.count + self.output) as u64 * self.policy.chunk_us
    }

    fn take(&mut self) -> u8 {
        let item = self.waiting[self.head];
        self.head = (self.head + 1) % CAPACITY;
        self.count -= 1;
        item
    }

    fn drop_to(&mut self, limit_us: u64, step: &mut Step) {
        let excess = self.depth().saturating_sub(limit_us) / self.policy.chunk_us;
        let count = excess.min(self.count as u64) as usize;
        if count == 0 {
            return;
        }
        self.stats.dropped += count as u64;
        self.stats.cuts += 1;
        for _ in 0..count {
            step.dropped[step.dropped_count] = self.take();
            step.dropped_count += 1;
        }
    }

    fn restart_window(&mut self, now_us: u64) {
        self.window = Some(Window {
            started_us: now_us,
            lowest_us: u64::MAX,
        });
    }

    pub fn step(&mut self, now_us: u64) -> Result<Step, Error> {
        if self.last_us.is_some_and(|previous| now_us < previous) {
            return Err(Error::ClockWentBackwards);
        }
        self.last_us = Some(now_us);
        let mut step = Step::default();
        let current = self.depth();
        self.stats.depth_us = current;
        self.stats.max_depth_us = self.stats.max_depth_us.max(current);
        let window = self.window.get_or_insert(Window {
            started_us: now_us,
            lowest_us: u64::MAX,
        });
        window.lowest_us = window.lowest_us.min(current);

        if current > self.policy.burst_us {
            self.drop_to(self.policy.target_us, &mut step);
            self.restart_window(now_us);
        } else if now_us - window.started_us >= self.policy.window_us {
            let standing = window.lowest_us.saturating_sub(self.policy.target_us);
            if standing > 0 {
                self.drop_to(current - standing, &mut step);
            }
            self.restart_window(now_us);
        }
        while self.count > 0
            && (self.output + 1) as u64 * self.policy.chunk_us <= self.policy.output_us
        {
            step.appended[step.appended_count] = self.take();
            step.appended_count += 1;
            self.output += 1;
        }
        self.stats.depth_us = self.depth();
        Ok(step)
    }
}

pub fn crossfade(from: &[u8], to: &mut [u8], frames: u32, channels: u32) -> Result<(), Error> {
    if channels == 0 || channels > 8 {
        return Err(Error::InvalidFormat);
    }
    let requested = (frames as usize)
        .checked_mul(channels as usize)
        .ok_or(Error::InvalidFormat)?;
    let samples = requested.min(from.len() / 2).min(to.len() / 2);
    for (index, output) in to
        .as_chunks_mut::<2>()
        .0
        .iter_mut()
        .take(samples)
        .enumerate()
    {
        let start = i16::from_le_bytes(from[index * 2..index * 2 + 2].try_into().unwrap());
        let end = i16::from_le_bytes(*output);
        let weight = (index / channels as usize + 1) as f64 / (f64::from(frames) + 1.0);
        let blended = f64::from(start) + (f64::from(end) - f64::from(start)) * weight + 0.5;
        let truncated = blended as i32;
        let rounded = if blended < f64::from(truncated) {
            truncated - 1
        } else {
            truncated
        };
        output.copy_from_slice(&(rounded as i16).to_le_bytes());
    }
    Ok(())
}
