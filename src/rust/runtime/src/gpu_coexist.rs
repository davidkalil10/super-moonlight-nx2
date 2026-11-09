use crate::{device::log, sdk};
use core::sync::atomic::{AtomicBool, Ordering};
use moonlight_nx2_core::coexist::{self, Backend, Error};

static ATTEMPTED: AtomicBool = AtomicBool::new(false);

struct Device {
    gpu: sdk::Gpu,
}

impl Backend for Device {
    fn root_ready(&self) -> bool {
        if sdk::process_retired() {
            return false;
        }
        let root = unsafe { sdk::gsvGetServiceSession() };
        !root.is_null() && unsafe { (*root).session != 0 }
    }

    fn open_gpu(&mut self) -> Result<(), Error> {
        let result = unsafe { sdk::gsvOpenGpu(&mut self.gpu) };
        log(&alloc::format!(
            "coexist: open main result=0x{result:x} main={} worker={}",
            self.gpu.main.session,
            self.gpu.worker.session
        ));
        if result != 0 {
            if self.gpu.main.session != 0 || self.gpu.worker.session != 0 {
                return Err(Error::Uncertain);
            }
            return Err(Error::Refused(result));
        }
        if self.gpu.main.session == 0 || self.gpu.worker.session != 0 {
            return Err(Error::Uncertain);
        }
        Ok(())
    }

    fn slots(&mut self) -> Result<(u32, u32), Error> {
        let (mut first, mut last) = (0, 0);
        let result = unsafe { sdk::gsvGpuGetSlotRange(&mut self.gpu, &mut first, &mut last) };
        log(&alloc::format!(
            "coexist: accepted slot bounds result=0x{result:x} first={first} last={last}; lease state unproven"
        ));
        if result != 0 {
            Err(Error::Refused(result))
        } else {
            Ok((first, last))
        }
    }

    fn register_client(&mut self, name: [u8; 8]) -> Result<u8, Error> {
        let mut client = 0xa5;
        let result = unsafe {
            sdk::gsvGpuRegisterClient(&mut self.gpu, u64::from_le_bytes(name), &mut client)
        };
        log(&alloc::format!(
            "coexist: register client result=0x{result:x} id={client}"
        ));
        if result != 0 {
            if client != 0xa5 {
                return Err(Error::Uncertain);
            }
            Err(Error::Refused(result))
        } else {
            Ok(client)
        }
    }

    fn release_client(&mut self, client: u8) -> Result<(), Error> {
        let result = unsafe { sdk::gsvGpuReleaseClient(&mut self.gpu, client) };
        log(&alloc::format!(
            "coexist: release client result=0x{result:x}"
        ));
        if result != 0 {
            Err(Error::Refused(result))
        } else {
            Ok(())
        }
    }

    fn close_gpu(&mut self) -> Result<(), Error> {
        unsafe { sdk::gsvGpuClose(&mut self.gpu) };
        log(&alloc::format!(
            "coexist: SDK main close returned(void) main={} worker={}",
            self.gpu.main.session,
            self.gpu.worker.session
        ));
        self.gpu = sdk::Gpu::default();
        Ok(())
    }
}

extern crate alloc;

pub(super) fn check() -> bool {
    if ATTEMPTED.swap(true, Ordering::AcqRel) {
        return false;
    }
    let mut device = Device {
        gpu: sdk::Gpu::default(),
    };
    log(&alloc::format!(
        "coexist: borrowed renderer root ready={} permitted_frame={:?}",
        device.root_ready(),
        sdk::permitted_frame_mode()
    ));
    log(
        "coexist: GPU main/client only; no worker, slot selection, VM, memory, image, decoder or job",
    );
    let report = coexist::inspect(&mut device);
    log(&alloc::format!("coexist: report {report:?}"));
    if report.retained {
        sdk::retire_process();
    }
    report.passed()
}
