//! Renderer side of native decode: the decoder's surface memory, storage buffers over it and the
//! pipeline that samples decoded NV12 in place.

extern crate alloc;

use super::{Error, Renderer, allocator, sdk, shaders};
use crate::device::log;
use crate::{native_video::NativeVideo, sdk_backing};
use alloc::format;
use alloc::rc::Rc;
use ash::vk::{self, Handle};
use core::{cell::Cell, mem::ManuallyDrop, ptr::NonNull};
use moonlight_nx2_core::{
    codec::Size,
    decoder::{BackendError, RING},
    frame::{self, Layout, Matrix},
    untile,
};

#[derive(Clone, Copy)]
struct Binding {
    shift: u64,
    bytes: u64,
}

pub(crate) struct Shared {
    sets: [vk::DescriptorSet; RING],
    bindings: Cell<[Option<Binding>; RING]>,
}

impl Shared {
    fn set_binding(&self, surface: usize, binding: Option<Binding>) {
        let mut bindings = self.bindings.get();
        bindings[surface] = binding;
        self.bindings.set(bindings);
    }
}

#[derive(Clone, Copy)]
#[repr(C)]
struct Push {
    luma_offset: u32,
    luma_pitch: u32,
    luma_rows: u32,
    chroma_offset: u32,
    chroma_pitch: u32,
    chroma_rows: u32,
    stride: u32,
    slice_height: u32,
}

impl Push {
    fn new(binding: Binding, image: untile::Image, layout: &Layout) -> Option<Self> {
        let rows = layout.height.div_ceil(2);
        let (luma_offset, luma_pitch, luma_rows) =
            plane(binding, image.luma, layout.width, layout.height)?;
        let (chroma_offset, chroma_pitch, chroma_rows) =
            plane(binding, image.chroma, layout.chroma_bytes, rows)?;
        Some(Self {
            luma_offset,
            luma_pitch,
            luma_rows,
            chroma_offset,
            chroma_pitch,
            chroma_rows,
            stride: layout.stride,
            slice_height: layout.slice_height,
        })
    }

    fn bytes(&self) -> &[u8] {
        unsafe {
            core::slice::from_raw_parts((self as *const Self).cast(), core::mem::size_of::<Self>())
        }
    }
}

fn plane(binding: Binding, plane: untile::Plane, width: u32, rows: u32) -> Option<(u32, u32, u32)> {
    if plane.pitch < u64::from(width) {
        return None;
    }
    let (block_rows, extent) = match plane.kind {
        untile::Kind::Pitch => (
            0,
            plane
                .pitch
                .checked_mul(u64::from(rows - 1))?
                .checked_add(u64::from(width))?,
        ),
        untile::Kind::BlockLinear { rows: block } => (
            block,
            plane
                .pitch
                .checked_mul(u64::from(rows.div_ceil(block) * block))?,
        ),
    };
    let start = binding.shift.checked_add(plane.offset)?;
    let end = start.checked_add(extent)?;
    if end > binding.shift + binding.bytes || end > u64::from(u32::MAX) {
        return None;
    }
    Some((start as u32, u32::try_from(plane.pitch).ok()?, block_rows))
}

pub(crate) struct Presenter {
    set_layout: vk::DescriptorSetLayout,
    pool: vk::DescriptorPool,
    layout: vk::PipelineLayout,
    pipeline: vk::Pipeline,
    shared: Rc<Shared>,
    slots: [Option<(usize, Push)>; frame::VIDEO_SLOTS],
}

impl Presenter {
    pub(super) fn destroy(self, device: &ash::Device) {
        unsafe {
            device.destroy_pipeline(self.pipeline, allocator());
            device.destroy_pipeline_layout(self.layout, allocator());
            device.destroy_descriptor_pool(self.pool, allocator());
            device.destroy_descriptor_set_layout(self.set_layout, allocator());
        }
    }

    pub(super) fn forget_slot(&mut self, slot: usize) {
        self.slots[slot] = None;
    }
}

pub(crate) struct NativeOwner {
    device: ash::Device,
    memory_type: u32,
    map_alignment: u64,
    storage_range: u64,
    shared: Option<Rc<Shared>>,
    children: Rc<Cell<u32>>,
}

pub(crate) struct NativeMemory {
    device: ash::Device,
    memory: vk::DeviceMemory,
    buffer: vk::Buffer,
    surface: Option<(usize, Rc<Shared>)>,
    shift: u64,
    #[cfg(feature = "diagnostic-native-decode")]
    allocation_size: usize,
    #[cfg(feature = "diagnostic-native-decode")]
    allocation_alignment: usize,
    pointer: NonNull<u8>,
    bytes: usize,
    pub(crate) info: sdk_backing::Info,
    closed: bool,
}

impl Renderer {
    pub fn native_decoder(&mut self) -> Result<NativeVideo, Error> {
        self.active()?;
        if self.native_children.get() != 0 {
            return Err(Error::Busy);
        }
        let properties = unsafe {
            self.objects
                .instance()
                .get_physical_device_memory_properties(self.objects.physical)
        };
        let wanted = vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT;
        let memory_type = (0..properties.memory_type_count)
            .find(|index| {
                properties.memory_types[*index as usize]
                    .property_flags
                    .contains(wanted)
            })
            .ok_or(Error::Unsupported)?;
        if self.objects.native.is_none() {
            match self.objects.create_presenter() {
                Ok(presenter) => self.objects.native = Some(presenter),
                Err(error) => log_presenter(error),
            }
        }
        let limits = unsafe {
            self.objects
                .instance()
                .get_physical_device_properties(self.objects.physical)
        }
        .limits;
        self.native_children.set(1);
        Ok(NativeVideo::new(NativeOwner {
            device: self.objects.device().clone(),
            memory_type,
            map_alignment: limits.min_memory_map_alignment as u64,
            storage_range: u64::from(limits.max_storage_buffer_range),
            shared: self
                .objects
                .native
                .as_ref()
                .map(|presenter| presenter.shared.clone()),
            children: self.native_children.clone(),
        }))
    }

    pub fn upload_native(
        &mut self,
        surface: usize,
        image: untile::Image,
        display: Size,
        matrix: Matrix,
    ) -> Result<(), Error> {
        self.active()?;
        let presenter = self.objects.native.as_ref().ok_or(Error::Unsupported)?;
        let binding = presenter
            .shared
            .bindings
            .get()
            .get(surface)
            .copied()
            .flatten()
            .ok_or(Error::Unsupported)?;
        let layout = layout(display, matrix)?;
        let push = Push::new(binding, image, &layout).ok_or(Error::Invalid)?;

        let slot = self.acquire_slot()?;
        self.objects.sequence = self.objects.sequence.wrapping_add(1).max(1);
        let sequence = self.objects.sequence;
        layout.publish(self.objects.storage.bytes_mut(), slot, sequence)?;
        self.objects.current_slot = Some(slot);
        if let Some(presenter) = self.objects.native.as_mut() {
            presenter.slots[slot] = Some((surface, push));
        }
        Ok(())
    }

    pub fn native_busy(&mut self, surface: usize) -> Result<bool, Error> {
        self.active()?;
        self.objects.collect(0)?;
        let Some(presenter) = self.objects.native.as_ref() else {
            return Ok(false);
        };
        let busy = (0..frame::VIDEO_SLOTS).any(|slot| {
            let shows = presenter.slots[slot].is_some_and(|(shown, _)| shown == surface);
            let read =
                self.objects.current_slot == Some(slot) || self.objects.slot_readers[slot] != 0;
            shows && read
        });
        Ok(busy)
    }
}

fn log_presenter(error: Error) {
    log(&format!(
        "render: native presenter unavailable {error:?}; copy path"
    ));
}

fn layout(display: Size, matrix: Matrix) -> Result<Layout, Error> {
    let width = display.width();
    let height = display.height();
    let stride = width.checked_add(63).ok_or(Error::Invalid)? / 64 * 64;
    let slice_height = height.checked_add(1).ok_or(Error::Invalid)? / 2 * 2;
    let layout = Layout {
        width,
        height,
        stride,
        slice_height,
        chroma_rows: slice_height / 2,
        chroma_bytes: width.checked_add(1).ok_or(Error::Invalid)? / 2 * 2,
        color: u32::from(matrix == Matrix::Bt709),
    };
    if width == 0 || height == 0 || stride > 8192 || slice_height > 8192 {
        return Err(Error::Unsupported);
    }
    if layout.bytes() > frame::FRAME_BYTES {
        return Err(Error::Unsupported);
    }
    Ok(layout)
}

impl super::Objects {
    fn create_presenter(&mut self) -> Result<Presenter, Error> {
        let device = self.device().clone();
        let bindings = [vk::DescriptorSetLayoutBinding::default()
            .binding(0)
            .descriptor_type(vk::DescriptorType::STORAGE_BUFFER)
            .descriptor_count(1)
            .stage_flags(vk::ShaderStageFlags::FRAGMENT)];
        let set_layout = unsafe {
            device.create_descriptor_set_layout(
                &vk::DescriptorSetLayoutCreateInfo::default().bindings(&bindings),
                allocator(),
            )
        }?;
        let mut presenter = Presenter {
            set_layout,
            pool: vk::DescriptorPool::null(),
            layout: vk::PipelineLayout::null(),
            pipeline: vk::Pipeline::null(),
            shared: Rc::new(Shared {
                sets: [vk::DescriptorSet::null(); RING],
                bindings: Cell::new([None; RING]),
            }),
            slots: [None; frame::VIDEO_SLOTS],
        };
        match self.fill_presenter(&device, &mut presenter) {
            Ok(()) => Ok(presenter),
            Err(error) => {
                presenter.destroy(&device);
                Err(error)
            }
        }
    }

    fn fill_presenter(&self, device: &ash::Device, presenter: &mut Presenter) -> Result<(), Error> {
        let sizes = [vk::DescriptorPoolSize::default()
            .ty(vk::DescriptorType::STORAGE_BUFFER)
            .descriptor_count(RING as u32)];
        presenter.pool = unsafe {
            device.create_descriptor_pool(
                &vk::DescriptorPoolCreateInfo::default()
                    .max_sets(RING as u32)
                    .pool_sizes(&sizes),
                allocator(),
            )
        }?;
        let layouts = [presenter.set_layout; RING];
        let sets = unsafe {
            device.allocate_descriptor_sets(
                &vk::DescriptorSetAllocateInfo::default()
                    .descriptor_pool(presenter.pool)
                    .set_layouts(&layouts),
            )
        }?;
        let shared = Rc::get_mut(&mut presenter.shared).ok_or(Error::Invalid)?;
        shared.sets.copy_from_slice(&sets);

        let set_layouts = [self.set_layout, presenter.set_layout];
        let ranges = [vk::PushConstantRange::default()
            .stage_flags(vk::ShaderStageFlags::FRAGMENT)
            .size(core::mem::size_of::<Push>() as u32)];
        presenter.layout = unsafe {
            device.create_pipeline_layout(
                &vk::PipelineLayoutCreateInfo::default()
                    .set_layouts(&set_layouts)
                    .push_constant_ranges(&ranges),
                allocator(),
            )
        }?;

        let mut modules = [vk::ShaderModule::null(); 2];
        let result = (|| -> Result<vk::Pipeline, Error> {
            for (module, code) in modules
                .iter_mut()
                .zip([shaders::VIDEO_VERTEX, shaders::VIDEO_NATIVE])
            {
                *module = unsafe {
                    device.create_shader_module(
                        &vk::ShaderModuleCreateInfo::default().code(code),
                        allocator(),
                    )
                }?;
            }
            self.graphics_pipeline(
                modules[0],
                modules[1],
                false,
                presenter.layout,
                vk::PipelineCache::null(),
            )
        })();
        for module in modules {
            unsafe { device.destroy_shader_module(module, allocator()) };
        }
        presenter.pipeline = result?;
        Ok(())
    }

    pub(super) fn record_native(&self, command: vk::CommandBuffer, slot: usize) -> bool {
        let Some(presenter) = self.native.as_ref() else {
            return false;
        };
        let Some((surface, push)) = presenter.slots[slot] else {
            return false;
        };
        if presenter.shared.bindings.get()[surface].is_none() {
            return true;
        }
        unsafe {
            let device = self.device();
            device.cmd_bind_pipeline(command, vk::PipelineBindPoint::GRAPHICS, presenter.pipeline);
            device.cmd_bind_descriptor_sets(
                command,
                vk::PipelineBindPoint::GRAPHICS,
                presenter.layout,
                0,
                &[self.set, presenter.shared.sets[surface]],
                &[],
            );
            device.cmd_push_constants(
                command,
                presenter.layout,
                vk::ShaderStageFlags::FRAGMENT,
                0,
                push.bytes(),
            );
            device.cmd_draw(command, 3, 1, 0, slot as u32);
            device.cmd_bind_descriptor_sets(
                command,
                vk::PipelineBindPoint::GRAPHICS,
                self.pipeline_layout,
                0,
                &[self.set],
                &[],
            );
        }
        true
    }
}

impl NativeOwner {
    pub(crate) fn allocate(
        &self,
        bytes: usize,
        alignment: usize,
    ) -> Result<NativeMemory, BackendError> {
        self.allocate_at_least(bytes, alignment, 0)
    }

    fn allocate_at_least(
        &self,
        bytes: usize,
        alignment: usize,
        minimum: usize,
    ) -> Result<NativeMemory, BackendError> {
        if sdk::process_retired() || bytes == 0 || !alignment.is_power_of_two() {
            return Err(BackendError::Invalid);
        }
        let size = bytes
            .checked_add(alignment - 1)
            .ok_or(BackendError::Invalid)?
            .max(minimum);
        #[cfg(feature = "diagnostic-native-decode")]
        log(&format!("b2ar: before vkAllocateMemory bytes={size}"));
        let memory = match unsafe {
            self.device.allocate_memory(
                &vk::MemoryAllocateInfo::default()
                    .allocation_size(size as u64)
                    .memory_type_index(self.memory_type),
                allocator(),
            )
        } {
            Ok(memory) => memory,
            Err(
                error @ (vk::Result::ERROR_OUT_OF_HOST_MEMORY
                | vk::Result::ERROR_OUT_OF_DEVICE_MEMORY),
            ) => {
                log(&format!("renderer: vkAllocateMemory failed {error:?}"));
                return Err(BackendError::NoMemory);
            }
            Err(error) => {
                log(&format!("renderer: vkAllocateMemory uncertain {error:?}"));
                sdk::retire_process();
                return Err(BackendError::Uncertain);
            }
        };
        if sdk::process_retired() {
            return Err(BackendError::Uncertain);
        }
        #[cfg(feature = "diagnostic-native-decode")]
        log("b2ar: vkAllocateMemory passed; before vkMapMemory");
        let mapped = unsafe {
            self.device
                .map_memory(memory, 0, size as u64, vk::MemoryMapFlags::empty())
        };
        let mapped = match mapped {
            Ok(pointer) if !pointer.is_null() => pointer,
            error => {
                log(&format!("renderer: vkMapMemory failed {error:?}"));
                sdk::retire_process();
                return Err(BackendError::Uncertain);
            }
        };
        #[cfg(feature = "diagnostic-native-decode")]
        log("b2ar: vkMapMemory passed; before backing metadata query");
        let report = sdk_backing::query(memory.as_raw());
        #[cfg(feature = "diagnostic-native-decode")]
        log(&format!(
            "b2ar: backing metadata result={} lock={} metadata={}",
            report.result, report.lock_status, report.metadata_status
        ));
        let allocation = sdk_backing::Allocation {
            memory: memory.as_raw(),
            mapped: mapped as u64,
            bytes: size as u64,
            map_alignment: self.map_alignment,
            memory_type: self.memory_type,
        };
        if sdk_backing::compare(allocation, &report).is_err() || sdk::process_retired() {
            log("native backing metadata validation failed");
            sdk::retire_process();
            return Err(BackendError::Uncertain);
        }
        let shift = (mapped as usize).wrapping_neg() & (alignment - 1);
        let mut info = report.info;
        info.cpu_address = info
            .cpu_address
            .checked_add(shift as u64)
            .ok_or(BackendError::Invalid)?;
        info.gpu_address = info
            .gpu_address
            .checked_add(shift as u64)
            .ok_or(BackendError::Invalid)?;
        info.relative_offset = info
            .relative_offset
            .checked_add(shift as u64)
            .ok_or(BackendError::Invalid)?;
        if shift.checked_add(bytes).is_none_or(|end| end > size)
            || !info.gpu_address.is_multiple_of(alignment as u64)
        {
            sdk::retire_process();
            return Err(BackendError::Uncertain);
        }
        info.requested_size = bytes as u64;
        let Some(pointer) = NonNull::new(info.cpu_address as *mut u8) else {
            log("renderer: backing query returned a null CPU pointer");
            sdk::retire_process();
            return Err(BackendError::Uncertain);
        };
        Ok(NativeMemory {
            device: self.device.clone(),
            memory,
            buffer: vk::Buffer::null(),
            surface: None,
            shift: shift as u64,
            #[cfg(feature = "diagnostic-native-decode")]
            allocation_size: size,
            #[cfg(feature = "diagnostic-native-decode")]
            allocation_alignment: alignment,
            pointer,
            bytes,
            info,
            closed: false,
        })
    }

    pub(crate) fn allocate_surface(
        &self,
        surface: usize,
        bytes: usize,
        alignment: usize,
    ) -> Result<NativeMemory, BackendError> {
        let Some(shared) = self.shared.as_ref().filter(|_| surface < RING) else {
            return self.allocate(bytes, alignment);
        };
        let span = bytes
            .checked_add(alignment - 1)
            .ok_or(BackendError::Invalid)? as u64;
        if span > self.storage_range {
            log(&format!(
                "render: surface{surface} {span} bytes exceeds storage range; copy path"
            ));
            return self.allocate(bytes, alignment);
        }
        let buffer = match unsafe {
            self.device.create_buffer(
                &vk::BufferCreateInfo::default()
                    .size(span)
                    .usage(vk::BufferUsageFlags::STORAGE_BUFFER)
                    .sharing_mode(vk::SharingMode::EXCLUSIVE),
                allocator(),
            )
        } {
            Ok(buffer) => buffer,
            Err(_) => return self.allocate(bytes, alignment),
        };
        let requirements = unsafe { self.device.get_buffer_memory_requirements(buffer) };
        let required = usize::try_from(requirements.size).ok();
        let usable = requirements.memory_type_bits & (1 << self.memory_type) != 0;
        let Some(required) = required.filter(|_| usable) else {
            unsafe { self.device.destroy_buffer(buffer, allocator()) };
            return self.allocate(bytes, alignment);
        };
        let mut memory = match self.allocate_at_least(bytes, alignment, required) {
            Ok(memory) => memory,
            Err(error) => {
                unsafe { self.device.destroy_buffer(buffer, allocator()) };
                return Err(error);
            }
        };
        let bound = unsafe { self.device.bind_buffer_memory(buffer, memory.memory, 0) }.is_ok();
        if !bound {
            unsafe { self.device.destroy_buffer(buffer, allocator()) };
            return Ok(memory);
        }
        let buffers = [vk::DescriptorBufferInfo {
            buffer,
            offset: 0,
            range: vk::WHOLE_SIZE,
        }];
        let writes = [vk::WriteDescriptorSet::default()
            .dst_set(shared.sets[surface])
            .dst_binding(0)
            .descriptor_type(vk::DescriptorType::STORAGE_BUFFER)
            .buffer_info(&buffers)];
        unsafe { self.device.update_descriptor_sets(&writes, &[]) };
        shared.set_binding(
            surface,
            Some(Binding {
                shift: memory.shift,
                bytes: bytes as u64,
            }),
        );
        memory.buffer = buffer;
        memory.surface = Some((surface, shared.clone()));
        Ok(memory)
    }
}

impl Drop for NativeOwner {
    fn drop(&mut self) {
        if !sdk::process_retired() {
            if let Some(count) = self.children.get().checked_sub(1) {
                self.children.set(count);
            } else {
                log("renderer: native owner count underflow");
                sdk::retire_process();
            }
        }
    }
}

impl NativeMemory {
    #[cfg(feature = "diagnostic-native-decode")]
    pub(crate) fn diagnostic_allocation(&self) -> (usize, usize, usize, u64) {
        (
            self.bytes,
            self.allocation_size,
            self.allocation_alignment,
            self.shift,
        )
    }

    pub(crate) fn pointer(&self) -> *mut core::ffi::c_void {
        self.pointer.as_ptr().cast()
    }
    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }
    pub(crate) fn presentable(&self) -> bool {
        self.surface.is_some()
    }
    pub(crate) fn cpu_bytes(&self) -> &[u8] {
        unsafe { core::slice::from_raw_parts(self.pointer.as_ptr(), self.bytes) }
    }
    pub(crate) fn close(self) -> Result<(), BackendError> {
        let mut memory = ManuallyDrop::new(self);
        if sdk::process_retired() {
            return Err(BackendError::Uncertain);
        }
        if let Some((surface, shared)) = memory.surface.take() {
            shared.set_binding(surface, None);
            if unsafe { memory.device.device_wait_idle() }.is_err() {
                sdk::retire_process();
                return Err(BackendError::Uncertain);
            }
            unsafe { memory.device.destroy_buffer(memory.buffer, allocator()) };
            memory.buffer = vk::Buffer::null();
        }
        unsafe { memory.device.unmap_memory(memory.memory) };
        if sdk::process_retired() {
            return Err(BackendError::Uncertain);
        }
        unsafe { memory.device.free_memory(memory.memory, allocator()) };
        if sdk::process_retired() {
            return Err(BackendError::Uncertain);
        }
        memory.closed = true;
        unsafe { ManuallyDrop::drop(&mut memory) };
        Ok(())
    }
}

impl Drop for NativeMemory {
    fn drop(&mut self) {
        if !self.closed {
            sdk::retire_process();
        }
    }
}
