//! What a launch and its RTSP handshake settle, handed to the media and control paths.

/// The AES-128 key and key id sent as `rikey` and `rikeyid` with `/launch` or `/resume`.
/// Control messages use the key with AES-GCM; audio, and video when enabled, use it too.
#[derive(Clone, PartialEq, Eq)]
pub struct StreamKey {
    pub key: [u8; 16],
    pub key_id: u32,
}

impl core::fmt::Debug for StreamKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("StreamKey")
            .field("key_id", &self.key_id)
            .finish_non_exhaustive()
    }
}

impl Drop for StreamKey {
    fn drop(&mut self) {
        for byte in &mut self.key {
            unsafe { core::ptr::write_volatile(byte, 0) };
        }
    }
}

/// `x-nv-vqos[0].bitStreamFormat`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    H264 = 0,
    Hevc = 1,
    Av1 = 2,
}

/// Bits of `x-ss-general.encryptionEnabled`.
pub mod encryption {
    pub const CONTROL_V2: u32 = 0x01;
    pub const VIDEO: u32 = 0x02;
    pub const AUDIO: u32 = 0x04;
}

/// What the console asks for in `/launch` and the RTSP ANNOUNCE.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Request {
    pub width: u16,
    pub height: u16,
    pub fps: u16,
    pub bitrate_kbps: u32,
    /// Video RTP payload bytes per packet, without the IP and UDP headers.
    pub packet_size: u16,
    /// Codecs the console decodes, best first; the first one the host offers wins.
    pub codecs: &'static [Codec],
    pub hdr: bool,
    /// 2, 6 or 8.
    pub audio_channels: u8,
    /// Gamepads present at launch, one bit each.
    pub controllers: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Audio {
    pub channels: u8,
    pub channel_mask: u16,
    /// Opus frame length; 5 or 10 ms.
    pub packet_duration_ms: u8,
    pub high_quality: bool,
    /// Opus multistream layout from DESCRIBE's `surround-params`, when the host sent one.
    pub streams: u8,
    pub coupled_streams: u8,
    pub mapping: [u8; 8],
}

/// Everything the media path needs once PLAY succeeded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Negotiated {
    pub host: [u8; 4],
    pub video_port: u16,
    pub audio_port: u16,
    pub control_port: u16,
    /// `X-SS-Ping-Payload` from each SETUP: send it to the port so the host learns ours.
    pub video_ping: Option<[u8; 16]>,
    pub audio_ping: Option<[u8; 16]>,
    /// `X-SS-Connect-Data` from the control SETUP, carried in the ENet connect.
    pub control_connect: u32,
    pub key: StreamKey,
    /// `encryption` bits both sides agreed on.
    pub encryption: u32,
    pub codec: Codec,
    pub width: u16,
    pub height: u16,
    pub fps: u16,
    pub hdr: bool,
    pub packet_size: u16,
    /// What ANNOUNCE asked; the per-frame FEC shape travels in each video packet header.
    pub min_fec_packets: u8,
    pub audio: Audio,
}

impl Negotiated {
    pub fn video_encrypted(&self) -> bool {
        self.encryption & encryption::VIDEO != 0
    }

    pub fn audio_encrypted(&self) -> bool {
        self.encryption & encryption::AUDIO != 0
    }
}
