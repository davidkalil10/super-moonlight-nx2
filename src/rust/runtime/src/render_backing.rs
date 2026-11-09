#[cfg(feature = "host-renderer")]
use super::test_support;
use super::{Error, Renderer, allocator, sdk};
use crate::sdk_backing::{ALLOCATION_BYTES, Allocation, Probe, Report, compare};
use ash::vk::{self, Handle};

impl Renderer {
    pub fn probe_backing(
        &mut self,
        query: &mut impl FnMut(Allocation) -> Report,
    ) -> Result<Probe, Error> {
        self.active()?;
        let device = self.objects.device().clone();
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
        let map_alignment = unsafe {
            self.objects
                .instance()
                .get_physical_device_properties(self.objects.physical)
        }
        .limits
        .min_memory_map_alignment as u64;
        let memory = unsafe {
            create!(
                device.allocate_memory(
                    &vk::MemoryAllocateInfo::default()
                        .allocation_size(ALLOCATION_BYTES)
                        .memory_type_index(memory_type),
                    allocator(),
                )
            )?
        };
        if sdk::process_retired() {
            return Err(self.objects.retain());
        }
        let mapped = (|| -> Result<_, Error> {
            #[cfg(feature = "host-renderer")]
            super::test_support::point()?;
            unsafe { device.map_memory(memory, 0, ALLOCATION_BYTES, vk::MemoryMapFlags::empty()) }
                .map_err(Error::from)
        })();
        let mapped = match mapped {
            Ok(pointer) => pointer,
            Err(error) => {
                if sdk::process_retired() {
                    return Err(self.objects.retain());
                }
                unsafe { device.free_memory(memory, allocator()) };
                return Err(error.into());
            }
        };
        let allocation = Allocation {
            memory: memory.as_raw(),
            mapped: mapped as u64,
            bytes: ALLOCATION_BYTES,
            map_alignment,
            memory_type,
        };
        let started = sdk::now_ns();
        let report = query(allocation);
        let query_ns = sdk::now_ns().checked_sub(started);
        if sdk::process_retired() || report.result == 3 {
            return Err(self.objects.retain());
        }
        let comparison = compare(allocation, &report);
        unsafe { device.unmap_memory(memory) };
        if sdk::process_retired() {
            return Err(self.objects.retain());
        }
        unsafe { device.free_memory(memory, allocator()) };
        if sdk::process_retired() {
            return Err(self.objects.retain());
        }
        Ok(Probe {
            allocation,
            report,
            comparison,
            query_ns,
        })
    }
}
