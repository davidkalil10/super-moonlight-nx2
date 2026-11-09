extern crate alloc;

use crate::{
    device::log,
    owner_call,
    render::native::{NativeMemory, NativeOwner},
    sdk,
};
use alloc::{
    alloc::{alloc_zeroed, dealloc},
    format,
};
use core::{
    alloc::Layout,
    marker::PhantomData,
    mem::ManuallyDrop,
    ptr::NonNull,
    sync::atomic::{AtomicBool, Ordering},
};
use moonlight_nx2_core::{
    codec::Codec,
    decoder::{Backend, BackendError, Backing, Config, FrameRegistration},
    untile,
    video_wire::{self as wire, Fence, Message, Output, Reply},
};

static ACTIVE: AtomicBool = AtomicBool::new(false);
static RETIRED: AtomicBool = AtomicBool::new(false);

struct Memory {
    pointer: NonNull<u8>,
    layout: Layout,
}

impl Memory {
    fn new(bytes: usize, alignment: usize) -> Result<Self, BackendError> {
        let layout =
            Layout::from_size_align(bytes, alignment).map_err(|_| BackendError::Invalid)?;
        let pointer =
            NonNull::new(unsafe { alloc_zeroed(layout) }).ok_or(BackendError::NoMemory)?;
        Ok(Self { pointer, layout })
    }
    fn address(&self) -> u64 {
        self.pointer.as_ptr() as u64
    }
    fn pointer(&self) -> *mut core::ffi::c_void {
        self.pointer.as_ptr().cast()
    }
    fn bytes(&self) -> usize {
        self.layout.size()
    }
    fn cpu_bytes_mut(&mut self) -> &mut [u8] {
        unsafe { core::slice::from_raw_parts_mut(self.pointer.as_ptr(), self.bytes()) }
    }
}

impl Drop for Memory {
    fn drop(&mut self) {
        unsafe { dealloc(self.pointer.as_ptr(), self.layout) };
    }
}

struct Surface {
    memory: Option<NativeMemory>,
    memory_id: Option<u32>,
    image: Option<u32>,
    fence: Option<Fence>,
    descriptor: [u8; 128],
    cpu_read: bool,
}

impl Default for Surface {
    fn default() -> Self {
        Self {
            memory: None,
            memory_id: None,
            image: None,
            fence: None,
            descriptor: [0; 128],
            cpu_read: false,
        }
    }
}

struct Resources {
    surfaces: [Surface; 2],
    inputs: [Option<Memory>; 2],
    workspace: Option<Memory>,
    mime: Option<Memory>,
}

impl Default for Resources {
    fn default() -> Self {
        Self {
            surfaces: core::array::from_fn(|_| Surface::default()),
            inputs: [None, None],
            workspace: None,
            mime: None,
        }
    }
}

pub struct NativeVideo {
    owner: ManuallyDrop<NativeOwner>,
    resources: ManuallyDrop<Resources>,
    resources_dropped: bool,
    sync: sdk::Sync,
    transfer: sdk::TransferMemory,
    root: bool,
    sync_open: bool,
    context: Option<u32>,
    service: Option<u32>,
    precheck: bool,
    initialized: bool,
    started: bool,
    transfer_open: bool,
    donated: bool,
    claimed: bool,
    uncertain: bool,
    in_flight: usize,
    config: Option<Config>,
    next_input: usize,
    reply: [u8; 256],
    not_send: PhantomData<*mut ()>,
}

impl NativeVideo {
    pub(crate) fn new(owner: NativeOwner) -> Self {
        Self {
            owner: ManuallyDrop::new(owner),
            resources: ManuallyDrop::new(Resources::default()),
            resources_dropped: false,
            sync: sdk::Sync::default(),
            transfer: sdk::TransferMemory::default(),
            root: false,
            sync_open: false,
            context: None,
            service: None,
            precheck: false,
            initialized: false,
            started: false,
            transfer_open: false,
            donated: false,
            claimed: false,
            uncertain: false,
            in_flight: 0,
            config: None,
            next_input: 0,
            reply: [0; 256],
            not_send: PhantomData,
        }
    }

    fn unknown(&mut self) -> BackendError {
        self.uncertain = true;
        RETIRED.store(true, Ordering::Release);
        sdk::retire_process();
        BackendError::Uncertain
    }

    fn result(&mut self, stage: &str, result: u32) -> Result<(), BackendError> {
        log(&format!("native-video: {stage} result=0x{result:x}"));
        if result == 0 {
            return Ok(());
        }
        Err(self.unknown())
    }

    fn root_handle(&self) -> Result<u32, BackendError> {
        let root = unsafe { sdk::gsvGetServiceSession() };
        if root.is_null() {
            return Err(BackendError::Invalid);
        }
        let session = unsafe { (*root).session };
        if session == 0 {
            Err(BackendError::Invalid)
        } else {
            Ok(session)
        }
    }

    fn active(&self) -> Result<(), BackendError> {
        if self.uncertain || sdk::process_retired() {
            Err(BackendError::Uncertain)
        } else if !self.started {
            Err(BackendError::Invalid)
        } else {
            Ok(())
        }
    }

    fn exchange(
        &mut self,
        stage: &str,
        session: u32,
        message: Message,
        words: u32,
        moved: bool,
    ) -> Result<Reply<'_>, BackendError> {
        log(&format!("native-video: before {stage}"));
        let bytes = message.bytes();
        let tls = sdk::tls();
        let result = owner_call::call(|| unsafe {
            core::ptr::copy_nonoverlapping(bytes.as_ptr(), tls, bytes.len());
            let raw = sdk::svcSendSyncRequest(session);
            core::ptr::copy_nonoverlapping(tls, self.reply.as_mut_ptr(), self.reply.len());
            raw
        })?;
        if result != 0 {
            log(&format!("native-video: {stage} kernel=0x{result:x}"));
            return Err(self.unknown());
        }
        let wire = u16::from_le_bytes(message.storage()[..2].try_into().unwrap());
        let parsed = Reply::parse(&self.reply, wire, words, moved);
        let Ok(parsed) = parsed else {
            return Err(self.unknown());
        };
        let result = parsed.result;
        log(&format!("native-video: {stage} service=0x{result:x}"));
        if result != 0 {
            return Err(self.unknown());
        }
        Reply::parse(&self.reply, wire, words, moved).map_err(|_| BackendError::Malformed)
    }

    fn open_context(&mut self) -> Result<(), BackendError> {
        let root = self.root_handle()?;
        self.exchange("decoder precheck", root, Message::empty(917), 1, false)?;
        self.precheck = true;
        let context = self
            .exchange(
                "decoder context",
                root,
                Message::decoder_context(0),
                1,
                true,
            )?
            .moved_handle;
        let Some(context) = context.filter(|handle| *handle != 0) else {
            return Err(self.unknown());
        };
        self.context = Some(context);
        let service = self
            .exchange("decoder service", context, Message::empty(17), 1, true)?
            .moved_handle;
        let Some(service) = service.filter(|handle| *handle != 0 && *handle != context) else {
            return Err(self.unknown());
        };
        self.service = Some(service);
        Ok(())
    }

    fn surface_sizes(&mut self, config: Config) -> Result<(usize, usize), BackendError> {
        let reply = self.exchange(
            "image pool size",
            self.root_handle()?,
            Message::pool(config.coded, 1, None),
            5,
            false,
        )?;
        let bytes = u64::from_le_bytes(reply.data[..8].try_into().unwrap());
        let alignment = u64::from_le_bytes(reply.data[8..16].try_into().unwrap());
        if bytes < config.coded.nv12_bytes() as u64
            || bytes > 64 << 20
            || !alignment.is_power_of_two()
            || alignment > 64 << 20
        {
            return Err(self.unknown());
        }
        let minimum = if config.backing == Backing::NativeGpu {
            0x10000
        } else {
            0x1000
        };
        let alignment = alignment.max(minimum) as usize;
        let bytes = (bytes as usize)
            .checked_add(alignment - 1)
            .ok_or(BackendError::Invalid)?
            & !(alignment - 1);
        Ok((bytes, alignment))
    }

    fn create_surface(
        &mut self,
        index: usize,
        bytes: usize,
        alignment: usize,
        _uncached: bool,
        config: Config,
    ) -> Result<(), BackendError> {
        self.resources.surfaces[index].memory = Some(self.owner.allocate(bytes, alignment)?);
        let memory = self.resources.surfaces[index].memory.as_ref().unwrap();
        let info = memory.info;
        log(&format!("native-video: surface{index} backing {info:?}"));
        unsafe { sdk::armDCacheFlush(memory.pointer(), bytes) };
        let mut memory_id = 0;
        let raw = owner_call::call(|| unsafe {
            sdk::gsvReserveImageMemory(3, bytes as u64, &mut memory_id)
        })?;
        self.result("reserve native surface type3", raw)?;
        if memory_id == 0 {
            return Err(self.unknown());
        }
        self.resources.surfaces[index].memory_id = Some(memory_id);
        let raw = owner_call::call(|| unsafe {
            sdk::gsvRegisterImageMemory(
                memory_id,
                info.cpu_address,
                bytes as u64,
                info.memory_handle,
                info.relative_offset,
            )
        })?;
        self.result("attach existing renderer backing", raw)?;
        let reply = self.exchange(
            "create NV12 image pool",
            self.root_handle()?,
            Message::pool(config.coded, 1, Some(memory_id)),
            2,
            false,
        )?;
        let image = u32::from_le_bytes(reply.data[..4].try_into().unwrap());
        if image == 0 {
            return Err(self.unknown());
        }
        self.resources.surfaces[index].image = Some(image);
        Ok(())
    }

    fn open_service(&mut self, config: Config) -> Result<(), BackendError> {
        let bytes = match config.codec {
            Codec::H264 => 64 * 1024 * 1024,
            Codec::Av1 => wire::av1_workspace_bytes(config.display) as usize,
            _ => return Err(BackendError::Unsupported),
        };
        self.resources.workspace = Some(Memory::new(bytes, 0x1000)?);
        let pointer = self.resources.workspace.as_ref().unwrap().pointer();
        let result = unsafe { sdk::tmemCreateFromMemory(&mut self.transfer, pointer, bytes, 0) };
        self.result("workspace transfer", result)?;
        self.transfer_open = true;
        self.donated = true;
        let service = self.service.unwrap();
        self.exchange(
            "decoder initialize",
            service,
            Message::initialize(
                self.transfer.handle,
                bytes as u64,
                if config.codec == Codec::H264 { 0 } else { 3 },
            ),
            1,
            false,
        )?;
        self.initialized = true;
        let mut mime = Memory::new(0x1000, 0x1000)?;
        let mime_bytes: &[u8] = if config.codec == Codec::H264 {
            b"video/avc\0"
        } else {
            b"video/av1\0"
        };
        mime.cpu_bytes_mut()[..mime_bytes.len()].copy_from_slice(mime_bytes);
        let address = mime.address();
        self.resources.mime = Some(mime);
        let message =
            Message::configure(address, 10, config.coded).map_err(|_| BackendError::Invalid)?;
        self.exchange("decoder configure", service, message, 1, false)?;
        for index in 0..2 {
            let image = self.resources.surfaces[index].image.unwrap();
            let reply = self.exchange(
                "register image",
                service,
                Message::image(327, image),
                5,
                false,
            )?;
            let fence = Fence::parse(&reply).map_err(|_| self.unknown())?;
            log(&format!(
                "native-video: image{index} initial fence {fence:?}"
            ));
            self.resources.surfaces[index].fence = Some(fence);
        }
        self.exchange("decoder start", service, Message::empty(22), 1, false)?;
        self.started = true;
        Ok(())
    }

    fn close_surface(&mut self, index: usize) -> Result<(), BackendError> {
        if let Some(image) = self.resources.surfaces[index].image {
            self.exchange(
                "destroy NV12 image pool",
                self.root_handle()?,
                Message::image(928, image),
                0,
                false,
            )?;
            self.resources.surfaces[index].image = None;
        }
        if let Some(memory) = self.resources.surfaces[index].memory_id {
            let raw = owner_call::call(|| unsafe { sdk::gsvReleaseImageMemory(memory) })?;
            self.result("release native image memory", raw)?;
            self.resources.surfaces[index].memory_id = None;
        }
        if let Some(memory) = self.resources.surfaces[index].memory.take() {
            memory.close()?;
        }
        Ok(())
    }

    fn close_workspace(&mut self) -> Result<(), BackendError> {
        if self.transfer_open {
            let result = unsafe { sdk::tmemCloseHandle(&mut self.transfer) };
            self.result("close workspace handle", result)?;
            self.transfer_open = false;
        }
        if self.donated {
            let address = self.resources.workspace.as_ref().unwrap().address();
            for _ in 0..100 {
                let mut info = sdk::MemoryInfo::default();
                let mut page = 0;
                let result = unsafe { sdk::svcQueryMemory(&mut info, &mut page, address) };
                if result == 0 && info.permission & 3 == 3 {
                    self.donated = false;
                    break;
                }
                unsafe { sdk::svcSleepThread(1_000_000) };
            }
            if self.donated {
                return Err(self.unknown());
            }
        }
        self.resources.workspace = None;
        Ok(())
    }
}

impl Backend for NativeVideo {
    fn capabilities() -> moonlight_nx2_core::codec::Capabilities {
        use moonlight_nx2_core::codec::{Capabilities, Depth, Evidence, Mode, Size};
        let mut capabilities = Capabilities::default();
        capabilities.record(
            Mode {
                codec: Codec::H264,
                depth: Depth::Eight,
                maximum: Size::new(1920, 1080).unwrap(),
                fps: 60,
            },
            Evidence::PixelsAndCloseVerified,
        );
        capabilities
    }

    fn open(&mut self, config: Config) -> Result<[u32; 2], BackendError> {
        if !matches!(config.codec, Codec::H264 | Codec::Av1) || config.backing != Backing::NativeGpu
        {
            return Err(BackendError::Unsupported);
        }
        if RETIRED.load(Ordering::Acquire) || sdk::process_retired() {
            return Err(BackendError::Uncertain);
        }
        if self.resources_dropped
            || self.claimed
            || ACTIVE
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return Err(BackendError::Refused);
        }
        self.claimed = true;
        self.config = Some(config);
        let result = unsafe { sdk::gsvInitialize() };
        self.result("root initialize", result)?;
        self.root = true;
        let result = unsafe { sdk::gsvOpenSync(&mut self.sync) };
        self.result("sync", result)?;
        self.sync_open = true;
        let permitted = sdk::permitted_frame_mode().ok_or(BackendError::Invalid)?;
        if let FrameRegistration::Observed(mode) = config.frame_registration {
            if mode != permitted {
                return Err(BackendError::Invalid);
            }
        }
        self.open_context()?;
        let (bytes, alignment) = self.surface_sizes(config)?;
        for index in 0..2 {
            self.create_surface(index, bytes, alignment, permitted & 2 != 0, config)?;
        }
        for index in 0..2 {
            self.resources.inputs[index] = Some(Memory::new(wire::INPUT_MAX as usize, 0x1000)?);
        }
        self.open_service(config)?;
        Ok(core::array::from_fn(|index| {
            self.resources.surfaces[index].image.unwrap()
        }))
    }

    fn submit(&mut self, bytes: &[u8], pts_us: u64) -> Result<(), BackendError> {
        self.active()?;
        if !self.started || bytes.is_empty() || bytes.len() > wire::INPUT_MAX as usize {
            return Err(BackendError::Invalid);
        }
        if self.in_flight == 2 {
            return Err(BackendError::Refused);
        }
        let input = self.resources.inputs[self.next_input].as_mut().unwrap();
        input.cpu_bytes_mut()[..bytes.len()].copy_from_slice(bytes);
        let address = input.address();
        unsafe { sdk::armDCacheFlush(input.pointer(), bytes.len()) };
        self.next_input = (self.next_input + 1) % 2;
        let message = Message::submit(address, bytes.len() as u32, pts_us, false)
            .map_err(|_| BackendError::Invalid)?;
        self.exchange("submit", self.service.unwrap(), message, 1, false)?;
        self.in_flight += 1;
        Ok(())
    }

    fn ready(&mut self, surface: usize) -> Result<bool, BackendError> {
        self.active()?;
        let fence = self
            .resources
            .surfaces
            .get(surface)
            .and_then(|surface| surface.fence)
            .ok_or(BackendError::Invalid)?;
        let mut value = 0;
        let mut mode = 0;
        let result = owner_call::call(|| unsafe {
            sdk::gsvSyncReadCounter(&mut self.sync, fence.counter, &mut value, &mut mode)
        })?;
        self.result("read counter", result)?;
        if u32::from(mode) != fence.mode {
            log(&format!(
                "native-video: counter mode mismatch fence={fence:?} mode={mode} value={value}"
            ));
            return Err(self.unknown());
        }
        Ok(fence.reached(value))
    }

    fn output(&mut self) -> Result<Output, BackendError> {
        self.active()?;
        let reply = self.exchange(
            "output",
            self.service.ok_or(BackendError::Invalid)?,
            Message::empty(229),
            11,
            false,
        )?;
        Output::parse(&reply).map_err(|_| self.unknown())
    }

    fn readback(&mut self, index: usize, out: &mut [u8]) -> Result<(), BackendError> {
        if !self.ready(index)? {
            return Err(BackendError::Invalid);
        }
        let config = self.config.ok_or(BackendError::Invalid)?;
        if out.len() < config.coded.nv12_bytes() {
            return Err(BackendError::Invalid);
        }
        let image = self
            .resources
            .surfaces
            .get(index)
            .and_then(|surface| surface.image)
            .ok_or(BackendError::Invalid)?;
        let reply = self.exchange(
            "image descriptor",
            self.root_handle()?,
            Message::image(977, image),
            33,
            false,
        )?;
        let descriptor: [u8; 128] = reply.data[..128].try_into().unwrap();
        log(&format!(
            "native-video: surface{index} descriptor {descriptor:02x?}"
        ));
        self.resources.surfaces[index].descriptor = descriptor;
        let layout = match untile::Image::decode(&descriptor) {
            Ok(layout) => layout,
            Err(untile::Error::Unsupported) => return Err(BackendError::Unsupported),
            Err(untile::Error::Invalid) => return Err(self.unknown()),
        };
        let memory = self.resources.surfaces[index].memory.as_ref().unwrap();
        unsafe { sdk::armDCacheFlush(memory.pointer(), memory.bytes()) };
        let bytes = config.coded.width() as usize * config.coded.height() as usize;
        let (luma, chroma) = out[..config.coded.nv12_bytes()].split_at_mut(bytes);
        let copied = layout
            .luma
            .copy(
                memory.cpu_bytes(),
                config.coded.width(),
                config.coded.height(),
                luma,
                config.coded.width(),
            )
            .and_then(|()| {
                layout.chroma.copy(
                    memory.cpu_bytes(),
                    config.coded.width(),
                    config.coded.height() / 2,
                    chroma,
                    config.coded.width(),
                )
            });
        copied.map_err(|_| self.unknown())?;
        self.resources.surfaces[index].cpu_read = true;
        Ok(())
    }

    fn release(&mut self, index: usize) -> Result<(), BackendError> {
        self.active()?;
        if self.in_flight == 0
            || !self
                .resources
                .surfaces
                .get(index)
                .is_some_and(|surface| surface.cpu_read)
        {
            return Err(BackendError::Invalid);
        }
        let image = self
            .resources
            .surfaces
            .get(index)
            .and_then(|surface| surface.image)
            .ok_or(BackendError::Invalid)?;
        let reply = self.exchange(
            "release image",
            self.service.ok_or(BackendError::Invalid)?,
            Message::image(330, image),
            5,
            false,
        )?;
        let fence = Fence::parse(&reply).map_err(|_| self.unknown())?;
        self.resources.surfaces[index].fence = Some(fence);
        self.resources.surfaces[index].cpu_read = false;
        self.in_flight -= 1;
        Ok(())
    }

    fn close(&mut self) -> Result<(), BackendError> {
        if self.uncertain || sdk::process_retired() {
            return Err(self.unknown());
        }
        if self.in_flight != 0 {
            log(&format!(
                "native-video: close retains {} uncompleted units",
                self.in_flight
            ));
            return Err(self.unknown());
        }
        let result = (|| {
            if self.resources_dropped {
                return Ok(());
            }
            if self.started {
                self.exchange("stop", self.service.unwrap(), Message::empty(223), 1, false)?;
                self.started = false;
            }
            if self.initialized {
                self.exchange(
                    "finalize",
                    self.service.unwrap(),
                    Message::empty(131),
                    0,
                    false,
                )?;
                self.initialized = false;
            }
            for index in (0..2).rev() {
                self.close_surface(index)?;
            }
            if let Some(service) = self.service {
                let result = unsafe { sdk::svcCloseHandle(service) };
                self.result("close service", result)?;
                self.service = None;
            }
            self.close_workspace()?;
            if let Some(context) = self.context {
                let result = unsafe { sdk::svcCloseHandle(context) };
                self.result("close context", result)?;
                self.context = None;
            }
            if self.precheck {
                self.exchange(
                    "root finalize",
                    self.root_handle()?,
                    Message::empty(919),
                    0,
                    false,
                )?;
                self.precheck = false;
            }
            if self.sync_open {
                unsafe { sdk::gsvSyncClose(&mut self.sync) };
                self.sync_open = false;
            }
            if self.root {
                unsafe { sdk::gsvExit() };
                self.root = false;
            }
            unsafe {
                ManuallyDrop::drop(&mut self.resources);
                ManuallyDrop::drop(&mut self.owner)
            };
            self.resources_dropped = true;
            if self.claimed {
                ACTIVE.store(false, Ordering::Release);
                self.claimed = false;
            }
            Ok(())
        })();
        if result.is_err() {
            sdk::retire_process();
        }
        result
    }

    fn now_ms(&self) -> u64 {
        (unsafe { sdk::moonlightNowNs() }) / 1_000_000
    }
}

impl Drop for NativeVideo {
    fn drop(&mut self) {
        if !self.resources_dropped {
            if self.claimed {
                RETIRED.store(true, Ordering::Release);
                sdk::retire_process();
                log("native-video: live resources retained; exit process");
            } else {
                unsafe {
                    ManuallyDrop::drop(&mut self.resources);
                    ManuallyDrop::drop(&mut self.owner)
                };
            }
        }
    }
}
