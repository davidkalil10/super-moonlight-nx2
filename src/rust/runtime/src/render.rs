extern crate alloc;

use crate::{
    cache_file,
    render_platform::{self as sdk, log},
};
use alloc::{boxed::Box, format, vec::Vec};
use ash::{Entry, vk};
use core::{
    ffi::{CStr, c_char},
    marker::PhantomData,
    mem::ManuallyDrop,
    sync::atomic::{AtomicBool, Ordering},
};
use moonlight_nx2_core::{
    cache,
    frame::{self, Frame},
};

pub const UI_CONTROL_OFFSET: usize = 0xc000;
pub const UI_CONTROL_BYTES: usize = 4096;
pub const UI_COPY_BYTES: usize = UI_CONTROL_BYTES + frame::UI_PAGE_BYTES * frame::UI_PAGES;

mod shaders {
    include!(concat!(env!("OUT_DIR"), "/shaders.rs"));
}

#[cfg(feature = "host-renderer")]
#[path = "render_test.rs"]
mod test_support;

macro_rules! create {
    ($call:expr) => {{
        #[cfg(feature = "host-renderer")]
        test_support::point()?;
        $call
    }};
}

fn allocator() -> Option<&'static vk::AllocationCallbacks> {
    #[cfg(feature = "host-renderer")]
    {
        Some(test_support::allocator())
    }
    #[cfg(not(feature = "host-renderer"))]
    {
        None
    }
}

const WAIT_NS: u64 = 2_000_000_000;
static ACTIVE: AtomicBool = AtomicBool::new(false);
#[cfg(feature = "host-renderer")]
static FORCE_WAIT_TIMEOUT: AtomicBool = AtomicBool::new(false);
#[cfg(feature = "host-renderer")]
static WAIT_CALLS: core::sync::atomic::AtomicU64 = core::sync::atomic::AtomicU64::new(0);

#[cfg_attr(not(target_os = "none"), link(name = "vulkan"))]
unsafe extern "system" {
    fn vkGetInstanceProcAddr(instance: vk::Instance, name: *const c_char)
    -> vk::PFN_vkVoidFunction;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Busy,
    Invalid,
    Unsupported,
    NoMemory,
    Device(i32),
    Retained,
    Closed,
}

impl From<vk::Result> for Error {
    fn from(value: vk::Result) -> Self {
        match value {
            vk::Result::TIMEOUT | vk::Result::NOT_READY => Self::Busy,
            vk::Result::ERROR_OUT_OF_HOST_MEMORY | vk::Result::ERROR_OUT_OF_DEVICE_MEMORY => {
                Self::NoMemory
            }
            vk::Result::ERROR_EXTENSION_NOT_PRESENT
            | vk::Result::ERROR_FEATURE_NOT_PRESENT
            | vk::Result::ERROR_FORMAT_NOT_SUPPORTED
            | vk::Result::ERROR_INCOMPATIBLE_DRIVER => Self::Unsupported,
            _ => Self::Device(value.as_raw()),
        }
    }
}

impl From<frame::Error> for Error {
    fn from(value: frame::Error) -> Self {
        match value {
            frame::Error::Invalid => Self::Invalid,
            frame::Error::Unsupported => Self::Unsupported,
        }
    }
}

#[derive(Clone, Copy)]
pub enum UiDraws {
    Instanced,
    Separate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiShader {
    Standard,
    Alpha,
    Text,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum PresentMode {
    #[default]
    Fifo,
    LowLatency,
}

#[derive(Clone, Copy)]
pub struct Config {
    pub width: u32,
    pub height: u32,
    pub prefer_storage: bool,
    pub upload_wait_ns: u64,
    pub cache_path: Option<&'static CStr>,
    pub ui_draws: UiDraws,
    pub capture_ui: bool,
    pub ui_shader: UiShader,
    pub window_mode: crate::display::WindowMode,
    pub frame_rates: Option<crate::display::FrameRates>,
    pub present: PresentMode,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            width: frame::WIDTH,
            height: frame::HEIGHT,
            prefer_storage: false,
            upload_wait_ns: 0,
            cache_path: None,
            ui_draws: UiDraws::Instanced,
            capture_ui: false,
            ui_shader: UiShader::Text,
            window_mode: crate::display::WindowMode::Fixed,
            frame_rates: None,
            present: PresentMode::Fifo,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Info {
    pub format: u32,
    pub width: u32,
    pub height: u32,
    pub swapchain_images: usize,
    pub present_mode: i32,
    pub storage_path: bool,
    pub presented: u64,
    pub busy_uploads: u64,
    pub rebuilds: u64,
    pub cache: CacheState,
    pub cache_saved: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CacheState {
    #[default]
    Disabled,
    Miss,
    Hit,
    Unavailable,
}

#[derive(Default)]
struct Buffer {
    buffer: vk::Buffer,
    memory: vk::DeviceMemory,
    mapped: *mut u8,
    bytes: usize,
}

impl Buffer {
    fn bytes_mut(&mut self) -> &mut [u8] {
        unsafe { core::slice::from_raw_parts_mut(self.mapped, self.bytes) }
    }

    fn destroy(&mut self, device: &ash::Device) {
        unsafe {
            if !self.mapped.is_null() {
                device.unmap_memory(self.memory);
            }
            device.destroy_buffer(self.buffer, allocator());
            device.free_memory(self.memory, allocator());
        }
        *self = Self::default();
    }
}

#[derive(Default)]
struct Flight {
    command: vk::CommandBuffer,
    fence: vk::Fence,
    acquired: vk::Semaphore,
    slot: Option<usize>,
    pending: bool,
}

#[derive(Default)]
struct Target {
    image: vk::Image,
    view: vk::ImageView,
    framebuffer: vk::Framebuffer,
    rendered: vk::Semaphore,
}

struct Objects {
    entry: Entry,
    instance: Option<ash::Instance>,
    device: Option<ash::Device>,
    surface_api: Option<ash::khr::surface::Instance>,
    swapchain_api: Option<ash::khr::swapchain::Device>,
    surface: vk::SurfaceKHR,
    physical: vk::PhysicalDevice,
    family: u32,
    queue: vk::Queue,
    input: Buffer,
    storage: Buffer,
    #[cfg(any(feature = "host-renderer", feature = "diagnostic-ui-data"))]
    readback: Buffer,
    #[cfg(any(feature = "host-renderer", feature = "diagnostic-ui-data"))]
    ui_readback: Buffer,
    texel_views: [vk::BufferView; 2],
    storage_path: bool,
    set_layout: vk::DescriptorSetLayout,
    pool: vk::DescriptorPool,
    set: vk::DescriptorSet,
    pipeline_layout: vk::PipelineLayout,
    pass: vk::RenderPass,
    pipelines: [vk::Pipeline; 3],
    pipeline_cache: vk::PipelineCache,
    command_pool: vk::CommandPool,
    flights: [Flight; 2],
    targets: Vec<Target>,
    format: vk::SurfaceFormatKHR,
    extent: vk::Extent2D,
    swapchain: vk::SwapchainKHR,
    layer_claimed: bool,
    next_flight: usize,
    slot_readers: [usize; 2],
    current_slot: Option<usize>,
    sequence: u32,
    rebuild: bool,
    retained: bool,
    config: Config,
    info: Info,
}

pub struct Renderer {
    objects: ManuallyDrop<Box<Objects>>,
    closed: bool,
    not_send: PhantomData<*mut ()>,
}

impl Renderer {
    pub fn open(config: Config) -> Result<Self, Error> {
        if config.capture_ui
            && !cfg!(any(
                feature = "host-renderer",
                feature = "diagnostic-ui-data"
            ))
        {
            return Err(Error::Unsupported);
        }
        if moonlight_nx2_core::codec::Size::new(config.width, config.height).is_none()
            || config.frame_rates.is_some_and(|rates| !rates.valid())
        {
            return Err(Error::Unsupported);
        }
        if let crate::display::WindowMode::PerMode {
            docked_width,
            docked_height,
        } = config.window_mode
            && (docked_width, docked_height) != (0, 0)
            && moonlight_nx2_core::codec::Size::new(docked_width, docked_height).is_none()
        {
            return Err(Error::Unsupported);
        }
        if sdk::process_retired() {
            return Err(Error::Retained);
        }
        if ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(Error::Busy);
        }
        let entry = unsafe {
            Entry::from_static_fn(ash::StaticFn {
                get_instance_proc_addr: vkGetInstanceProcAddr,
            })
        };
        let mut renderer = Self {
            objects: ManuallyDrop::new(Box::new(Objects {
                entry,
                instance: None,
                device: None,
                surface_api: None,
                swapchain_api: None,
                surface: vk::SurfaceKHR::null(),
                physical: vk::PhysicalDevice::null(),
                family: 0,
                queue: vk::Queue::null(),
                input: Buffer::default(),
                storage: Buffer::default(),
                #[cfg(any(feature = "host-renderer", feature = "diagnostic-ui-data"))]
                readback: Buffer::default(),
                #[cfg(any(feature = "host-renderer", feature = "diagnostic-ui-data"))]
                ui_readback: Buffer::default(),
                texel_views: [vk::BufferView::null(); 2],
                storage_path: true,
                set_layout: vk::DescriptorSetLayout::null(),
                pool: vk::DescriptorPool::null(),
                set: vk::DescriptorSet::null(),
                pipeline_layout: vk::PipelineLayout::null(),
                pass: vk::RenderPass::null(),
                pipelines: [vk::Pipeline::null(); 3],
                pipeline_cache: vk::PipelineCache::null(),
                command_pool: vk::CommandPool::null(),
                flights: core::array::from_fn(|_| Flight::default()),
                targets: Vec::new(),
                format: vk::SurfaceFormatKHR::default(),
                extent: vk::Extent2D::default(),
                swapchain: vk::SwapchainKHR::null(),
                layer_claimed: false,
                next_flight: 0,
                slot_readers: [0; 2],
                current_slot: None,
                sequence: 0,
                rebuild: false,
                retained: false,
                config,
                info: Info::default(),
            })),
            closed: false,
            not_send: PhantomData,
        };
        let result = renderer.objects.initialize();
        if let Err(error) = result {
            log(&format!("render: open {error:?}"));
            renderer.close()?;
            return Err(error);
        }
        log(&format!(
            "render: ready ui_shader={:?} cache={:?} present={:?} mode={}",
            config.ui_shader,
            renderer.objects.info.cache,
            config.present,
            renderer.objects.info.present_mode
        ));
        Ok(renderer)
    }

    fn active(&self) -> Result<(), Error> {
        if self.closed {
            Err(Error::Closed)
        } else if self.objects.retained || sdk::process_retired() {
            Err(Error::Retained)
        } else {
            Ok(())
        }
    }

    pub fn info(&self) -> Result<Info, Error> {
        self.active()?;
        Ok(self.objects.info)
    }

    fn acquire_slot(&mut self) -> Result<usize, Error> {
        match self.free_slot_within(self.objects.config.upload_wait_ns)? {
            Some(slot) => Ok(slot),
            None => {
                self.objects.info.busy_uploads += 1;
                Err(Error::Busy)
            }
        }
    }

    /// The upload slot no frame in flight reads, waiting up to `wait_ns` for one to finish.
    fn free_slot_within(&mut self, wait_ns: u64) -> Result<Option<usize>, Error> {
        self.objects.collect(0)?;
        if let Some(slot) = self.objects.free_slot() {
            return Ok(Some(slot));
        }
        let deadline = sdk::now_ns().saturating_add(wait_ns);
        for index in 0..2 {
            let budget = deadline.saturating_sub(sdk::now_ns());
            if budget == 0 {
                break;
            }
            if self.objects.flights[index].slot == self.objects.current_slot {
                continue;
            }
            match self.objects.wait_flight(index, budget) {
                Ok(()) | Err(Error::Busy) => {}
                Err(error) => return Err(error),
            }
            if self.objects.free_slot().is_some() {
                break;
            }
        }
        Ok(self.objects.free_slot())
    }

    pub fn upload(&mut self, frame: &Frame<'_>) -> Result<usize, Error> {
        self.active()?;
        frame.plan()?;
        let slot = self.acquire_slot()?;
        let layout = frame.copy_to(self.slot_bytes(slot))?;
        self.publish(slot, layout)
    }

    /// The free upload slot and its memory, for a frame written in place and then shown with
    /// `publish`. None when both slots are still read after `wait_ns`.
    pub fn staging(&mut self, wait_ns: u64) -> Result<Option<(usize, &mut [u8])>, Error> {
        self.active()?;
        let Some(slot) = self.free_slot_within(wait_ns)? else {
            return Ok(None);
        };
        Ok(Some((slot, self.slot_bytes(slot))))
    }

    fn slot_bytes(&mut self, slot: usize) -> &mut [u8] {
        let offset = frame::FRAMES_OFFSET + slot * frame::FRAME_BYTES;
        &mut self.objects.storage.bytes_mut()[offset..offset + frame::FRAME_BYTES]
    }

    /// Makes the frame in `slot` the one the next present shows.
    pub fn publish(&mut self, slot: usize, layout: frame::Layout) -> Result<usize, Error> {
        self.active()?;
        if self.objects.free_slot() != Some(slot) {
            return Err(Error::Busy);
        }
        self.objects.sequence = self.objects.sequence.wrapping_add(1).max(1);
        let sequence = self.objects.sequence;
        layout.publish(self.objects.storage.bytes_mut(), slot, sequence)?;
        self.objects.current_slot = Some(slot);
        Ok(slot)
    }

    pub fn present(&mut self, interactive: bool) -> Result<(), Error> {
        self.active()?;
        self.objects.present(interactive)
    }

    pub fn storage_mut(&mut self) -> Result<&mut [u8], Error> {
        self.active()?;
        self.objects.wait_all()?;
        Ok(self.objects.storage.bytes_mut())
    }

    pub fn ui_snapshot(&mut self) -> Result<Vec<u8>, Error> {
        let bytes = self.storage_mut()?;
        let mut copy = Vec::with_capacity(UI_COPY_BYTES);
        copy.extend_from_slice(&bytes[UI_CONTROL_OFFSET..UI_CONTROL_OFFSET + UI_CONTROL_BYTES]);
        copy.extend_from_slice(&bytes[frame::UI_OFFSET..]);
        Ok(copy)
    }

    pub fn input_mut(&mut self) -> Result<&mut [u8], Error> {
        self.active()?;
        self.objects.wait_all()?;
        Ok(self.objects.input.bytes_mut())
    }

    pub fn set_ui_draws(&mut self, draws: UiDraws) -> Result<(), Error> {
        self.active()?;
        self.objects.wait_all()?;
        self.objects.config.ui_draws = draws;
        Ok(())
    }

    pub fn display(&self) -> Result<crate::display::Snapshot, Error> {
        self.active()?;
        #[cfg(target_os = "none")]
        {
            crate::display::observe().ok_or(Error::Invalid)
        }
        #[cfg(not(target_os = "none"))]
        {
            Err(Error::Unsupported)
        }
    }

    #[cfg(any(feature = "host-renderer", feature = "diagnostic-ui-data"))]
    pub fn readback(&mut self) -> Result<Vec<u8>, Error> {
        self.active()?;
        self.objects.wait_all()?;
        if self.objects.info.presented == 0 {
            return Err(Error::Invalid);
        }
        let mut pixels = self.objects.readback.bytes_mut().to_vec();
        if self.objects.format.format == vk::Format::B8G8R8A8_UNORM {
            for pixel in pixels.as_chunks_mut::<4>().0 {
                pixel.swap(0, 2);
            }
        }
        Ok(pixels)
    }

    #[cfg(any(feature = "host-renderer", feature = "diagnostic-ui-data"))]
    pub fn ui_readback(&mut self) -> Result<Vec<u8>, Error> {
        self.active()?;
        self.objects.wait_all()?;
        if !self.objects.config.capture_ui || self.objects.info.presented == 0 {
            return Err(Error::Invalid);
        }
        Ok(self.objects.ui_readback.bytes_mut().to_vec())
    }

    #[cfg(feature = "host-renderer")]
    pub fn test_force_wait_timeout(&mut self) -> Result<(), Error> {
        self.active()?;
        FORCE_WAIT_TIMEOUT.store(true, Ordering::Release);
        Ok(())
    }

    #[cfg(feature = "host-renderer")]
    pub fn test_wait_calls() -> u64 {
        WAIT_CALLS.load(Ordering::Acquire)
    }

    #[cfg(feature = "host-renderer")]
    pub fn test_rebuild(&mut self) -> Result<(), Error> {
        self.active()?;
        self.objects.rebuild = true;
        Ok(())
    }

    #[cfg(feature = "host-renderer")]
    pub fn test_fail_at(call: usize) {
        test_support::fail_at(call);
    }
    #[cfg(feature = "host-renderer")]
    pub fn test_creation_calls() -> usize {
        test_support::calls()
    }
    #[cfg(feature = "host-renderer")]
    pub fn test_live_allocations() -> usize {
        test_support::live()
    }

    pub fn close(&mut self) -> Result<(), Error> {
        if self.closed {
            return Ok(());
        }
        if self.objects.retained || sdk::process_retired() {
            self.objects.retain();
            return Err(Error::Retained);
        }
        self.objects.destroy()?;
        unsafe { ManuallyDrop::drop(&mut self.objects) };
        self.closed = true;
        ACTIVE.store(false, Ordering::Release);
        Ok(())
    }
}

impl Drop for Renderer {
    fn drop(&mut self) {
        if !self.closed {
            let _ = self.close();
        }
    }
}

impl Objects {
    fn retain(&mut self) -> Error {
        self.retained = true;
        sdk::retire_process();
        log("render: resources retained; exit process");
        Error::Retained
    }

    fn device(&self) -> &ash::Device {
        self.device.as_ref().unwrap()
    }
    fn instance(&self) -> &ash::Instance {
        self.instance.as_ref().unwrap()
    }
    fn surface_api(&self) -> &ash::khr::surface::Instance {
        self.surface_api.as_ref().unwrap()
    }
    fn swapchain_api(&self) -> &ash::khr::swapchain::Device {
        self.swapchain_api.as_ref().unwrap()
    }

    fn initialize(&mut self) -> Result<(), Error> {
        unsafe {
            let extensions = sdk::extensions();
            let app = vk::ApplicationInfo::default()
                .application_name(c"Moonlight NX2 Rust")
                .api_version(vk::API_VERSION_1_0);
            let info = vk::InstanceCreateInfo::default()
                .application_info(&app)
                .enabled_extension_names(&extensions);
            self.instance = Some(create!(self.entry.create_instance(&info, allocator()))?);
            self.surface_api = Some(ash::khr::surface::Instance::load(
                &self.entry,
                self.instance(),
            ));
            let instance = self.instance().clone();
            self.surface = create!(sdk::create_surface(
                &self.entry,
                &instance,
                &self.config,
                &mut self.layer_claimed,
                allocator(),
            ))?;
            let devices = self.instance().enumerate_physical_devices()?;
            'choose: for physical in devices {
                for (family, properties) in self
                    .instance()
                    .get_physical_device_queue_family_properties(physical)
                    .iter()
                    .enumerate()
                {
                    let needed = vk::QueueFlags::GRAPHICS | vk::QueueFlags::COMPUTE;
                    if properties.queue_flags.contains(needed)
                        && self.surface_api().get_physical_device_surface_support(
                            physical,
                            family as u32,
                            self.surface,
                        )?
                    {
                        self.physical = physical;
                        self.family = family as u32;
                        break 'choose;
                    }
                }
            }
            if self.physical == vk::PhysicalDevice::null() {
                return Err(Error::Unsupported);
            }
            let priorities = [1.0];
            let queues = [vk::DeviceQueueCreateInfo::default()
                .queue_family_index(self.family)
                .queue_priorities(&priorities)];
            let extensions = [ash::khr::swapchain::NAME.as_ptr()];
            self.device = Some(create!(
                self.instance().create_device(
                    self.physical,
                    &vk::DeviceCreateInfo::default()
                        .queue_create_infos(&queues)
                        .enabled_extension_names(&extensions),
                    allocator(),
                )
            )?);
            self.queue = self.device().get_device_queue(self.family, 0);
            self.swapchain_api = Some(ash::khr::swapchain::Device::load(
                self.instance(),
                self.device(),
            ));
            let limits = self
                .instance()
                .get_physical_device_properties(self.physical)
                .limits;
            if limits.max_storage_buffer_range < frame::STORAGE_BYTES as u32 {
                return Err(Error::Unsupported);
            }
            let texel_formats =
                [vk::Format::R8_UNORM, vk::Format::R8G8_UNORM]
                    .iter()
                    .all(|format| {
                        self.instance()
                            .get_physical_device_format_properties(self.physical, *format)
                            .buffer_features
                            .contains(vk::FormatFeatureFlags::UNIFORM_TEXEL_BUFFER)
                    });
            self.storage_path = self.config.prefer_storage
                || limits.max_texel_buffer_elements < (2 * frame::FRAME_BYTES) as u32
                || limits.min_texel_buffer_offset_alignment == 0
                || !(frame::FRAMES_OFFSET as u64)
                    .is_multiple_of(limits.min_texel_buffer_offset_alignment)
                || !texel_formats;
        }
        let device = self.device().clone();
        self.create_buffer(&device, false)?;
        self.create_buffer(&device, true)?;
        #[cfg(any(feature = "host-renderer", feature = "diagnostic-ui-data"))]
        if self.config.capture_ui {
            self.create_download_buffer(true)?;
        }
        self.create_descriptors()?;
        self.create_pipelines()?;
        self.create_flights()?;
        self.create_swapchain()?;
        self.info.storage_path = self.storage_path;
        Ok(())
    }

    fn create_buffer(&mut self, device: &ash::Device, storage: bool) -> Result<(), Error> {
        let (buffer, bytes) = if storage {
            (&mut self.storage, frame::STORAGE_BYTES)
        } else {
            (&mut self.input, frame::INPUT_BYTES)
        };
        unsafe {
            let usage = vk::BufferUsageFlags::STORAGE_BUFFER
                | if storage {
                    vk::BufferUsageFlags::UNIFORM_TEXEL_BUFFER
                        | if self.config.capture_ui {
                            vk::BufferUsageFlags::TRANSFER_SRC
                        } else {
                            vk::BufferUsageFlags::empty()
                        }
                } else {
                    vk::BufferUsageFlags::empty()
                };
            buffer.buffer = create!(
                device.create_buffer(
                    &vk::BufferCreateInfo::default()
                        .size(bytes as u64)
                        .usage(usage),
                    allocator(),
                )
            )?;
            let requirements = device.get_buffer_memory_requirements(buffer.buffer);
            let properties = self
                .instance
                .as_ref()
                .unwrap()
                .get_physical_device_memory_properties(self.physical);
            let host =
                vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT;
            let mut chosen = None;
            for wanted in [host | vk::MemoryPropertyFlags::DEVICE_LOCAL, host] {
                chosen = (0..properties.memory_type_count).find(|index| {
                    requirements.memory_type_bits & (1 << index) != 0
                        && properties.memory_types[*index as usize]
                            .property_flags
                            .contains(wanted)
                });
                if chosen.is_some() {
                    break;
                }
            }
            let chosen = chosen.ok_or(Error::Unsupported)?;
            buffer.memory = create!(
                device.allocate_memory(
                    &vk::MemoryAllocateInfo::default()
                        .allocation_size(requirements.size)
                        .memory_type_index(chosen),
                    allocator(),
                )
            )?;
            device.bind_buffer_memory(buffer.buffer, buffer.memory, 0)?;
            buffer.mapped = create!(device.map_memory(
                buffer.memory,
                0,
                vk::WHOLE_SIZE,
                vk::MemoryMapFlags::empty(),
            ))?
            .cast();
            buffer.bytes = bytes;
            buffer.bytes_mut().fill(0);
            if storage && !self.storage_path {
                for (index, format) in [vk::Format::R8_UNORM, vk::Format::R8G8_UNORM]
                    .iter()
                    .enumerate()
                {
                    self.texel_views[index] = create!(
                        device.create_buffer_view(
                            &vk::BufferViewCreateInfo::default()
                                .buffer(buffer.buffer)
                                .format(*format)
                                .offset(frame::FRAMES_OFFSET as u64)
                                .range((2 * frame::FRAME_BYTES) as u64),
                            allocator(),
                        )
                    )?;
                }
            }
        }
        Ok(())
    }

    fn create_descriptors(&mut self) -> Result<(), Error> {
        unsafe {
            let all = vk::ShaderStageFlags::ALL_GRAPHICS | vk::ShaderStageFlags::COMPUTE;
            let bindings = [
                vk::DescriptorSetLayoutBinding::default()
                    .binding(0)
                    .descriptor_type(vk::DescriptorType::STORAGE_BUFFER)
                    .descriptor_count(1)
                    .stage_flags(all),
                vk::DescriptorSetLayoutBinding::default()
                    .binding(1)
                    .descriptor_type(vk::DescriptorType::STORAGE_BUFFER)
                    .descriptor_count(1)
                    .stage_flags(all),
                vk::DescriptorSetLayoutBinding::default()
                    .binding(2)
                    .descriptor_type(vk::DescriptorType::UNIFORM_TEXEL_BUFFER)
                    .descriptor_count(1)
                    .stage_flags(vk::ShaderStageFlags::FRAGMENT),
                vk::DescriptorSetLayoutBinding::default()
                    .binding(3)
                    .descriptor_type(vk::DescriptorType::UNIFORM_TEXEL_BUFFER)
                    .descriptor_count(1)
                    .stage_flags(vk::ShaderStageFlags::FRAGMENT),
            ];
            self.set_layout = create!(
                self.device().create_descriptor_set_layout(
                    &vk::DescriptorSetLayoutCreateInfo::default()
                        .bindings(&bindings[..if self.storage_path { 2 } else { 4 }]),
                    allocator(),
                )
            )?;
            let sizes = [
                vk::DescriptorPoolSize::default()
                    .ty(vk::DescriptorType::STORAGE_BUFFER)
                    .descriptor_count(2),
                vk::DescriptorPoolSize::default()
                    .ty(vk::DescriptorType::UNIFORM_TEXEL_BUFFER)
                    .descriptor_count(2),
            ];
            self.pool = create!(
                self.device().create_descriptor_pool(
                    &vk::DescriptorPoolCreateInfo::default()
                        .max_sets(1)
                        .pool_sizes(&sizes[..if self.storage_path { 1 } else { 2 }]),
                    allocator(),
                )
            )?;
            let layouts = [self.set_layout];
            self.set = create!(
                self.device().allocate_descriptor_sets(
                    &vk::DescriptorSetAllocateInfo::default()
                        .descriptor_pool(self.pool)
                        .set_layouts(&layouts),
                )
            )?[0];
            let buffers = [
                vk::DescriptorBufferInfo {
                    buffer: self.input.buffer,
                    offset: 0,
                    range: frame::INPUT_BYTES as u64,
                },
                vk::DescriptorBufferInfo {
                    buffer: self.storage.buffer,
                    offset: 0,
                    range: frame::STORAGE_BYTES as u64,
                },
            ];
            let writes = [
                vk::WriteDescriptorSet::default()
                    .dst_set(self.set)
                    .dst_binding(0)
                    .descriptor_type(vk::DescriptorType::STORAGE_BUFFER)
                    .buffer_info(&buffers),
                vk::WriteDescriptorSet::default()
                    .dst_set(self.set)
                    .dst_binding(2)
                    .descriptor_type(vk::DescriptorType::UNIFORM_TEXEL_BUFFER)
                    .texel_buffer_view(&self.texel_views),
            ];
            self.device()
                .update_descriptor_sets(&writes[..if self.storage_path { 1 } else { 2 }], &[]);
            self.pipeline_layout = create!(self.device().create_pipeline_layout(
                &vk::PipelineLayoutCreateInfo::default().set_layouts(&layouts),
                allocator(),
            ))?;
        }
        Ok(())
    }

    fn cache_identity(&self) -> cache::Identity {
        let properties = unsafe {
            self.instance()
                .get_physical_device_properties(self.physical)
        };
        let mut hash = cache::HASH_START;
        for code in [
            shaders::PUBLISH,
            shaders::VIDEO_VERTEX,
            shaders::VIDEO_FRAGMENT,
            shaders::VIDEO_STORAGE_FRAGMENT,
            shaders::UI_VERTEX,
            match self.config.ui_shader {
                UiShader::Standard => shaders::UI_FRAGMENT,
                UiShader::Alpha => shaders::UI_ALPHA,
                UiShader::Text => shaders::UI_TEXT,
            },
        ] {
            for word in code {
                hash = cache::hash(hash, &word.to_le_bytes());
            }
        }
        cache::Identity {
            vendor: properties.vendor_id,
            device: properties.device_id,
            driver: properties.driver_version,
            uuid: properties.pipeline_cache_uuid,
            width: self.config.width,
            height: self.config.height,
            video_path: u32::from(self.storage_path),
            format: self.format.format.as_raw() as u32,
            abi: 2,
            storage_bytes: frame::STORAGE_BYTES as u32,
            frame_bytes: frame::FRAME_BYTES as u32,
            frames_offset: frame::FRAMES_OFFSET as u32,
            shaders: hash,
        }
    }

    fn new_cache(&self, data: &[u8]) -> Result<vk::PipelineCache, vk::Result> {
        unsafe {
            create!(self.device().create_pipeline_cache(
                &vk::PipelineCacheCreateInfo::default().initial_data(data),
                allocator()
            ))
        }
    }

    fn open_cache(&mut self) {
        let Some(path) = self.config.cache_path else {
            log("render: cache disabled");
            return;
        };
        let reason = match cache_file::load(path, self.cache_identity()) {
            Ok(data) => match self.new_cache(&data[cache::HEADER_BYTES..]) {
                Ok(cache) => {
                    self.pipeline_cache = cache;
                    self.info.cache = CacheState::Hit;
                    log(&format!(
                        "render: cache hit {} bytes",
                        data.len() - cache::HEADER_BYTES
                    ));
                    return;
                }
                Err(_) => "driver",
            },
            Err(reason) => reason,
        };
        match self.new_cache(&[]) {
            Ok(cache) => {
                self.pipeline_cache = cache;
                self.info.cache = CacheState::Miss;
                log(&format!("render: cache miss ({reason})"));
            }
            Err(_) => {
                self.info.cache = CacheState::Unavailable;
                log("render: cache unavailable");
            }
        }
    }

    fn save_cache(&mut self) {
        if self.info.cache != CacheState::Miss {
            return;
        }
        let mut bytes = 0;
        let result = unsafe {
            (self.device().fp_v1_0().get_pipeline_cache_data)(
                self.device().handle(),
                self.pipeline_cache,
                &mut bytes,
                core::ptr::null_mut(),
            )
        };
        if result != vk::Result::SUCCESS
            || bytes == 0
            || bytes > cache::MAX_BYTES - cache::HEADER_BYTES
        {
            log("render: cache not saved (size)");
            return;
        }
        let mut data: Vec<u8> = Vec::new();
        if data.try_reserve_exact(bytes).is_err() {
            log("render: cache not saved (memory)");
            return;
        }
        data.resize(bytes, 0);
        let result = unsafe {
            (self.device().fp_v1_0().get_pipeline_cache_data)(
                self.device().handle(),
                self.pipeline_cache,
                &mut bytes,
                data.as_mut_ptr().cast(),
            )
        };
        if result != vk::Result::SUCCESS || bytes > data.len() {
            log("render: cache not saved (data)");
            return;
        }
        data.truncate(bytes);
        let saved = cache_file::save(
            self.config.cache_path.unwrap(),
            self.cache_identity(),
            &data,
        );
        self.info.cache_saved = saved.is_ok();
        match saved {
            Ok(()) => log(&format!("render: cache saved {bytes} bytes")),
            Err(reason) => log(&format!("render: cache not saved ({reason})")),
        }
    }

    fn close_cache(&mut self) {
        if self.pipeline_cache != vk::PipelineCache::null() {
            unsafe {
                self.device()
                    .destroy_pipeline_cache(self.pipeline_cache, allocator())
            };
            self.pipeline_cache = vk::PipelineCache::null();
        }
    }

    fn create_pipelines(&mut self) -> Result<(), Error> {
        unsafe {
            let formats = self
                .surface_api()
                .get_physical_device_surface_formats(self.physical, self.surface)?;
            self.format = formats
                .iter()
                .find(|format| format.format == vk::Format::R8G8B8A8_UNORM)
                .or_else(|| {
                    formats.iter().find(|format| {
                        matches!(
                            format.format,
                            vk::Format::B8G8R8A8_UNORM | vk::Format::A8B8G8R8_UNORM_PACK32
                        )
                    })
                })
                .copied()
                .ok_or(Error::Unsupported)?;
            let attachments = [vk::AttachmentDescription::default()
                .format(self.format.format)
                .samples(vk::SampleCountFlags::TYPE_1)
                .load_op(vk::AttachmentLoadOp::CLEAR)
                .store_op(vk::AttachmentStoreOp::STORE)
                .stencil_load_op(vk::AttachmentLoadOp::DONT_CARE)
                .stencil_store_op(vk::AttachmentStoreOp::DONT_CARE)
                .initial_layout(vk::ImageLayout::UNDEFINED)
                .final_layout(vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL)];
            let colors = [vk::AttachmentReference {
                attachment: 0,
                layout: vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL,
            }];
            let subpasses = [vk::SubpassDescription::default()
                .pipeline_bind_point(vk::PipelineBindPoint::GRAPHICS)
                .color_attachments(&colors)];
            let dependencies = [vk::SubpassDependency::default()
                .src_subpass(vk::SUBPASS_EXTERNAL)
                .dst_subpass(0)
                .src_stage_mask(vk::PipelineStageFlags::COLOR_ATTACHMENT_OUTPUT)
                .dst_stage_mask(vk::PipelineStageFlags::COLOR_ATTACHMENT_OUTPUT)
                .dst_access_mask(vk::AccessFlags::COLOR_ATTACHMENT_WRITE)];
            self.pass = create!(
                self.device().create_render_pass(
                    &vk::RenderPassCreateInfo::default()
                        .attachments(&attachments)
                        .subpasses(&subpasses)
                        .dependencies(&dependencies),
                    allocator(),
                )
            )?;
        }
        self.open_cache();
        let code = [
            shaders::PUBLISH,
            shaders::VIDEO_VERTEX,
            if self.storage_path {
                shaders::VIDEO_STORAGE_FRAGMENT
            } else {
                shaders::VIDEO_FRAGMENT
            },
            shaders::UI_VERTEX,
            match self.config.ui_shader {
                UiShader::Standard => shaders::UI_FRAGMENT,
                UiShader::Alpha => shaders::UI_ALPHA,
                UiShader::Text => shaders::UI_TEXT,
            },
        ];
        let mut modules = Vec::new();
        let result = (|| -> Result<(), Error> {
            for shader in code {
                modules.push(unsafe {
                    create!(self.device().create_shader_module(
                        &vk::ShaderModuleCreateInfo::default().code(shader),
                        allocator(),
                    ))?
                });
            }
            let stage = vk::PipelineShaderStageCreateInfo::default()
                .stage(vk::ShaderStageFlags::COMPUTE)
                .module(modules[0])
                .name(c"main");
            let info = vk::ComputePipelineCreateInfo::default()
                .stage(stage)
                .layout(self.pipeline_layout)
                .base_pipeline_index(-1);
            self.pipelines[0] = match unsafe {
                create!(self.device().create_compute_pipelines(
                    self.pipeline_cache,
                    &[info],
                    allocator()
                ))
            } {
                Ok(pipelines) => pipelines[0],
                Err((pipelines, error)) => {
                    for pipeline in pipelines {
                        unsafe { self.device().destroy_pipeline(pipeline, allocator()) };
                    }
                    return Err(error.into());
                }
            };
            self.pipelines[1] = self.graphics_pipeline(
                modules[1],
                modules[2],
                false,
                self.pipeline_layout,
                self.pipeline_cache,
            )?;
            self.pipelines[2] = self.graphics_pipeline(
                modules[3],
                modules[4],
                true,
                self.pipeline_layout,
                self.pipeline_cache,
            )?;
            Ok(())
        })();
        for module in modules {
            unsafe { self.device().destroy_shader_module(module, allocator()) };
        }
        if result.is_ok() {
            self.save_cache();
        }
        self.close_cache();
        result
    }

    fn graphics_pipeline(
        &self,
        vertex: vk::ShaderModule,
        fragment: vk::ShaderModule,
        blended: bool,
        layout: vk::PipelineLayout,
        cache: vk::PipelineCache,
    ) -> Result<vk::Pipeline, Error> {
        let stages = [
            vk::PipelineShaderStageCreateInfo::default()
                .stage(vk::ShaderStageFlags::VERTEX)
                .module(vertex)
                .name(c"main"),
            vk::PipelineShaderStageCreateInfo::default()
                .stage(vk::ShaderStageFlags::FRAGMENT)
                .module(fragment)
                .name(c"main"),
        ];
        let input = vk::PipelineVertexInputStateCreateInfo::default();
        let assembly = vk::PipelineInputAssemblyStateCreateInfo::default()
            .topology(vk::PrimitiveTopology::TRIANGLE_LIST);
        let viewport = vk::PipelineViewportStateCreateInfo::default()
            .viewport_count(1)
            .scissor_count(1);
        let raster = vk::PipelineRasterizationStateCreateInfo::default().line_width(1.0);
        let multisample = vk::PipelineMultisampleStateCreateInfo::default()
            .rasterization_samples(vk::SampleCountFlags::TYPE_1);
        let attachments = [vk::PipelineColorBlendAttachmentState::default()
            .blend_enable(blended)
            .src_color_blend_factor(vk::BlendFactor::SRC_ALPHA)
            .dst_color_blend_factor(vk::BlendFactor::ONE_MINUS_SRC_ALPHA)
            .color_blend_op(vk::BlendOp::ADD)
            .src_alpha_blend_factor(vk::BlendFactor::ONE)
            .dst_alpha_blend_factor(vk::BlendFactor::ONE_MINUS_SRC_ALPHA)
            .alpha_blend_op(vk::BlendOp::ADD)
            .color_write_mask(vk::ColorComponentFlags::RGBA)];
        let blend = vk::PipelineColorBlendStateCreateInfo::default().attachments(&attachments);
        let states = [vk::DynamicState::VIEWPORT, vk::DynamicState::SCISSOR];
        let dynamic = vk::PipelineDynamicStateCreateInfo::default().dynamic_states(&states);
        let info = vk::GraphicsPipelineCreateInfo::default()
            .stages(&stages)
            .vertex_input_state(&input)
            .input_assembly_state(&assembly)
            .viewport_state(&viewport)
            .rasterization_state(&raster)
            .multisample_state(&multisample)
            .color_blend_state(&blend)
            .dynamic_state(&dynamic)
            .layout(layout)
            .render_pass(self.pass)
            .base_pipeline_index(-1);
        match unsafe {
            create!(
                self.device()
                    .create_graphics_pipelines(cache, &[info], allocator())
            )
        } {
            Ok(pipelines) => Ok(pipelines[0]),
            Err((pipelines, error)) => {
                for pipeline in pipelines {
                    unsafe { self.device().destroy_pipeline(pipeline, allocator()) };
                }
                Err(error.into())
            }
        }
    }

    fn create_flights(&mut self) -> Result<(), Error> {
        unsafe {
            self.command_pool = create!(
                self.device().create_command_pool(
                    &vk::CommandPoolCreateInfo::default()
                        .queue_family_index(self.family)
                        .flags(vk::CommandPoolCreateFlags::RESET_COMMAND_BUFFER),
                    allocator(),
                )
            )?;
            let commands = create!(
                self.device().allocate_command_buffers(
                    &vk::CommandBufferAllocateInfo::default()
                        .command_pool(self.command_pool)
                        .level(vk::CommandBufferLevel::PRIMARY)
                        .command_buffer_count(2),
                )
            )?;
            for (index, command) in commands.into_iter().enumerate() {
                self.flights[index].command = command;
                self.flights[index].fence = create!(
                    self.device()
                        .create_fence(&vk::FenceCreateInfo::default(), allocator())
                )?;
                self.flights[index].acquired = create!(
                    self.device()
                        .create_semaphore(&vk::SemaphoreCreateInfo::default(), allocator())
                )?;
            }
        }
        Ok(())
    }

    fn create_swapchain(&mut self) -> Result<(), Error> {
        unsafe {
            let caps = self
                .surface_api()
                .get_physical_device_surface_capabilities(self.physical, self.surface)?;
            let usage = vk::ImageUsageFlags::COLOR_ATTACHMENT | vk::ImageUsageFlags::TRANSFER_SRC;
            if !caps.supported_usage_flags.contains(usage) {
                return Err(Error::Unsupported);
            }
            self.extent = if caps.current_extent.width != u32::MAX {
                caps.current_extent
            } else {
                vk::Extent2D {
                    width: self
                        .config
                        .width
                        .clamp(caps.min_image_extent.width, caps.max_image_extent.width),
                    height: self
                        .config
                        .height
                        .clamp(caps.min_image_extent.height, caps.max_image_extent.height),
                }
            };
            if self.extent.width == 0 || self.extent.height == 0 {
                return Err(Error::Busy);
            }
            let mode = self.present_mode()?;
            let minimum = if mode == vk::PresentModeKHR::MAILBOX {
                3
            } else {
                2
            };
            let images = caps.min_image_count.max(minimum);
            let images = if caps.max_image_count == 0 {
                images
            } else {
                images.min(caps.max_image_count)
            };
            let alpha = if caps
                .supported_composite_alpha
                .contains(vk::CompositeAlphaFlagsKHR::OPAQUE)
            {
                vk::CompositeAlphaFlagsKHR::OPAQUE
            } else {
                vk::CompositeAlphaFlagsKHR::from_raw(
                    1 << caps
                        .supported_composite_alpha
                        .as_raw()
                        .trailing_zeros()
                        .min(31),
                )
            };
            let info = vk::SwapchainCreateInfoKHR::default()
                .surface(self.surface)
                .min_image_count(images)
                .image_format(self.format.format)
                .image_color_space(self.format.color_space)
                .image_extent(self.extent)
                .image_array_layers(1)
                .image_usage(usage)
                .image_sharing_mode(vk::SharingMode::EXCLUSIVE)
                .pre_transform(caps.current_transform)
                .composite_alpha(alpha)
                .present_mode(mode)
                .clipped(true)
                .old_swapchain(self.swapchain);
            let swapchain = create!(self.swapchain_api().create_swapchain(&info, allocator()))?;
            if self.swapchain != vk::SwapchainKHR::null() {
                self.swapchain_api()
                    .destroy_swapchain(self.swapchain, allocator());
            }
            self.swapchain = swapchain;
            let images = self.swapchain_api().get_swapchain_images(swapchain)?;
            if images.is_empty() || images.len() > 8 {
                return Err(Error::Unsupported);
            }
            for image in images {
                self.targets.push(Target {
                    image,
                    ..Target::default()
                });
                let index = self.targets.len() - 1;
                self.targets[index].view = create!(
                    self.device().create_image_view(
                        &vk::ImageViewCreateInfo::default()
                            .image(image)
                            .view_type(vk::ImageViewType::TYPE_2D)
                            .format(self.format.format)
                            .subresource_range(
                                vk::ImageSubresourceRange::default()
                                    .aspect_mask(vk::ImageAspectFlags::COLOR)
                                    .level_count(1)
                                    .layer_count(1),
                            ),
                        allocator(),
                    )
                )?;
                let attachments = [self.targets[index].view];
                self.targets[index].framebuffer = create!(
                    self.device().create_framebuffer(
                        &vk::FramebufferCreateInfo::default()
                            .render_pass(self.pass)
                            .attachments(&attachments)
                            .width(self.extent.width)
                            .height(self.extent.height)
                            .layers(1),
                        allocator(),
                    )
                )?;
                self.targets[index].rendered = create!(
                    self.device()
                        .create_semaphore(&vk::SemaphoreCreateInfo::default(), allocator())
                )?;
            }
        }
        let extent = self.extent;
        let storage = self.storage.bytes_mut();
        for (offset, value) in [
            (frame::TARGET_WIDTH, extent.width),
            (frame::TARGET_HEIGHT, extent.height),
            (frame::TARGET_BACKING_WIDTH, extent.width),
            (frame::TARGET_BACKING_HEIGHT, extent.height),
        ] {
            storage[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        self.info.width = self.extent.width;
        self.info.height = self.extent.height;
        self.info.swapchain_images = self.targets.len();
        #[cfg(any(feature = "host-renderer", feature = "diagnostic-ui-data"))]
        self.create_download_buffer(false)?;
        self.info.format = self.format.format.as_raw() as u32;
        log(&format!(
            "render: swapchain {}x{} images={} storage={}",
            self.extent.width,
            self.extent.height,
            self.targets.len(),
            self.storage_path
        ));
        Ok(())
    }

    fn present_mode(&mut self) -> Result<vk::PresentModeKHR, Error> {
        let mode = match self.config.present {
            PresentMode::Fifo => vk::PresentModeKHR::FIFO,
            PresentMode::LowLatency => {
                let modes = unsafe {
                    self.surface_api()
                        .get_physical_device_surface_present_modes(self.physical, self.surface)?
                };
                [vk::PresentModeKHR::MAILBOX, vk::PresentModeKHR::IMMEDIATE]
                    .into_iter()
                    .find(|mode| modes.contains(mode))
                    .unwrap_or(vk::PresentModeKHR::FIFO)
            }
        };
        self.info.present_mode = mode.as_raw();
        Ok(mode)
    }

    fn free_slot(&self) -> Option<usize> {
        (0..2).find(|slot| Some(*slot) != self.current_slot && self.slot_readers[*slot] == 0)
    }

    #[cfg(any(feature = "host-renderer", feature = "diagnostic-ui-data"))]
    fn create_download_buffer(&mut self, ui: bool) -> Result<(), Error> {
        let device = self.device().clone();
        let properties = unsafe {
            self.instance()
                .get_physical_device_memory_properties(self.physical)
        };
        let (buffer, bytes) = if ui {
            (&mut self.ui_readback, UI_COPY_BYTES)
        } else {
            (
                &mut self.readback,
                self.extent.width as usize * self.extent.height as usize * 4,
            )
        };
        buffer.destroy(&device);
        unsafe {
            buffer.buffer = create!(
                device.create_buffer(
                    &vk::BufferCreateInfo::default()
                        .size(bytes as u64)
                        .usage(vk::BufferUsageFlags::TRANSFER_DST),
                    allocator(),
                )
            )?;
            let requirements = device.get_buffer_memory_requirements(buffer.buffer);
            let wanted =
                vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT;
            let chosen = (0..properties.memory_type_count)
                .find(|index| {
                    requirements.memory_type_bits & (1 << index) != 0
                        && properties.memory_types[*index as usize]
                            .property_flags
                            .contains(wanted)
                })
                .ok_or(Error::Unsupported)?;
            buffer.memory = create!(
                device.allocate_memory(
                    &vk::MemoryAllocateInfo::default()
                        .allocation_size(requirements.size)
                        .memory_type_index(chosen),
                    allocator(),
                )
            )?;
            device.bind_buffer_memory(buffer.buffer, buffer.memory, 0)?;
            buffer.mapped = create!(device.map_memory(
                buffer.memory,
                0,
                vk::WHOLE_SIZE,
                vk::MemoryMapFlags::empty(),
            ))?
            .cast();
        }
        buffer.bytes = bytes;
        Ok(())
    }

    fn record_present_transition(&self, command: vk::CommandBuffer, image: vk::Image) {
        let subresource = vk::ImageSubresourceRange::default()
            .aspect_mask(vk::ImageAspectFlags::COLOR)
            .level_count(1)
            .layer_count(1);
        let ready = vk::ImageMemoryBarrier::default()
            .src_access_mask(vk::AccessFlags::COLOR_ATTACHMENT_WRITE)
            .dst_access_mask(vk::AccessFlags::TRANSFER_READ)
            .old_layout(vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL)
            .new_layout(vk::ImageLayout::TRANSFER_SRC_OPTIMAL)
            .src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
            .dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
            .image(image)
            .subresource_range(subresource);
        #[cfg(any(feature = "host-renderer", feature = "diagnostic-ui-data"))]
        let region = vk::BufferImageCopy::default()
            .image_subresource(
                vk::ImageSubresourceLayers::default()
                    .aspect_mask(vk::ImageAspectFlags::COLOR)
                    .layer_count(1),
            )
            .image_extent(vk::Extent3D {
                width: self.extent.width,
                height: self.extent.height,
                depth: 1,
            });
        let present = vk::ImageMemoryBarrier::default()
            .src_access_mask(vk::AccessFlags::TRANSFER_READ)
            .old_layout(vk::ImageLayout::TRANSFER_SRC_OPTIMAL)
            .new_layout(vk::ImageLayout::PRESENT_SRC_KHR)
            .src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
            .dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
            .image(image)
            .subresource_range(subresource);
        #[cfg(any(feature = "host-renderer", feature = "diagnostic-ui-data"))]
        let host = vk::MemoryBarrier::default()
            .src_access_mask(vk::AccessFlags::TRANSFER_WRITE)
            .dst_access_mask(vk::AccessFlags::HOST_READ);
        unsafe {
            self.device().cmd_pipeline_barrier(
                command,
                vk::PipelineStageFlags::COLOR_ATTACHMENT_OUTPUT,
                vk::PipelineStageFlags::TRANSFER,
                vk::DependencyFlags::empty(),
                &[],
                &[],
                &[ready],
            );
            #[cfg(any(feature = "host-renderer", feature = "diagnostic-ui-data"))]
            self.device().cmd_copy_image_to_buffer(
                command,
                image,
                vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
                self.readback.buffer,
                &[region],
            );
            self.device().cmd_pipeline_barrier(
                command,
                vk::PipelineStageFlags::TRANSFER,
                vk::PipelineStageFlags::BOTTOM_OF_PIPE
                    | if cfg!(any(
                        feature = "host-renderer",
                        feature = "diagnostic-ui-data"
                    )) {
                        vk::PipelineStageFlags::HOST
                    } else {
                        vk::PipelineStageFlags::empty()
                    },
                vk::DependencyFlags::empty(),
                {
                    #[cfg(any(feature = "host-renderer", feature = "diagnostic-ui-data"))]
                    {
                        core::slice::from_ref(&host)
                    }
                    #[cfg(not(any(feature = "host-renderer", feature = "diagnostic-ui-data")))]
                    {
                        &[]
                    }
                },
                &[],
                &[present],
            );
        }
    }

    #[cfg(any(feature = "host-renderer", feature = "diagnostic-ui-data"))]
    fn record_ui_copy(&self, command: vk::CommandBuffer) {
        if !self.config.capture_ui {
            return;
        }
        self.barrier(
            command,
            vk::PipelineStageFlags::COMPUTE_SHADER
                | vk::PipelineStageFlags::VERTEX_SHADER
                | vk::PipelineStageFlags::FRAGMENT_SHADER,
            vk::AccessFlags::SHADER_WRITE | vk::AccessFlags::SHADER_READ,
            vk::PipelineStageFlags::TRANSFER,
            vk::AccessFlags::TRANSFER_READ,
        );
        let regions = [
            vk::BufferCopy {
                src_offset: UI_CONTROL_OFFSET as u64,
                dst_offset: 0,
                size: UI_CONTROL_BYTES as u64,
            },
            vk::BufferCopy {
                src_offset: frame::UI_OFFSET as u64,
                dst_offset: UI_CONTROL_BYTES as u64,
                size: (frame::UI_PAGE_BYTES * frame::UI_PAGES) as u64,
            },
        ];
        unsafe {
            self.device().cmd_copy_buffer(
                command,
                self.storage.buffer,
                self.ui_readback.buffer,
                &regions,
            );
        }
        self.barrier(
            command,
            vk::PipelineStageFlags::TRANSFER,
            vk::AccessFlags::TRANSFER_WRITE,
            vk::PipelineStageFlags::HOST,
            vk::AccessFlags::HOST_READ,
        );
    }

    fn wait_flight(&mut self, index: usize, timeout_ns: u64) -> Result<(), Error> {
        if !self.flights[index].pending {
            return Ok(());
        }
        #[cfg(feature = "host-renderer")]
        {
            WAIT_CALLS.fetch_add(1, Ordering::AcqRel);
            if FORCE_WAIT_TIMEOUT.load(Ordering::Acquire) {
                return Err(Error::Busy);
            }
        }
        let fence = self.flights[index].fence;
        let result = unsafe {
            if timeout_ns == 0 {
                self.device().get_fence_status(fence).and_then(|ready| {
                    if ready {
                        Ok(())
                    } else {
                        Err(vk::Result::NOT_READY)
                    }
                })
            } else {
                self.device().wait_for_fences(&[fence], true, timeout_ns)
            }
        };
        match result {
            Ok(()) => {}
            Err(vk::Result::TIMEOUT | vk::Result::NOT_READY) => return Err(Error::Busy),
            Err(_) => return Err(self.retain()),
        }
        if unsafe { self.device().reset_fences(&[fence]) }.is_err() {
            return Err(self.retain());
        }
        if let Some(slot) = self.flights[index].slot {
            self.slot_readers[slot] -= 1;
        }
        self.flights[index].slot = None;
        self.flights[index].pending = false;
        Ok(())
    }

    fn collect(&mut self, timeout_ns: u64) -> Result<(), Error> {
        for index in 0..2 {
            match self.wait_flight(index, timeout_ns) {
                Ok(()) | Err(Error::Busy) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn wait_all(&mut self) -> Result<(), Error> {
        for index in 0..2 {
            self.wait_flight(index, WAIT_NS)?;
        }
        Ok(())
    }

    fn barrier(
        &self,
        command: vk::CommandBuffer,
        source: vk::PipelineStageFlags,
        source_access: vk::AccessFlags,
        target: vk::PipelineStageFlags,
        target_access: vk::AccessFlags,
    ) {
        let barriers = [vk::MemoryBarrier::default()
            .src_access_mask(source_access)
            .dst_access_mask(target_access)];
        unsafe {
            self.device().cmd_pipeline_barrier(
                command,
                source,
                target,
                vk::DependencyFlags::empty(),
                &barriers,
                &[],
                &[],
            )
        };
    }

    fn record(
        &self,
        command: vk::CommandBuffer,
        image: usize,
        interactive: bool,
    ) -> Result<(), Error> {
        unsafe {
            self.device()
                .reset_command_buffer(command, vk::CommandBufferResetFlags::empty())?;
            self.device().begin_command_buffer(
                command,
                &vk::CommandBufferBeginInfo::default()
                    .flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT),
            )?;
            #[cfg(any(feature = "host-renderer", feature = "diagnostic-ui-data"))]
            self.barrier(
                command,
                vk::PipelineStageFlags::TRANSFER,
                vk::AccessFlags::TRANSFER_WRITE,
                vk::PipelineStageFlags::TRANSFER,
                vk::AccessFlags::TRANSFER_WRITE,
            );
            self.barrier(
                command,
                vk::PipelineStageFlags::HOST,
                vk::AccessFlags::HOST_WRITE,
                vk::PipelineStageFlags::COMPUTE_SHADER
                    | vk::PipelineStageFlags::VERTEX_SHADER
                    | vk::PipelineStageFlags::FRAGMENT_SHADER
                    | if self.config.capture_ui {
                        vk::PipelineStageFlags::TRANSFER
                    } else {
                        vk::PipelineStageFlags::empty()
                    },
                vk::AccessFlags::SHADER_READ
                    | vk::AccessFlags::SHADER_WRITE
                    | if self.config.capture_ui {
                        vk::AccessFlags::TRANSFER_READ
                    } else {
                        vk::AccessFlags::empty()
                    },
            );
            if interactive {
                let graphics =
                    vk::PipelineStageFlags::VERTEX_SHADER | vk::PipelineStageFlags::FRAGMENT_SHADER;
                let rw = vk::AccessFlags::SHADER_READ | vk::AccessFlags::SHADER_WRITE;
                self.barrier(
                    command,
                    graphics | vk::PipelineStageFlags::COMPUTE_SHADER,
                    rw,
                    vk::PipelineStageFlags::COMPUTE_SHADER,
                    rw,
                );
                self.device().cmd_bind_descriptor_sets(
                    command,
                    vk::PipelineBindPoint::COMPUTE,
                    self.pipeline_layout,
                    0,
                    &[self.set],
                    &[],
                );
                self.device().cmd_bind_pipeline(
                    command,
                    vk::PipelineBindPoint::COMPUTE,
                    self.pipelines[0],
                );
                self.device().cmd_dispatch(command, 1, 1, 1);
                self.barrier(
                    command,
                    vk::PipelineStageFlags::COMPUTE_SHADER,
                    vk::AccessFlags::SHADER_WRITE,
                    graphics,
                    vk::AccessFlags::SHADER_READ,
                );
            }
            self.device().cmd_bind_descriptor_sets(
                command,
                vk::PipelineBindPoint::GRAPHICS,
                self.pipeline_layout,
                0,
                &[self.set],
                &[],
            );
            let clear = [vk::ClearValue {
                color: vk::ClearColorValue {
                    float32: [0.012, 0.02, 0.045, 1.0],
                },
            }];
            let area = vk::Rect2D {
                offset: vk::Offset2D { x: 0, y: 0 },
                extent: self.extent,
            };
            self.device().cmd_begin_render_pass(
                command,
                &vk::RenderPassBeginInfo::default()
                    .render_pass(self.pass)
                    .framebuffer(self.targets[image].framebuffer)
                    .render_area(area)
                    .clear_values(&clear),
                vk::SubpassContents::INLINE,
            );
            self.device().cmd_set_viewport(
                command,
                0,
                &[vk::Viewport {
                    x: 0.0,
                    y: 0.0,
                    width: self.extent.width as f32,
                    height: self.extent.height as f32,
                    min_depth: 0.0,
                    max_depth: 1.0,
                }],
            );
            self.device().cmd_set_scissor(command, 0, &[area]);
            if let Some(slot) = self.current_slot {
                self.device().cmd_bind_pipeline(
                    command,
                    vk::PipelineBindPoint::GRAPHICS,
                    self.pipelines[1],
                );
                self.device().cmd_draw(command, 3, 1, 0, slot as u32);
            }
            self.device().cmd_bind_pipeline(
                command,
                vk::PipelineBindPoint::GRAPHICS,
                self.pipelines[2],
            );
            if interactive {
                match self.config.ui_draws {
                    UiDraws::Instanced => {
                        self.device()
                            .cmd_draw(command, 6, frame::UI_INSTANCES + 1, 0, 0)
                    }
                    UiDraws::Separate => {
                        for instance in 0..=frame::UI_INSTANCES {
                            self.device().cmd_draw(command, 6, 1, 0, instance);
                        }
                    }
                }
            } else {
                self.device()
                    .cmd_draw(command, 6, 1, 0, frame::BADGE_INSTANCE);
            }
            self.device().cmd_end_render_pass(command);
            #[cfg(any(feature = "host-renderer", feature = "diagnostic-ui-data"))]
            self.record_ui_copy(command);
            self.record_present_transition(command, self.targets[image].image);
            if interactive {
                self.barrier(
                    command,
                    vk::PipelineStageFlags::COMPUTE_SHADER,
                    vk::AccessFlags::SHADER_WRITE,
                    vk::PipelineStageFlags::HOST,
                    vk::AccessFlags::HOST_READ,
                );
            }
            self.device().end_command_buffer(command)?;
        }
        Ok(())
    }

    fn present(&mut self, interactive: bool) -> Result<(), Error> {
        if self.rebuild {
            self.wait_all()?;
            self.destroy_targets();
            self.create_swapchain()?;
            self.rebuild = false;
            self.info.rebuilds += 1;
        }
        let flight = self.next_flight;
        self.wait_flight(flight, WAIT_NS)?;
        if self.info.present_mode != vk::PresentModeKHR::FIFO.as_raw() {
            self.wait_flight((flight + 1) % 2, WAIT_NS)?;
        }
        let result = unsafe {
            self.swapchain_api().acquire_next_image(
                self.swapchain,
                WAIT_NS,
                self.flights[flight].acquired,
                vk::Fence::null(),
            )
        };
        let (image, suboptimal) = match result {
            Ok(result) => result,
            Err(vk::Result::ERROR_OUT_OF_DATE_KHR) => {
                self.rebuild = true;
                return Err(Error::Busy);
            }
            Err(vk::Result::TIMEOUT | vk::Result::NOT_READY) => return Err(Error::Busy),
            Err(_) => return Err(self.retain()),
        };
        self.rebuild |= suboptimal;
        let image = image as usize;
        if image >= self.targets.len() {
            return Err(self.retain());
        }
        let command = self.flights[flight].command;
        if self.record(command, image, interactive).is_err() {
            return Err(self.retain());
        }
        let acquired = [self.flights[flight].acquired];
        let rendered = [self.targets[image].rendered];
        let commands = [command];
        let stages = [vk::PipelineStageFlags::COLOR_ATTACHMENT_OUTPUT];
        let submit = vk::SubmitInfo::default()
            .wait_semaphores(&acquired)
            .wait_dst_stage_mask(&stages)
            .command_buffers(&commands)
            .signal_semaphores(&rendered);
        if unsafe {
            self.device()
                .queue_submit(self.queue, &[submit], self.flights[flight].fence)
        }
        .is_err()
        {
            return Err(self.retain());
        }
        self.flights[flight].pending = true;
        self.flights[flight].slot = self.current_slot;
        if let Some(slot) = self.current_slot {
            self.slot_readers[slot] += 1;
        }
        self.next_flight = (flight + 1) % 2;
        let swaps = [self.swapchain];
        let images = [image as u32];
        let info = vk::PresentInfoKHR::default()
            .wait_semaphores(&rendered)
            .swapchains(&swaps)
            .image_indices(&images);
        match unsafe { self.swapchain_api().queue_present(self.queue, &info) } {
            Ok(suboptimal) => self.rebuild |= suboptimal,
            Err(vk::Result::ERROR_OUT_OF_DATE_KHR) => self.rebuild = true,
            Err(_) => return Err(self.retain()),
        }
        self.info.presented += 1;
        Ok(())
    }

    fn destroy_targets(&mut self) {
        let device = self.device().clone();
        for target in self.targets.drain(..) {
            unsafe {
                device.destroy_framebuffer(target.framebuffer, allocator());
                device.destroy_image_view(target.view, allocator());
                device.destroy_semaphore(target.rendered, allocator());
            }
        }
    }

    fn destroy(&mut self) -> Result<(), Error> {
        if self.retained {
            return Err(Error::Retained);
        }
        if self.device.is_some() {
            if self.wait_all().is_err() {
                return Err(self.retain());
            }
            self.destroy_targets();
            self.close_cache();
            let device = self.device().clone();
            unsafe {
                self.swapchain_api()
                    .destroy_swapchain(self.swapchain, allocator());
                for flight in &self.flights {
                    device.destroy_fence(flight.fence, allocator());
                    device.destroy_semaphore(flight.acquired, allocator());
                }
                device.destroy_command_pool(self.command_pool, allocator());
                for pipeline in self.pipelines {
                    device.destroy_pipeline(pipeline, allocator());
                }
                device.destroy_render_pass(self.pass, allocator());
                device.destroy_pipeline_layout(self.pipeline_layout, allocator());
                device.destroy_descriptor_pool(self.pool, allocator());
                device.destroy_descriptor_set_layout(self.set_layout, allocator());
                for view in self.texel_views {
                    device.destroy_buffer_view(view, allocator());
                }
                for buffer in [&mut self.storage, &mut self.input] {
                    buffer.destroy(&device);
                }
                #[cfg(any(feature = "host-renderer", feature = "diagnostic-ui-data"))]
                {
                    self.readback.destroy(&device);
                    self.ui_readback.destroy(&device);
                }
                device.destroy_device(allocator());
            }
            self.device = None;
        }
        if let Some(instance) = self.instance.as_ref() {
            unsafe {
                if self.surface != vk::SurfaceKHR::null() {
                    self.surface_api()
                        .destroy_surface(self.surface, allocator());
                }
                instance.destroy_instance(allocator());
            }
        }
        self.instance = None;
        if self.layer_claimed {
            if sdk::release_layer(self.config.frame_rates.is_some()) != 0 {
                return Err(self.retain());
            }
            self.layer_claimed = false;
        }
        log("render: clean close");
        Ok(())
    }
}
