extern crate alloc;

use super::{Error, Renderer, allocator, sdk};
use crate::device::log;
use crate::{native_video::NativeVideo, sdk_backing};
use alloc::format;
use alloc::rc::Rc;
use ash::vk::{self, Handle};
use core::{cell::Cell, mem::ManuallyDrop, ptr::NonNull};
use moonlight_nx2_core::decoder::BackendError;

pub(crate) struct NativeOwner {
    device: ash::Device,
    memory_type: u32,
    map_alignment: u64,
    children: Rc<Cell<u32>>,
}

pub(crate) struct NativeMemory {
    device: ash::Device,
    memory: vk::DeviceMemory,
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
        self.native_children.set(1);
        Ok(NativeVideo::new(NativeOwner {
            device: self.objects.device().clone(),
            memory_type,
            map_alignment: unsafe {
                self.objects
                    .instance()
                    .get_physical_device_properties(self.objects.physical)
            }
            .limits
            .min_memory_map_alignment as u64,
            children: self.native_children.clone(),
        }))
    }
}

impl NativeOwner {
    pub(crate) fn allocate(
        &self,
        bytes: usize,
        alignment: usize,
    ) -> Result<NativeMemory, BackendError> {
        if sdk::process_retired() || bytes == 0 || !alignment.is_power_of_two() {
            return Err(BackendError::Invalid);
        }
        let size = bytes
            .checked_add(alignment - 1)
            .ok_or(BackendError::Invalid)?;
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
                log(&format!("b2ar: vkAllocateMemory failed {error:?}"));
                return Err(BackendError::NoMemory);
            }
            Err(error) => {
                log(&format!("b2ar: vkAllocateMemory uncertain {error:?}"));
                sdk::retire_process();
                return Err(BackendError::Uncertain);
            }
        };
        if sdk::process_retired() {
            return Err(BackendError::Uncertain);
        }
        log("b2ar: vkAllocateMemory passed; before vkMapMemory");
        let mapped = unsafe {
            self.device
                .map_memory(memory, 0, size as u64, vk::MemoryMapFlags::empty())
        };
        let mapped = match mapped {
            Ok(pointer) if !pointer.is_null() => pointer,
            error => {
                log(&format!("b2ar: vkMapMemory failed {error:?}"));
                sdk::retire_process();
                return Err(BackendError::Uncertain);
            }
        };
        log("b2ar: vkMapMemory passed; before backing metadata query");
        let report = sdk_backing::query(memory.as_raw());
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
            log("b2ar: backing query returned a null CPU pointer");
            sdk::retire_process();
            return Err(BackendError::Uncertain);
        };
        Ok(NativeMemory {
            device: self.device.clone(),
            memory,
            pointer,
            bytes,
            info,
            closed: false,
        })
    }
}

impl Drop for NativeOwner {
    fn drop(&mut self) {
        if !sdk::process_retired() {
            if let Some(count) = self.children.get().checked_sub(1) {
                self.children.set(count);
            } else {
                log("b2ar: native owner count underflow");
                sdk::retire_process();
            }
        }
    }
}

impl NativeMemory {
    pub(crate) fn pointer(&self) -> *mut core::ffi::c_void {
        self.pointer.as_ptr().cast()
    }
    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }
    pub(crate) fn cpu_bytes(&self) -> &[u8] {
        unsafe { core::slice::from_raw_parts(self.pointer.as_ptr(), self.bytes) }
    }
    pub(crate) fn close(self) -> Result<(), BackendError> {
        let mut memory = ManuallyDrop::new(self);
        if sdk::process_retired() {
            return Err(BackendError::Uncertain);
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
