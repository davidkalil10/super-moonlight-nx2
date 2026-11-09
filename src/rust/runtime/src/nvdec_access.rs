extern crate alloc;

use crate::{device::log, sdk};
use alloc::format;
use core::sync::atomic::{AtomicBool, Ordering};
use moonlight_nx2_core::nv_access::{self, Backend, Device, Fault};

static TAKEN: AtomicBool = AtomicBool::new(false);

fn result(value: u32) -> Result<(), Fault> {
    if value == 0 {
        Ok(())
    } else if value & 0x1ff == 1 {
        Err(Fault::Uncertain(value))
    } else {
        Err(Fault::Refused(value))
    }
}

struct Sdk;

impl Backend for Sdk {
    fn initialize(&mut self) -> Result<(), Fault> {
        log("nvdec: before nvInitialize");
        let raw = unsafe { sdk::nvInitialize() };
        log(&format!("nvdec: nvInitialize result=0x{raw:x}"));
        result(raw)
    }

    fn open(&mut self, device: Device) -> Result<u32, Fault> {
        let path = match device {
            Device::Control => c"/dev/nvhost-ctrl",
            Device::Decoder => c"/dev/nvhost-nvdec",
        };
        log(&format!("nvdec: before open {device:?}"));
        let mut fd = u32::MAX;
        let raw = unsafe { sdk::nvOpen(&mut fd, path.as_ptr()) };
        log(&format!(
            "nvdec: open {device:?} result=0x{raw:x} fd_written={}",
            fd != u32::MAX
        ));
        result(raw)?;
        if fd == u32::MAX {
            Err(Fault::Uncertain(0))
        } else {
            Ok(fd)
        }
    }

    fn close(&mut self, fd: u32) -> Result<(), Fault> {
        log("nvdec: before close owned descriptor");
        let raw = unsafe { sdk::nvClose(fd) };
        log(&format!("nvdec: close result=0x{raw:x}"));
        result(raw)
    }

    fn exit(&mut self) -> Result<(), Fault> {
        log("nvdec: before nvExit");
        unsafe { sdk::nvExit() };
        log("nvdec: nvExit returned; SDK exposes no result");
        Ok(())
    }
}

pub fn nvdec_check() -> bool {
    if sdk::process_retired() || TAKEN.swap(true, Ordering::AcqRel) {
        log("nvdec: access diagnostic refused after prior use or retirement");
        return false;
    }
    log("nvdec: access only; no ioctl, mapping, submission or codec negotiation");
    let report = nv_access::probe(&mut Sdk);
    log(&format!("nvdec: report {report:?}"));
    if report.retired {
        sdk::retire_process();
    }
    log(if report.accessible() {
        "nvdec: access PASS; decoding unverified"
    } else {
        "nvdec: access NOT VERIFIED; decoding unverified"
    });
    report.accessible()
}
