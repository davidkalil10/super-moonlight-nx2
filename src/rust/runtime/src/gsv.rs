extern crate alloc;

use crate::{device::log, sdk};
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
    fn cpu_bytes(&self) -> &[u8] {
        unsafe { core::slice::from_raw_parts(self.pointer.as_ptr(), self.bytes()) }
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
    memory: Option<Memory>,
    memory_id: Option<u32>,
    gpu_range: Option<u32>,
    image: Option<u32>,
    attribute: bool,
    fence: Option<Fence>,
    descriptor: [u8; 128],
}

impl Default for Surface {
    fn default() -> Self {
        Self {
            memory: None,
            memory_id: None,
            gpu_range: None,
            image: None,
            attribute: false,
            fence: None,
            descriptor: [0; 128],
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

pub struct GsvBackend {
    resources: ManuallyDrop<Resources>,
    resources_dropped: bool,
    sync: sdk::Sync,
    gpu: sdk::Gpu,
    event: sdk::Event,
    transfer: sdk::TransferMemory,
    root: bool,
    sync_open: bool,
    gpu_open: bool,
    event_open: bool,
    client: Option<u8>,
    slot: u32,
    context: Option<u32>,
    service: Option<u32>,
    precheck: bool,
    initialized: bool,
    started: bool,
    transfer_open: bool,
    donated: bool,
    claimed: bool,
    uncertain: bool,
    close_refused: bool,
    config: Option<Config>,
    next_input: usize,
    reply: [u8; 256],
    not_send: PhantomData<*mut ()>,
}

impl Default for GsvBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl GsvBackend {
    pub fn new() -> Self {
        Self {
            resources: ManuallyDrop::new(Resources::default()),
            resources_dropped: false,
            sync: sdk::Sync::default(),
            gpu: sdk::Gpu::default(),
            event: sdk::Event::default(),
            transfer: sdk::TransferMemory::default(),
            root: false,
            sync_open: false,
            gpu_open: false,
            event_open: false,
            client: None,
            slot: 0,
            context: None,
            service: None,
            precheck: false,
            initialized: false,
            started: false,
            transfer_open: false,
            donated: false,
            claimed: false,
            uncertain: false,
            close_refused: false,
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
        log(&format!("gsv: {stage} result=0x{result:x}"));
        if result == 0 {
            return Ok(());
        }
        if result & 0x1ff == 1 {
            return Err(self.unknown());
        }
        Err(BackendError::Refused)
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
        let bytes = message.bytes();
        let tls = sdk::tls();
        unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), tls, bytes.len()) };
        let result = unsafe { sdk::svcSendSyncRequest(session) };
        unsafe { core::ptr::copy_nonoverlapping(tls, self.reply.as_mut_ptr(), self.reply.len()) };
        if result != 0 {
            log(&format!("gsv: {stage} kernel=0x{result:x}"));
            return Err(self.unknown());
        }
        let wire = u16::from_le_bytes(message.storage()[..2].try_into().unwrap());
        let parsed = Reply::parse(&self.reply, wire, words, moved);
        let Ok(parsed) = parsed else {
            return Err(self.unknown());
        };
        let result = parsed.result;
        log(&format!("gsv: {stage} service=0x{result:x}"));
        if result != 0 {
            return Err(BackendError::Refused);
        }
        Reply::parse(&self.reply, wire, words, moved).map_err(|_| BackendError::Malformed)
    }

    fn open_gpu(&mut self) -> Result<(), BackendError> {
        let result = unsafe { sdk::gsvOpenGpu(&mut self.gpu) };
        self.result("GPU", result)?;
        self.gpu_open = true;
        let mut last = 0;
        let result = unsafe { sdk::gsvGpuGetSlotRange(&mut self.gpu, &mut self.slot, &mut last) };
        self.result("GPU slots", result)?;
        if self.slot > last {
            return Err(self.unknown());
        }
        let result =
            unsafe { sdk::gsvGpuCreateSlotEvent(&mut self.gpu, self.slot, &mut self.event, false) };
        self.result("GPU event", result)?;
        self.event_open = true;
        self.exchange(
            "request worker",
            self.gpu.main.session,
            Message::image(37, self.slot),
            1,
            false,
        )?;
        if unsafe { sdk::eventWait(&mut self.event, 1_000_000_000) } != 0 {
            return Err(self.unknown());
        }
        let worker = self
            .exchange(
                "receive worker",
                self.gpu.main.session,
                Message::empty(38),
                1,
                true,
            )?
            .moved_handle;
        let Some(worker) = worker.filter(|handle| *handle != 0 && *handle != self.gpu.main.session)
        else {
            return Err(self.unknown());
        };
        self.gpu.worker.session = worker;
        let mut client = 0;
        let result =
            unsafe { sdk::gsvGpuRegisterClient(&mut self.gpu, 0x6365_6476_6476_6c6d, &mut client) };
        self.result("GPU client", result)?;
        self.client = Some(client);
        Ok(())
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
        uncached: bool,
        config: Config,
    ) -> Result<(), BackendError> {
        self.resources.surfaces[index].memory = Some(Memory::new(bytes, alignment)?);
        let memory = self.resources.surfaces[index].memory.as_ref().unwrap();
        let address = memory.address();
        let pointer = memory.pointer();
        unsafe { sdk::armDCacheFlush(pointer, bytes) };
        if uncached || config.backing == Backing::NativeGpu {
            let result = unsafe { sdk::svcUnknown80(pointer, bytes as u64, 0x20, 0x20) };
            self.result("surface attribute", result)?;
            self.resources.surfaces[index].attribute = true;
        }
        if config.backing == Backing::NativeGpu {
            let mut range = 0;
            let result = unsafe {
                sdk::gsvGpuRegisterMemory(
                    &mut self.gpu,
                    address,
                    bytes as u64,
                    self.client.unwrap(),
                    &mut range,
                )
            };
            self.result("surface GPU range", result)?;
            self.resources.surfaces[index].gpu_range = Some(range);
        }
        let mut memory_id = 0;
        let result = unsafe { sdk::gsvReserveImageMemory(3, bytes as u64, &mut memory_id) };
        self.result("reserve surface", result)?;
        self.resources.surfaces[index].memory_id = Some(memory_id);
        if config.backing == Backing::NativeGpu {
            let range = self.resources.surfaces[index].gpu_range.unwrap();
            let result =
                unsafe { sdk::gsvRegisterImageMemory(memory_id, address, bytes as u64, range, 0) };
            self.result("native surface backing", result)?;
        } else {
            let flags = if self.resources.surfaces[index].attribute {
                2
            } else {
                0
            };
            self.exchange(
                "CPU surface backing",
                self.root_handle()?,
                Message::memory_attach(memory_id, address, bytes as u64, flags),
                1,
                false,
            )?;
        }
        let reply = self.exchange(
            "create image pool",
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
        let bytes = wire::av1_workspace_bytes(config.display) as usize;
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
            Message::initialize(self.transfer.handle, bytes as u64, 3),
            1,
            false,
        )?;
        self.initialized = true;
        let mut mime = Memory::new(0x1000, 0x1000)?;
        mime.cpu_bytes_mut()[..10].copy_from_slice(b"video/av1\0");
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
            self.resources.surfaces[index].fence = Some(fence);
        }
        self.exchange("decoder start", service, Message::empty(22), 1, false)?;
        self.started = true;
        Ok(())
    }

    fn close_surface(&mut self, index: usize) -> Result<(), BackendError> {
        if let Some(image) = self.resources.surfaces[index].image {
            self.exchange(
                "destroy image pool",
                self.root_handle()?,
                Message::image(928, image),
                0,
                false,
            )?;
            self.resources.surfaces[index].image = None;
        }
        if let Some(memory) = self.resources.surfaces[index].memory_id {
            let result = unsafe { sdk::gsvReleaseImageMemory(memory) };
            self.result("release image memory", result)?;
            self.resources.surfaces[index].memory_id = None;
        }
        if let Some(range) = self.resources.surfaces[index].gpu_range {
            if unsafe { sdk::eventClear(&mut self.event) } != 0 {
                return Err(self.unknown());
            }
            let result = unsafe { sdk::gsvGpuUnregisterMemory(&mut self.gpu, range, self.slot) };
            self.result("unregister GPU range", result)?;
            if unsafe { sdk::eventWait(&mut self.event, 1_000_000_000) } != 0 {
                return Err(self.unknown());
            }
            self.resources.surfaces[index].gpu_range = None;
        }
        if self.resources.surfaces[index].attribute {
            let memory = self.resources.surfaces[index].memory.as_ref().unwrap();
            let result =
                unsafe { sdk::svcUnknown80(memory.pointer(), memory.bytes() as u64, 0x20, 0) };
            self.result("reset surface attribute", result)?;
            self.resources.surfaces[index].attribute = false;
        }
        self.resources.surfaces[index].memory = None;
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

impl Backend for GsvBackend {
    fn open(&mut self, config: Config) -> Result<[u32; 2], BackendError> {
        if config.codec != Codec::Av1 {
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
        let permitted = match config.frame_registration {
            FrameRegistration::Register => {
                let mut mode = 0;
                let result = unsafe { sdk::register_frame(2, &mut mode) };
                self.result("frame registration", result)?;
                mode
            }
            FrameRegistration::Observed(mode) => {
                if sdk::permitted_frame_mode() != Some(mode) {
                    return Err(BackendError::Invalid);
                }
                mode
            }
        };
        if config.backing == Backing::NativeGpu {
            self.open_gpu()?;
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
        let input = self.resources.inputs[self.next_input].as_mut().unwrap();
        input.cpu_bytes_mut()[..bytes.len()].copy_from_slice(bytes);
        let address = input.address();
        self.next_input = (self.next_input + 1) % 2;
        let message = Message::submit(address, bytes.len() as u32, pts_us, false)
            .map_err(|_| BackendError::Invalid)?;
        self.exchange("submit", self.service.unwrap(), message, 1, false)?;
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
        let result = unsafe {
            sdk::gsvSyncReadCounter(&mut self.sync, fence.counter, &mut value, &mut mode)
        };
        self.result("read counter", result)?;
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
        copied.map_err(|_| self.unknown())
    }

    fn release(&mut self, index: usize) -> Result<(), BackendError> {
        self.active()?;
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
        Ok(())
    }

    fn close(&mut self) -> Result<(), BackendError> {
        if self.uncertain || (sdk::process_retired() && !self.close_refused) {
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
            if let Some(client) = self.client {
                let result = unsafe { sdk::gsvGpuReleaseClient(&mut self.gpu, client) };
                self.result("release GPU client", result)?;
                self.client = None;
            }
            if self.gpu_open {
                unsafe { sdk::gsvGpuClose(&mut self.gpu) };
                self.gpu_open = false;
            }
            if self.event_open {
                unsafe { sdk::eventClose(&mut self.event) };
                self.event_open = false;
            }
            if self.sync_open {
                unsafe { sdk::gsvSyncClose(&mut self.sync) };
                self.sync_open = false;
            }
            if self.root {
                unsafe { sdk::gsvExit() };
                self.root = false;
            }
            unsafe { ManuallyDrop::drop(&mut self.resources) };
            self.resources_dropped = true;
            if self.claimed {
                ACTIVE.store(false, Ordering::Release);
                self.claimed = false;
            }
            Ok(())
        })();
        self.close_refused = result == Err(BackendError::Refused);
        if result.is_err() {
            sdk::retire_process();
        }
        result
    }

    fn now_ms(&self) -> u64 {
        (unsafe { sdk::moonlightNowNs() }) / 1_000_000
    }
}

impl Drop for GsvBackend {
    fn drop(&mut self) {
        if !self.resources_dropped {
            if self.claimed {
                RETIRED.store(true, Ordering::Release);
                sdk::retire_process();
                log("gsv: live resources retained; exit process");
            } else {
                unsafe { ManuallyDrop::drop(&mut self.resources) };
            }
        }
    }
}
