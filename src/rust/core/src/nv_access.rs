#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Device {
    Control,
    Decoder,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Fault {
    Refused(u32),
    Uncertain(u32),
}

pub trait Backend {
    fn initialize(&mut self) -> Result<(), Fault>;
    fn open(&mut self, device: Device) -> Result<u32, Fault>;
    fn close(&mut self, fd: u32) -> Result<(), Fault>;
    fn exit(&mut self) -> Result<(), Fault>;
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Stage {
    #[default]
    NotAttempted,
    Returned,
    Refused(u32),
    Uncertain(u32),
}

impl Stage {
    fn fault(fault: Fault) -> Self {
        match fault {
            Fault::Refused(code) => Self::Refused(code),
            Fault::Uncertain(code) => Self::Uncertain(code),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Access {
    pub open: Stage,
    pub close: Stage,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Report {
    pub initialize: Stage,
    pub control: Access,
    pub decoder: Access,
    pub exit: Stage,
    pub retired: bool,
}

impl Report {
    pub fn accessible(self) -> bool {
        !self.retired
            && self.initialize == Stage::Returned
            && self.exit == Stage::Returned
            && self.control.open == Stage::Returned
            && self.control.close == Stage::Returned
            && self.decoder.open == Stage::Returned
            && self.decoder.close == Stage::Returned
    }

    fn finish(&mut self, backend: &mut impl Backend) {
        match backend.exit() {
            Ok(()) => self.exit = Stage::Returned,
            Err(fault) => {
                self.exit = Stage::fault(fault);
                self.retired = true;
            }
        }
    }
}

/// Access only: no ioctl, allocation, mapping, submission, fence or codec negotiation.
/// Initialization failure and failed closes require process exit; uncertain calls never replay.
pub fn probe(backend: &mut impl Backend) -> Report {
    let mut report = Report::default();
    match backend.initialize() {
        Ok(()) => report.initialize = Stage::Returned,
        Err(fault) => {
            report.initialize = Stage::fault(fault);
            report.retired = true;
            return report;
        }
    }
    for device in [Device::Control, Device::Decoder] {
        let access = match device {
            Device::Control => &mut report.control,
            Device::Decoder => &mut report.decoder,
        };
        let fd = match backend.open(device) {
            Ok(u32::MAX) => {
                access.open = Stage::Uncertain(0);
                report.retired = true;
                return report;
            }
            Ok(fd) => {
                access.open = Stage::Returned;
                fd
            }
            Err(Fault::Refused(code)) => {
                access.open = Stage::Refused(code);
                report.finish(backend);
                return report;
            }
            Err(Fault::Uncertain(code)) => {
                access.open = Stage::Uncertain(code);
                report.retired = true;
                return report;
            }
        };
        match backend.close(fd) {
            Ok(()) => access.close = Stage::Returned,
            Err(fault) => {
                access.close = Stage::fault(fault);
                report.retired = true;
                return report;
            }
        }
    }
    report.finish(backend);
    report
}
