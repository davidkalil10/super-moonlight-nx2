#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StreamStats {
    pub window_ms: u32,
    pub fps_x10: u32,
    pub decode_mean_us: u32,
    pub decode_max_us: u32,
    pub latency_mean_us: u32,
    pub latency_max_us: u32,
    pub input_mean_us: u32,
    pub input_max_us: u32,
    pub presented: u32,
    pub dropped: u32,
    pub zero_copy: bool,
}
